// Crediting verified payments and settling to the landlord. Every step re-derives the money from Paystack's own records and the
// sealed recipient; nothing that can be edited in Firestore decides where money goes or how much.
import * as admin from "firebase-admin";
import axios from "axios";
import * as crypto from "crypto";
import { PAYSTACK_API_BASE } from "../desk/paystack";
import { alertOps } from "./alert";
import { LMM } from "./config";
import { chargeFor, keptMinor, planTransfers } from "./fees";
import { allocate, applyAllocation, openInvoices, type Allocation } from "./invoices";
import { paymentsCol, plansCol, resolveTarget, type PlanDoc } from "./plan";
import { getVerifiedRecipient } from "./recipient";
import { sameSeal, sealSettlement } from "./seal";
import { lmmText, sendOnce } from "./sms";
import { newMilestone } from "./reminders";
import { toMsisdn } from "../phone/safaricom";

export interface Secrets { paystack: string; seal: string }
const db = () => admin.firestore();
export const settlementsCol = () => db().collection("lmm_settlements");
const hdr = (s: Secrets) => ({ Authorization: `Bearer ${s.paystack}`, "Content-Type": "application/json" });
const FieldValue = admin.firestore.FieldValue;
class Hold extends Error {}

const eatDay = (now: number): string => new Date(now + 3 * 3_600_000).toISOString().slice(0, 10).replace(/-/g, "");

// ---------------------------------------------------------------------------------------------------- Paystack reads
export async function verifyCharge(s: Secrets, reference: string): Promise<{ ok: boolean; amount: number; fees: number }> {
  try {
    const res = await axios.get(`${PAYSTACK_API_BASE}/transaction/verify/${encodeURIComponent(reference)}`, { headers: hdr(s), timeout: 20_000 });
    const d = res.data?.data;
    const ok = res.data?.status === true && d?.status === "success" && d?.reference === reference && d?.currency === "KES";
    return { ok, amount: Number(d?.amount), fees: Number.isFinite(Number(d?.fees)) ? Number(d.fees) : 0 };
  } catch { return { ok: false, amount: NaN, fees: 0 }; }
}

// ---------------------------------------------------------------------------------------------------- 1. a payment arrives
export async function creditPayment(s: Secrets, reference: string, webhookAmount: number): Promise<"credited" | "ignored" | "rejected"> {
  const pref = paymentsCol().doc(reference);
  const snap = await pref.get();
  const p = snap.data();
  if (!p) { await alertOps("PLAN_MISMATCH", `charge ${reference} has no LMM record`); return "rejected"; }
  if (p.status === "credited") return "ignored";
  const v = await verifyCharge(s, reference);
  if (!v.ok) { await alertOps("PAYMENT_UNVERIFIED", `Paystack does not confirm ${reference}`); return "rejected"; }
  let expected = -1;
  try { expected = chargeFor(p.creditMinor).chargeMinor; } catch { /* tampered credit: falls through to the mismatch */ }
  if (v.amount !== p.chargeMinor || v.amount !== expected || (Number.isFinite(webhookAmount) && webhookAmount !== v.amount)) {
    await pref.update({ status: "rejected_amount", paidMinor: v.amount });
    await alertOps("AMOUNT_MISMATCH", `${reference} paid ${v.amount}, expected ${expected}/${p.chargeMinor}. Needs a manual refund.`);
    return "rejected";
  }
  const planRef = plansCol().doc(String(p.planId));
  const credited = await db().runTransaction(async (tx) => {
    const [ps, pl] = await Promise.all([tx.get(pref), tx.get(planRef)]);
    if (ps.data()?.status === "credited") return false;
    if (!pl.exists) throw new Hold("plan missing");
    tx.update(pref, { status: "credited", creditedAt: Date.now(), paystackFeeMinor: v.fees, keptMinor: keptMinor({ chargeMinor: v.amount, creditMinor: p.creditMinor }, v.fees), settled: false });
    tx.update(planRef, { creditedMinor: FieldValue.increment(p.creditMinor), lastPaymentAt: Date.now(), missedCount: 0 });
    return true;
  }).catch(async (e) => { if (e instanceof Hold) { await alertOps("PLAN_MISMATCH", `${reference}: ${e.message}`); return false; } throw e; });
  if (!credited) return "ignored";
  await afterCredit(s, String(p.planId));
  return "credited";
}

async function afterCredit(s: Secrets, planId: string): Promise<void> {
  try {
    const pl = (await plansCol().doc(planId).get()).data() as PlanDoc;
    const { targetMinor } = await resolveTarget(pl.agentId, pl.tenantId, pl);
    const pct = targetMinor > 0 ? Math.min(100, Math.floor((pl.creditedMinor * 100) / targetMinor)) : 100;
    const m = newMilestone(pct, pl.milestonesSent ?? []);
    if (m !== null) {
      await plansCol().doc(planId).update({ milestonesSent: FieldValue.arrayUnion(...[25, 50, 75, 100].filter((x) => x <= m)), lastSmsAt: Date.now() });
      if (pl.tenantPhone) await sendOnce(`ms_${planId}_${pl.settleSeq}_${m}`, toMsisdn(pl.tenantPhone), lmmText.milestone({ name: pl.tenantName, pct: m, paidMinor: pl.creditedMinor, leftMinor: Math.max(0, targetMinor - pl.creditedMinor) }));
    }
    if (targetMinor > 0 && pl.creditedMinor >= targetMinor) await settlePlan(s, planId, "target");
  } catch (err) { await alertOps("UNEXPECTED", `afterCredit ${planId}: ${(err as Error)?.message}`); }
}

// ---------------------------------------------------------------------------------------------------- 2. settle a plan
export async function settlePlan(s: Secrets, planId: string, reason: "target" | "fifth"): Promise<string> {
  const planRef = plansCol().doc(planId);
  const plan = (await planRef.get()).data() as PlanDoc | undefined;
  if (!plan || plan.creditedMinor <= 0) return "nothing";
  if (plan.creditedMinor < LMM.MIN_SETTLEMENT_MINOR) return "below_minimum";

  const paySnap = await paymentsCol().where("planId", "==", planId).where("status", "==", "credited").where("settled", "==", false).get();
  const pays = paySnap.docs.map((d) => ({ ...(d.data() as { creditMinor: number; chargeMinor: number }), id: d.id }));
  const gross = pays.reduce((sum, p) => sum + Number(p.creditMinor), 0);
  if (pays.length === 0 || pays.length > 400) { await alertOps("PLAN_MISMATCH", `${planId}: ${pays.length} credited payments`); return "held"; }
  if (gross !== plan.creditedMinor) { await alertOps("PLAN_MISMATCH", `${planId}: payments total ${gross} but plan says ${plan.creditedMinor}`); return "held"; }
  if (gross > LMM.MAX_SETTLEMENT_MINOR) { await alertOps("OVER_CAP", `${planId}: ${gross} is above the automatic limit`); return "held"; }

  const rec = await getVerifiedRecipient(s, plan.agentId);
  if (!rec) return "held";
  let chunks;
  try { chunks = planTransfers(gross, rec.type); } catch (e) { await alertOps("AMOUNT_MISMATCH", `${planId}: ${(e as Error).message}`); return "held"; }

  // every payment must still be exactly what Paystack says it was
  const checks = await Promise.all(pays.map((p) => verifyCharge(s, p.id)));
  const bad = pays.findIndex((p, i) => !checks[i].ok || checks[i].amount !== p.chargeMinor || chargeFor(p.creditMinor).chargeMinor !== checks[i].amount);
  if (bad >= 0) { await alertOps("PAYMENT_UNVERIFIED", `${planId}: ${pays[bad].id} no longer matches Paystack`); return "held"; }

  const seq = plan.settleSeq + 1;
  const sid = `${planId}_${seq}`;
  const base = crypto.createHash("sha256").update(sid).digest("hex").slice(0, 16);
  const chunkDocs = chunks.map((c, i) => ({ i, grossMinor: c.grossMinor, feeMinor: c.feeMinor, sendMinor: c.sendMinor, attempt: 0, reference: `lmm-${base}-${i}-0`, status: "queued" }));
  const paymentRefs = pays.map((p) => p.id);
  const seal = sealSettlement(s.seal, { id: sid, planId, landlordId: plan.agentId, recipientCode: rec.recipientCode, grossMinor: gross, sendMinors: chunks.map((c) => c.sendMinor), paymentRefs });
  const dayRef = db().collection("lmm_counters").doc(`out_${eatDay(Date.now())}`);

  try {
    await db().runTransaction(async (tx) => {
      const [pl, day, ...ps] = await Promise.all([tx.get(planRef), tx.get(dayRef), ...paymentRefs.map((r) => tx.get(paymentsCol().doc(r)))]);
      const cur = pl.data() as PlanDoc;
      if (cur.settleSeq !== plan.settleSeq || cur.creditedMinor !== gross) throw new Hold("plan changed while settling");
      if (ps.some((x) => x.data()?.status !== "credited" || x.data()?.settled !== false)) throw new Hold("a payment changed while settling");
      const out = Number(day.data()?.outMinor ?? 0);
      if (out + gross > LMM.DAILY_OUTFLOW_CAP_MINOR) throw new Hold("daily outflow cap");
      tx.set(settlementsCol().doc(sid), {
        id: sid, planId, agentId: plan.agentId, tenantId: plan.tenantId, tenantName: plan.tenantName, grossMinor: gross, reason, recipientCode: rec.recipientCode,
        chunks: chunkDocs, refs: chunkDocs.map((c) => c.reference), paymentRefs, status: "locked", seal, createdAt: Date.now(),
      });
      for (const r of paymentRefs) tx.update(paymentsCol().doc(r), { settled: true, settlementId: sid });
      tx.update(planRef, { settleSeq: seq, creditedMinor: FieldValue.increment(-gross), inFlightMinor: FieldValue.increment(gross) });
      tx.set(dayRef, { outMinor: out + gross, updatedAt: Date.now() }, { merge: true });
    });
  } catch (e) {
    if (e instanceof Hold) { if (/cap/.test(e.message)) await alertOps("OVER_CAP", `${planId}: today's outflow cap reached`); else console.warn("LMM settle held:", e.message); return "held"; }
    throw e;
  }
  await sendSettlement(s, sid);
  return "started";
}

// ---------------------------------------------------------------------------------------------------- 3. send the transfers
export async function sendSettlement(s: Secrets, sid: string): Promise<void> {
  const ref = settlementsCol().doc(sid);
  const st = (await ref.get()).data();
  if (!st || st.status !== "locked") return;
  const want = sealSettlement(s.seal, { id: sid, planId: st.planId, landlordId: st.agentId, recipientCode: st.recipientCode, grossMinor: st.grossMinor, sendMinors: st.chunks.map((c: any) => c.sendMinor), paymentRefs: st.paymentRefs });
  if (!sameSeal(st.seal, want)) { await ref.update({ status: "blocked" }); await alertOps("SEAL_MISMATCH", `settlement ${sid} was altered`); return; }
  const rec = await getVerifiedRecipient(s, st.agentId);
  if (!rec || rec.recipientCode !== st.recipientCode) return;   // alert already raised; stays locked, retried by the sweep

  for (const c of st.chunks as any[]) {
    if (c.status === "success" || c.status === "sent") continue;
    try {
      const res = await axios.post(`${PAYSTACK_API_BASE}/transfer`, {
        source: "balance", amount: c.sendMinor, recipient: st.recipientCode, reference: c.reference, currency: "KES", reason: "Rent via Lipa Mos Mos",
      }, { headers: hdr(s), timeout: 30_000 });
      const status = String(res.data?.data?.status ?? "");
      if (status === "otp") { await alertOps("OTP_REQUIRED", `Paystack wants an OTP for ${sid}. Turn off transfer confirmation in Paystack settings.`); return; }
      if (status === "failed" || status === "reversed") { await setChunk(ref, c.i, { status: "queued", attempt: c.attempt + 1, reference: nextRef(sid, c) }, true); await alertOps("TRANSFER_FAILED", `${sid} part ${c.i} ${status}`); return; }
      await setChunk(ref, c.i, { status: status === "success" ? "success" : "sent", transferCode: String(res.data?.data?.transfer_code ?? ""), sentAt: Date.now() });
    } catch (err) {
      const msg = String((err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? (err as Error)?.message ?? "");
      if (/balance/i.test(msg)) { await alertOps("LOW_BALANCE", `not enough Paystack balance for ${sid} (${c.sendMinor / 100})`); return; }
      if (/duplicate/i.test(msg)) { await setChunk(ref, c.i, { status: "sent" }); continue; }   // the first attempt did go through; the webhook or sweep confirms it
      await alertOps("TRANSFER_FAILED", `${sid} part ${c.i}: ${msg.slice(0, 80)}`);
      if (c.attempt >= 2) await ref.update({ status: "failed" });
      else await setChunk(ref, c.i, { attempt: c.attempt + 1, reference: nextRef(sid, c) }, true);
      return;
    }
  }
  await finalizeIfDone(s, sid);
}

const nextRef = (sid: string, c: { i: number; attempt: number }): string =>
  `lmm-${crypto.createHash("sha256").update(sid).digest("hex").slice(0, 16)}-${c.i}-${c.attempt + 1}`;

async function setChunk(ref: admin.firestore.DocumentReference, index: number, patch: Record<string, unknown>, newRef = false): Promise<void> {
  await db().runTransaction(async (tx) => {
    const d = (await tx.get(ref)).data();
    if (!d) return;
    const chunks = (d.chunks as any[]).map((c) => (c.i === index ? { ...c, ...patch } : c));
    tx.update(ref, { chunks, ...(newRef ? { refs: FieldValue.arrayUnion(String(patch.reference)) } : {}) });
  });
}

// ---------------------------------------------------------------------------------------------------- 4. confirmations
export async function onTransferEvent(s: Secrets, event: string, d: any): Promise<void> {
  const reference = String(d?.reference ?? "");
  if (!reference.startsWith("lmm-")) return;
  const q = await settlementsCol().where("refs", "array-contains", reference).limit(1).get();
  if (q.empty) { await alertOps("PLAN_MISMATCH", `transfer ${reference} matches no settlement`); return; }
  const ref = q.docs[0].ref; const st = q.docs[0].data();
  const chunk = (st.chunks as any[]).find((c) => c.reference === reference);
  if (!chunk) return;
  if (Number(d?.amount) !== chunk.sendMinor || (d?.recipient?.recipient_code && d.recipient.recipient_code !== st.recipientCode)) {
    await alertOps("AMOUNT_MISMATCH", `transfer ${reference}: amount or recipient differs from the settlement`); return;
  }
  if (event === "transfer.success") { if (chunk.status === "success") return; await setChunk(ref, chunk.i, { status: "success", confirmedAt: Date.now() }); await finalizeIfDone(s, st.id); return; }
  if (event === "transfer.failed" || event === "transfer.reversed") {
    await alertOps(event === "transfer.failed" ? "TRANSFER_FAILED" : "TRANSFER_REVERSED", `${st.id} part ${chunk.i}`);
    if (chunk.attempt >= 2) await ref.update({ status: "failed" });
    else await setChunk(ref, chunk.i, { status: "queued", attempt: chunk.attempt + 1, reference: nextRef(st.id, chunk) }, true);
  }
}

async function finalizeIfDone(s: Secrets, sid: string): Promise<void> {
  void s;
  const ref = settlementsCol().doc(sid);
  const moved = await db().runTransaction(async (tx) => {
    const st = (await tx.get(ref)).data();
    if (!st || st.status !== "locked" || !(st.chunks as any[]).every((c) => c.status === "success")) return null;
    const planRef = plansCol().doc(st.planId);
    tx.update(ref, { status: "paid_unapplied", paidAt: Date.now() });
    tx.update(planRef, { inFlightMinor: FieldValue.increment(-st.grossMinor), settledTotalMinor: FieldValue.increment(st.grossMinor), milestonesSent: [] });
    return st;
  });
  if (moved) await applySettlement(sid);
}

/** Matches the settled money to invoices (decided once, stored, then applied exactly once per invoice), then tells the tenant. */
export async function applySettlement(sid: string): Promise<void> {
  const ref = settlementsCol().doc(sid);
  let st = (await ref.get()).data();
  if (!st || (st.status !== "paid_unapplied")) return;
  try {
    let alloc: Allocation = st.allocation;
    if (!alloc) {
      alloc = allocate(await openInvoices(st.agentId, st.tenantId), st.grossMinor);
      await ref.update({ allocation: alloc });   // fixed here, so a re-run applies the same lines
    }
    await applyAllocation(st.agentId, st.tenantId, st.tenantName, sid, alloc);
    await db().runTransaction(async (tx) => {
      const cur = (await tx.get(ref)).data();
      if (!cur || cur.status !== "paid_unapplied") return;
      tx.update(ref, { status: "paid" });
      if (alloc.leftMinor > 0) tx.update(plansCol().doc(st!.planId), { unappliedMinor: FieldValue.increment(alloc.leftMinor) });
    });
    st = (await ref.get()).data();
    const pl = (await plansCol().doc(st!.planId).get()).data() as PlanDoc;
    // what is STILL owed on open invoices (not next month's rent, which is not due yet)
    const owed = (await openInvoices(pl.agentId, pl.tenantId)).reduce((sum, i) => sum + i.outstandingMinor, 0);
    if (pl.tenantPhone) await sendOnce(`paid_${sid}`, toMsisdn(pl.tenantPhone), lmmText.landlordPaid({ name: pl.tenantName, paidMinor: st!.grossMinor, leftMinor: Math.max(0, owed - pl.creditedMinor) }));
  } catch (err) { await alertOps("INVOICE_APPLY_FAILED", `${sid}: ${(err as Error)?.message}`); }
}

/** Sweep helper: ask Paystack about transfers that were sent but never confirmed by webhook. */
export async function reconcileSent(s: Secrets, sid: string): Promise<void> {
  const ref = settlementsCol().doc(sid);
  const st = (await ref.get()).data();
  if (!st || st.status !== "locked") return;
  for (const c of st.chunks as any[]) {
    if (c.status !== "sent") continue;
    try {
      const res = await axios.get(`${PAYSTACK_API_BASE}/transfer/verify/${encodeURIComponent(c.reference)}`, { headers: hdr(s), timeout: 20_000 });
      const d = res.data?.data;
      if (d?.status === "success" && Number(d.amount) === c.sendMinor) await setChunk(ref, c.i, { status: "success", confirmedAt: Date.now() });
      else if (d?.status === "failed" || d?.status === "reversed") await onTransferEvent(s, `transfer.${d.status}`, d);
    } catch { /* try again next sweep */ }
  }
  await finalizeIfDone(s, sid);
}
