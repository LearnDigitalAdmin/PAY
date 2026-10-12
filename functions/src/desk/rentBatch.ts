// Executes a desk-requested rent batch (desk_rent_batches/{id}, written as `requested` by desk's desk_initiateRentStk).
// One STK prompt per tenant, for the balance of the tenant's OLDEST unpaid invoice (a payment settles one invoice; the
// webhook marks that invoice paid by id, so charging more than one invoice's balance would over-collect).
// Every charge goes through the SAME extracted function processPayment uses (rentCharge.initiateRentCharge).
// Safety rules: the batch is claimed `requested -> processing` in a transaction (never runs twice); each tenant is claimed with a
// create-only attempt document BEFORE the Paystack call, so a retry or a crash can never send a second prompt to the same tenant.
import * as admin from "firebase-admin";
import { deskDb } from "./db";
import { writeDeskAudit } from "./events";
import { initiateRentCharge, type RentChargeInput, type RentChargeResult } from "./rentCharge";

export const RENT_BATCH_MAX_TENANTS = 200;
export const RENT_BATCH_CONCURRENCY = 5;
export const DESK_TOP_CODE = "COG-0000";
const COL = "desk_rent_batches";

export interface RentBatchResult { tenantId: string; reference?: string; status: "sent" | "failed"; error?: string }
interface BatchDoc {
  batchId: string; agentId: string; entityKey: string; tenantIds: string[]; status: string;
  results?: RentBatchResult[]; count?: number;
}
interface InvoiceRow { id: string; billingMonth: string; dueDate: string; balance: number }

export interface RentBatchDeps {
  db: () => admin.firestore.Firestore;
  charge: (input: RentChargeInput) => Promise<RentChargeResult>;
  now: () => number;
}
const realDeps: RentBatchDeps = { db: deskDb, charge: initiateRentCharge, now: () => Date.now() };

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const attemptId = (tenantId: string): string => tenantId.replace(/\//g, "_");
const errText = (e: unknown): string => {
  const m = String((e as { message?: unknown })?.message ?? e ?? "").trim();
  return (m || "The payment request could not be started").slice(0, 300);
};

/** The invoice a prompt should settle: unpaid, oldest due date first (ties by id). Pure. */
export function pickInvoice(rows: ReadonlyArray<{ id: string; data: Record<string, unknown> }>): InvoiceRow | null {
  const unpaid: InvoiceRow[] = [];
  for (const { id, data } of rows) {
    const balance = Math.round((Number(data.totalAmount) - Number(data.amountPaid ?? 0)) * 100) / 100;
    if (!Number.isFinite(balance) || balance <= 0 || data.isPaid === true || data.status === "paid") continue;
    unpaid.push({ id, billingMonth: text(data.billingMonth), dueDate: text(data.dueDate), balance });
  }
  unpaid.sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return unpaid[0] ?? null;
}

/** `pms:PYL-0007` -> `PYL-0007`. */
export function landlordCodeOf(entityKey: unknown): string | null {
  const m = /^pms:(PYL-\d{4,})$/.exec(typeof entityKey === "string" ? entityKey : "");
  return m ? m[1] : null;
}

async function claimBatch(deps: RentBatchDeps, batchId: string): Promise<BatchDoc | null> {
  const ref = deps.db().collection(COL).doc(batchId);
  return deps.db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const b = snap.data() as BatchDoc;
    if (b.status !== "requested") return null; // already running or finished: never run twice
    tx.update(ref, { status: "processing", updatedAt: deps.now() });
    return { ...b, batchId };
  });
}

async function finish(deps: RentBatchDeps, batchId: string, results: RentBatchResult[]): Promise<void> {
  const status = results.some((r) => r.status === "sent") ? "done" : "failed";
  await deps.db().collection(COL).doc(batchId).update({ status, results, updatedAt: deps.now() });
}

async function loadInvoices(deps: RentBatchDeps, uid: string, tenantId: string) {
  const col = deps.db().collection("users").doc(uid).collection("invoices");
  const seen = new Map<string, Record<string, unknown>>();
  const keys: Array<string | number> = Number.isInteger(Number(tenantId)) && tenantId.trim() !== "" ? [Number(tenantId), tenantId] : [tenantId];
  for (const k of keys) {
    const q = await col.where("tenantId", "==", k).get();
    for (const d of q.docs) seen.set(d.id, d.data() as Record<string, unknown>);
  }
  return [...seen.entries()].map(([id, data]) => ({ id, data }));
}

async function runTenant(deps: RentBatchDeps, b: BatchDoc, uid: string, tenantId: string): Promise<RentBatchResult> {
  const fail = (error: string): RentBatchResult => ({ tenantId, status: "failed", error });
  const attempt = deps.db().collection(COL).doc(b.batchId).collection("attempts").doc(attemptId(tenantId));
  try {
    const tenantSnap = await deps.db().collection("users").doc(uid).collection("tenants").doc(tenantId).get();
    if (!tenantSnap.exists) return fail("This tenant was not found on the landlord's account");
    const t = tenantSnap.data() as Record<string, unknown>;
    if (t.isActive === false) return fail("This tenant is no longer active");
    if (t.isRestricted === true) return fail("This tenant is restricted");
    if (t.propertyId !== undefined && t.propertyId !== null && String(t.propertyId) !== "") {
      const p = await deps.db().collection("users").doc(uid).collection("properties").doc(String(t.propertyId)).get();
      if (p.exists && (p.data() as Record<string, unknown>).isRestricted === true) return fail("This tenant's property is restricted");
    }
    const phone = text(t.phone);
    if (!phone) return fail("No phone number on file for this tenant");
    const invoice = pickInvoice(await loadInvoices(deps, uid, tenantId));
    if (!invoice) return fail("Nothing is due for this tenant");

    // Claim BEFORE calling Paystack. If it already exists, a previous run reached this tenant: never prompt twice.
    try {
      await attempt.create({ batchId: b.batchId, tenantId, invoiceId: invoice.id, claimedAt: deps.now() });
    } catch (e) {
      if ((e as { code?: unknown }).code !== 6) throw e;
      const prev = (await attempt.get()).data() as Partial<RentBatchResult> | undefined;
      if (prev?.status === "sent" || prev?.status === "failed") return { tenantId, status: prev.status, ...(prev.reference ? { reference: prev.reference } : {}), ...(prev.error ? { error: prev.error } : {}) };
      return fail("An earlier attempt was interrupted. Check with the tenant before sending another prompt");
    }

    let out: RentBatchResult;
    try {
      const r = await deps.charge({
        email: `tenant${tenantId}@plot.app`, amount: invoice.balance, currency: "KES", phone, provider: "mpesa",
        metadata: { userId: tenantId, userName: text(t.name) || "Tenant", invoiceId: invoice.id, billingMonth: invoice.billingMonth, arrears: 0, agentId: uid },
        desk: { agentId: b.agentId, batchId: b.batchId },
      });
      out = { tenantId, status: "sent", reference: r.reference };
    } catch (e) {
      out = fail(errText(e));
    }
    await attempt.update({ ...out, finishedAt: deps.now() });
    return out;
  } catch (e) {
    return fail(errText(e));
  }
}

export async function runRentBatch(batchId: string, deps: RentBatchDeps = realDeps): Promise<void> {
  const b = await claimBatch(deps, batchId);
  if (!b) return;
  const ids = Array.isArray(b.tenantIds) ? [...new Set(b.tenantIds.map((x) => String(x)))] : [];
  const failAll = async (reason: string) => {
    await writeDeskAudit({ action: "desk_rent_batch_refused", agentId: b.agentId, entityKey: b.entityKey, meta: { batchId, reason } });
    await finish(deps, batchId, ids.map((tenantId) => ({ tenantId, status: "failed" as const, error: reason })));
  };
  try {
    if (ids.length === 0 || ids.length > RENT_BATCH_MAX_TENANTS) return await failAll(`A batch must have 1-${RENT_BATCH_MAX_TENANTS} tenants`);

    const code = landlordCodeOf(b.entityKey);
    if (!code) return await failAll("Rent STK is only available for Plot Yangu landlords");
    const found = await deps.db().collection("users").where("landlordCode", "==", code).limit(2).get();
    if (found.docs.length !== 1) return await failAll(found.docs.length === 0 ? "No Plot Yangu landlord has that code" : "More than one landlord carries that code");
    const landlord = found.docs[0];
    const supportAgents = ((landlord.data() as Record<string, unknown>).supportAgents ?? {}) as Record<string, unknown>;

    const deskSnap = await deps.db().collection("desk_agents").doc(b.agentId).get();
    const desk = deskSnap.exists ? (deskSnap.data() as { status?: string; agentCode?: string }) : undefined;
    if (!desk || desk.status !== "active" || !desk.agentCode) return await failAll("This desk is not active");
    if (desk.agentCode !== DESK_TOP_CODE && !Object.prototype.hasOwnProperty.call(supportAgents, desk.agentCode)) {
      return await failAll("This desk is not one of the landlord's support agents");
    }

    const byTenant = new Map<string, RentBatchResult>();
    for (let i = 0; i < ids.length; i += RENT_BATCH_CONCURRENCY) {
      const chunk = ids.slice(i, i + RENT_BATCH_CONCURRENCY);
      const out = await Promise.all(chunk.map((tid) => runTenant(deps, b, landlord.id, tid)));
      out.forEach((r) => byTenant.set(r.tenantId, r));
    }
    const results = ids.map((tid) => byTenant.get(tid)!);
    await writeDeskAudit({
      action: "desk_rent_batch_ran", agentId: b.agentId, entityKey: b.entityKey,
      meta: { batchId, sent: results.filter((r) => r.status === "sent").length, failed: results.filter((r) => r.status === "failed").length },
    });
    await finish(deps, batchId, results);
  } catch (e) {
    console.error("desk rent batch crashed", batchId, errText(e));
    await finish(deps, batchId, ids.map((tenantId) => ({ tenantId, status: "failed" as const, error: "The batch stopped unexpectedly. Check the tenants' payment history before retrying" })));
  }
}
