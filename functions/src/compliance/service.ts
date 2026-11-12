// Orders for compliance reports. One state machine for every channel:
//   payment_required -> payment_pending -> paid -> generating -> ready        (state "paid" == entitled: paid, or a free allowance used)
// The PDF is only made, and a download link only given, for an order with entitled === true. The price is always decided here.
import * as admin from "firebase-admin";
import { randomHex } from "../landlordWatch/keys";
import { computeReport, isMonth } from "./calc";
import {
  FREE_REPORTS_PER_PROPERTY_PER_MONTH, LIST_LIMIT, ORDER_TTL_MS, PAY_COOLDOWN_MS, REPORT_KINDS, REPORT_LOCK_MS, REPORT_PRICE_KES, REPORT_PRICE_MINOR,
  REPORT_REUSE_MS, REPORT_TITLE, SIGNED_URL_TTL_MS, type ReportKind,
} from "./constants";
import { hashInput, loadInputFromFirestore, parseKind, parseMonth, sanitizeInput } from "./data";
import { CrError } from "./errors";
import { footerText, renderReportHtml } from "./html";
import { type Channel, isFreeTier, nairobiMonth, priceMinor } from "./pricing";
import { reportsCol, settleReportPayment } from "./payments";
import type { ReportInput } from "./types";

type Db = admin.firestore.Firestore;
export type OrderState = "payment_required" | "payment_pending" | "paid" | "generating" | "ready" | "failed" | "expired";

export interface PaystackPort {
  charge(payload: Record<string, unknown>): Promise<{ status: string; displayText: string | null }>;
  verify(reference: string): Promise<{ status: "success" | "failed" | "pending"; data: Record<string, unknown> } | null>;
}
export interface Deps {
  db: Db;
  now: () => Date;
  pdf: (html: string, footerText: string, pageLabel: string) => Promise<Buffer>;
  storage: { save(path: string, data: Buffer): Promise<void>; signedUrl(path: string, ttlMs: number): Promise<string> };
  paystack: PaystackPort;
  checkPhone: (raw: unknown) => { ok: true; e164: string } | { ok: false; message: string };
}
/** Who is asking, and whose records the report is about. Built by the API layer after it has checked access. */
export interface Principal { channel: Channel; actorKey: string; landlordUid: string; ownerId?: string }

const iso = (ms: unknown) => (typeof ms === "number" ? new Date(ms).toISOString() : null);
const quotaRef = (db: Db, uid: string, pid: string, period: string) => db.collection("complianceQuota").doc(`${uid}_${pid}_${period}`);

export async function tierOf(db: Db, uid: string): Promise<string> {
  const u = (await db.collection("users").doc(uid).get()).data();
  return String(u?.tier ?? "free").toLowerCase();
}
async function freeUsed(db: Db, uid: string, pid: string, period: string): Promise<number> {
  return Number((await quotaRef(db, uid, pid, period).get()).data()?.used ?? 0);
}
/** Atomically takes the property's free report for the month. false = already used. */
async function claimFree(db: Db, uid: string, pid: string, period: string): Promise<boolean> {
  const ref = quotaRef(db, uid, pid, period);
  return db.runTransaction(async (tx) => {
    const used = Number((await tx.get(ref)).data()?.used ?? 0);
    if (used >= FREE_REPORTS_PER_PROPERTY_PER_MONTH) return false;
    tx.set(ref, { used: used + 1, uid, propertyId: pid, period, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    return true;
  });
}
async function releaseFree(db: Db, uid: string, pid: string, period: string): Promise<void> {
  const ref = quotaRef(db, uid, pid, period);
  await db.runTransaction(async (tx) => {
    const used = Number((await tx.get(ref)).data()?.used ?? 0);
    if (used > 0) tx.set(ref, { used: used - 1, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  });
}

export interface OrderView {
  orderId: string; channel: string; propertyId: string; month: string; kind: ReportKind; title: string; state: OrderState; priceKes: number; entitled: boolean;
  createdAt: string | null; readyAt: string | null; error: { code: string; message: string } | null;
  message?: string; url?: string; urlExpiresAt?: string; fileName?: string; period?: string; freeIncluded?: boolean;
}
function present(d: Record<string, any>, extra: Partial<OrderView> = {}): OrderView {
  return {
    orderId: String(d.id), channel: d.channel, propertyId: d.propertyId, month: d.month, kind: d.kind, title: REPORT_TITLE[d.kind as ReportKind],
    state: d.state as OrderState, priceKes: Number(d.priceMinor) / 100, entitled: d.entitled === true, createdAt: iso(d.createdAt), readyAt: iso(d.readyAt),
    error: d.error ? { code: String(d.error.code), message: String(d.error.message) } : null, ...extra,
  };
}

// -------------------------------------------------------------------------------------------------------------------- quote
export async function quote(deps: Deps, pr: Principal, p: { propertyId: unknown }) {
  const propertyId = String(p.propertyId ?? "").trim();
  if (!propertyId) throw new CrError("CR_BAD_REQUEST", "Choose a property.");
  const period = nairobiMonth(deps.now());
  const tier = await tierOf(deps.db, pr.landlordUid);
  const used = await freeUsed(deps.db, pr.landlordUid, propertyId, period);
  const price = priceMinor({ channel: pr.channel, tier, freeUsed: used });
  return { propertyId, period, tier, freeIncluded: isFreeTier(tier), freeUsedThisMonth: used, priceKes: price / 100, listPriceKes: REPORT_PRICE_KES };
}

// -------------------------------------------------------------------------------------------------------------------- order
export async function createOrder(deps: Deps, pr: Principal, p: { propertyId: unknown; month: unknown; kind: unknown; input?: unknown }) {
  if (pr.channel === "desk" || pr.channel === "auto") throw new CrError("CR_NOT_ALLOWED", "Not available.");
  const now = deps.now();
  const kind = parseKind(p.kind), month = parseMonth(p.month, now);
  const propertyId = String(p.propertyId ?? "").trim();
  if (!propertyId) throw new CrError("CR_BAD_REQUEST", "Choose a property.");

  let input: ReportInput | undefined, dataHash: string | undefined;
  if (pr.channel === "pms") {                                   // the app sends the records it holds; they must be about this property
    input = sanitizeInput(p.input, kind, month);
    if (input.property.id !== propertyId) throw new CrError("CR_BAD_REQUEST", "The records do not match the chosen property.");
    dataHash = hashInput(input);
  } else {
    // Read it now, before anyone pays: a report can only be made from records that are synced to the account.
    await loadInputFromFirestore(deps.db, { userId: pr.landlordUid, propertyId }, kind, month);
  }
  const q = await quote(deps, pr, { propertyId });
  const id = randomHex(8);
  const doc: Record<string, unknown> = {
    id, channel: pr.channel, actorKey: pr.actorKey, uid: pr.landlordUid, ownerId: pr.ownerId ?? null, propertyId, month, kind,
    state: "payment_required", entitled: false, priceMinor: q.priceKes * 100, tier: q.tier, period: q.period, createdAt: now.getTime(),
    ...(input ? { input, dataHash } : {}),
  };
  await reportsCol(deps.db).doc(id).set(doc);
  return present(doc, { period: q.period, freeIncluded: q.freeIncluded });
}

async function ownedOrder(deps: Deps, pr: Principal, orderId: unknown): Promise<Record<string, any>> {
  const id = String(orderId ?? "");
  if (!/^[a-f0-9]{16}$/.test(id)) throw new CrError("CR_BAD_REQUEST", "Report not found.");
  const d = (await reportsCol(deps.db).doc(id).get()).data();
  if (!d || d.actorKey !== pr.actorKey || d.uid !== pr.landlordUid) throw new CrError("CR_NOT_FOUND", "Report not found.");
  return d;
}

// -------------------------------------------------------------------------------------------------------------------- checkout
/** The mandatory step. Free: uses the month's allowance. Paid: starts the KES 200 M-Pesa prompt. Either way nothing is made until it succeeds. */
export async function checkout(deps: Deps, pr: Principal, p: { orderId: unknown; phone?: unknown }) {
  const o = await ownedOrder(deps, pr, p.orderId);
  const now = deps.now().getTime();
  if (o.entitled === true) return present(o);
  if (o.state === "generating" || o.state === "ready") return present(o);
  if (now - Number(o.createdAt) > ORDER_TTL_MS && o.state !== "payment_pending") throw new CrError("CR_NOT_FOUND", "This order expired. Please start again.");

  const tier = await tierOf(deps.db, o.uid);
  const used = await freeUsed(deps.db, o.uid, o.propertyId, o.period);
  const price = priceMinor({ channel: o.channel, tier, freeUsed: used });
  const ref = reportsCol(deps.db).doc(o.id);

  if (price === 0) {
    const got = await claimFree(deps.db, o.uid, o.propertyId, o.period);
    if (got) {
      await ref.update({ state: "paid", entitled: true, priceMinor: 0, freeConsumed: true, paidAt: now, error: null });
      return present({ ...o, state: "paid", entitled: true, priceMinor: 0 });
    }
  }
  // The order showed KES 0, but the allowance has been used since (another order, the scheduler, or the landlord's own app).
  // Say so and let the customer decide; nothing is charged until they send a phone number.
  const hasPhone = p.phone !== undefined && p.phone !== null && String(p.phone).trim() !== "";
  if (Number(o.priceMinor) === 0 && !hasPhone) {
    await ref.update({ priceMinor: REPORT_PRICE_MINOR, error: null });
    return present({ ...o, state: "payment_required", priceMinor: REPORT_PRICE_MINOR, error: null }, { message: "This month's free report has been used. This one costs KES 200." });
  }
  // paid path
  const phone = deps.checkPhone(p.phone);
  if (!phone.ok) throw new CrError("CR_BAD_REQUEST", phone.message);
  if (o.state === "payment_pending" && now - Number(o.payStartedAt ?? 0) < PAY_COOLDOWN_MS) throw new CrError("CR_BAD_REQUEST", "A payment prompt was just sent. Check your phone, or wait a minute to try again.");
  const reference = `CRP_${o.id}_${now.toString(36)}`;
  await ref.update({ state: "payment_pending", priceMinor: REPORT_PRICE_MINOR, reference, payStartedAt: now, error: null });
  try {
    const res = await deps.paystack.charge({
      email: `report-${o.id}@samuhia.co.ke`, amount: REPORT_PRICE_MINOR, currency: "KES", reference, mobile_money: { phone: phone.e164, provider: "mpesa" },
      metadata: { chargeType: "compliance_report", orderId: o.id, kind: o.kind, month: o.month, channel: o.channel },
    });
    return present({ ...o, state: "payment_pending", priceMinor: REPORT_PRICE_MINOR }, { message: res.displayText ?? "Check your phone and enter your M-Pesa PIN." });
  } catch (e) {
    console.error("Compliance report charge failed:", e);
    await ref.update({ state: "payment_required", error: { code: "CR_PAYMENT_FAILED", message: "We could not start the M-Pesa payment. Please try again." } });
    throw new CrError("CR_PAYMENT_FAILED", "We could not start the M-Pesa payment. Please try again.");
  }
}

// -------------------------------------------------------------------------------------------------------------------- generate
async function inputFor(deps: Deps, o: Record<string, any>): Promise<ReportInput> {
  if (o.input) return o.input as ReportInput;
  return loadInputFromFirestore(deps.db, { userId: o.uid, propertyId: o.propertyId }, o.kind, o.month);
}

/** Makes the PDF for an entitled order. Locked so two callers never make it twice. Never called for an order that is not entitled. */
export async function generateOrder(deps: Deps, orderId: string, pdf: Deps["pdf"] = deps.pdf): Promise<Record<string, any>> {
  const ref = reportsCol(deps.db).doc(orderId);
  const now = deps.now().getTime();
  const claimed = await deps.db.runTransaction(async (tx) => {
    const d = (await tx.get(ref)).data();
    if (!d || d.entitled !== true) return null;                                          // the checkout gate
    if (d.state === "ready" || d.state === "expired") return d;
    if (d.state === "generating" && now - Number(d.lockedAt ?? 0) < REPORT_LOCK_MS) return d;
    tx.update(ref, { state: "generating", lockedAt: now, error: null });
    return { ...d, state: "claimed" };
  });
  if (!claimed) throw new CrError("CR_NOT_ALLOWED", "Payment is required before a report can be made.");
  if (claimed.state !== "claimed") return claimed;

  try {
    const input = await inputFor(deps, claimed);
    const computed = computeReport(input);
    const dataHash = claimed.dataHash ?? hashInput(input);
    const html = renderReportHtml(computed, { reportId: orderId, generatedAt: deps.now(), dataHash, source: claimed.channel });
    const bytes = await pdf(html, footerText(computed, orderId), "Page");
    const path = `compliance/${claimed.uid}/${claimed.propertyId}/${claimed.month}/${orderId}.pdf`;
    await deps.storage.save(path, bytes);
    const patch = { state: "ready", storagePath: path, readyAt: deps.now().getTime(), bytes: bytes.length, dataHash, summary: { grossRent: computed.grossRent, mriTax: computed.mri.tax, regime: computed.mri.regime }, error: null, input: admin.firestore.FieldValue.delete() };
    await ref.update(patch);
    return { ...claimed, ...patch, state: "ready" };
  } catch (e) {
    console.error(`Compliance report ${orderId} failed:`, e);
    const known = e instanceof CrError ? e : null;
    const error = { code: known?.code ?? "CR_UNAVAILABLE", message: known?.message ?? "We could not make the report. Please try again." };
    // a free report that failed gives its allowance back; the order stays entitled so a retry costs nothing
    await ref.update({ state: known?.code === "CR_NO_DATA" || known?.code === "CR_TOO_LARGE" ? "failed" : "paid", error });
    if (claimed.freeConsumed === true && (known?.code === "CR_NO_DATA" || known?.code === "CR_TOO_LARGE")) {
      await releaseFree(deps.db, claimed.uid, claimed.propertyId, claimed.period).catch(() => undefined);
      await ref.update({ entitled: false, freeConsumed: false, state: "payment_required" });
    }
    throw known ?? new CrError("CR_UNAVAILABLE", "We could not make the report. Please try again.");
  }
}

// -------------------------------------------------------------------------------------------------------------------- status
export async function status(deps: Deps, pr: Principal, p: { orderId: unknown }) {
  let o = await ownedOrder(deps, pr, p.orderId);
  const now = deps.now().getTime();

  if (o.state === "payment_pending" && o.reference) {                                    // webhook late? ask Paystack
    try {
      const v = await deps.paystack.verify(String(o.reference));
      if (v?.status === "success") await settleReportPayment(deps.db, String(o.reference), v.data, { orderId: o.id });
      else if (v?.status === "failed") await reportsCol(deps.db).doc(o.id).update({ state: "payment_required", error: { code: "CR_PAYMENT_FAILED", message: "The M-Pesa payment was not completed. You can try again." } });
    } catch (e) { console.error("Compliance report verify failed:", e); }
    o = (await reportsCol(deps.db).doc(o.id).get()).data() as Record<string, any>;
  }
  if (o.entitled === true && (o.state === "paid" || o.state === "generating")) o = await generateOrder(deps, String(o.id));
  if (o.state === "ready" && now - Number(o.readyAt) > REPORT_REUSE_MS) {
    await reportsCol(deps.db).doc(o.id).update({ state: "expired" });
    o = { ...o, state: "expired" };
  }
  if (o.state === "ready" && o.entitled === true && o.storagePath) {
    const url = await deps.storage.signedUrl(String(o.storagePath), SIGNED_URL_TTL_MS);
    return present(o, { url, urlExpiresAt: new Date(now + SIGNED_URL_TTL_MS).toISOString(), fileName: fileNameOf(o) });
  }
  return present(o);
}
export const fileNameOf = (o: Record<string, any>): string => `${o.kind === "annual_summary" ? "annual-rental-income" : "mri-working-paper"}-${o.month}-${String(o.id).slice(0, 6)}.pdf`;

// -------------------------------------------------------------------------------------------------------------------- list
export async function list(deps: Deps, pr: Principal, p: { propertyId?: unknown }) {
  let q: admin.firestore.Query = reportsCol(deps.db).where("actorKey", "==", pr.actorKey).where("uid", "==", pr.landlordUid);
  if (p.propertyId) q = q.where("propertyId", "==", String(p.propertyId));
  const snap = await q.get();
  const items = snap.docs.map((d) => d.data()).sort((a, b) => Number(b.createdAt) - Number(a.createdAt)).slice(0, LIST_LIMIT);
  return { items: items.map((d) => present(d)) };
}

// -------------------------------------------------------------------------------------------------------------------- desk (server to server)
/** Called by the desk delegate AFTER the desk ticket is paid. Idempotent per ticket. Never free. */
export async function createPaidDeskOrder(deps: Deps, p: { uid: string; propertyId: string; month: string; kind: unknown; ticketId: string; agentId: string }, linkTtlMs: number) {
  const kind = parseKind(p.kind), month = parseMonth(p.month, deps.now());
  if (!p.ticketId) throw new CrError("CR_BAD_REQUEST", "Missing ticket.");
  const { createHash } = await import("crypto");
  const id = createHash("sha256").update(`desk:${p.ticketId}`).digest("hex").slice(0, 16);
  const ref = reportsCol(deps.db).doc(id);
  await deps.db.runTransaction(async (tx) => {
    if ((await tx.get(ref)).exists) return;
    tx.set(ref, {
      id, channel: "desk", actorKey: `desk_${p.agentId}`, uid: p.uid, ownerId: null, propertyId: p.propertyId, month, kind, state: "paid", entitled: true,
      priceMinor: REPORT_PRICE_MINOR, tier: "n/a", period: nairobiMonth(deps.now()), createdAt: deps.now().getTime(), paidAt: deps.now().getTime(), desk: { ticketId: p.ticketId, agentId: p.agentId },
    });
  });
  const o = await generateOrder(deps, id);
  const url = await deps.storage.signedUrl(String(o.storagePath), linkTtlMs);
  return present(o, { url, urlExpiresAt: new Date(deps.now().getTime() + linkTtlMs).toISOString(), fileName: fileNameOf(o) });
}

/** Desk quote step: is there anything to report on? (Before the agent's customer pays.) */
export async function deskPreview(deps: Deps, p: { uid: string; propertyId?: unknown; month?: unknown; kind?: unknown }) {
  const props = await deps.db.collection("users").doc(p.uid).collection("properties").get();
  const properties = props.docs.map((d) => ({ id: d.id, name: String(d.data().name ?? "Property") }));
  if (!p.propertyId) return { properties, ready: false };
  const kind = parseKind(p.kind ?? REPORT_KINDS[0]);
  const month = isMonth(p.month) ? p.month : parseMonth(p.month, deps.now());
  const input = await loadInputFromFirestore(deps.db, { userId: p.uid, propertyId: String(p.propertyId) }, kind, month);   // throws CR_NO_DATA when nothing is synced
  const c = computeReport(input);
  return { properties, ready: true, property: input.property.name, tenants: input.tenants.filter((t) => t.active).length, grossRent: c.grossRent / 100 };
}
