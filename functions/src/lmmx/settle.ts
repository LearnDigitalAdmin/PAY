// Paying the landlord. UNCUT: the transfer is exactly the rent credited, never less. Paystack's transfer fee comes out of Samuhia's balance (recovered
// from the reserve). Mirrors legacy: pay in full when funded (and the money is in the balance), or on the due date whatever is in; later credits go as ONE top-up.
import axios from "axios";
import * as crypto from "crypto";
import { dearLine } from "../lmm/dear";
import { minSendableMinor } from "../lmm/fees";
import { LMM_SEAL_KEY, sameSeal, sealSettlement } from "../lmm/seal";
import { PAYSTACK_API_BASE, PAYSTACK_SECRET_KEY } from "../desk/paystack";
import { COL, X } from "./config";
import { LMMX, LMMX_BRAND, eatDate, fitSms, kes, nextDueDate, transferCostMinor, LMMX_TRANSFER_REF_PREFIX } from "./contract";
import { fail } from "./errors";
import { alert, audit, col, db, flags, FV, ledger, now } from "./store";
import { cycleSeal, sealOk } from "./cycles";
import { termsHashOf, termsSigOf, loadRecipient, nameOf, phoneOf, sms } from "./tenants";
import { contactOf, verifiedRecipientForPayout } from "./recipients";
import { firstName } from "../lmm/dear";
import type { CycleDoc, PayRecordDoc, SettlementDoc, TenantDoc } from "./types";

const hdr = () => ({ Authorization: `Bearer ${PAYSTACK_SECRET_KEY.value()}`, "Content-Type": "application/json" });
export const dayKey = (): string => eatDate(now()).replace(/-/g, "");
const prevDay = (iso: string): string => new Date(Date.parse(`${iso}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
export const refOf = (id: string, attempt: number): string => `${LMMX_TRANSFER_REF_PREFIX}${crypto.createHash("sha256").update(id).digest("hex").slice(0, 16)}-${attempt}`;
class Hold extends Error {}
/** One way to sign a settlement (a payout to a landlord, or a withdrawal to the tenant's own wallet): any edit to who, how much, or where it came from is caught before sending. */
export const sealOfSettlement = (st: Pick<SettlementDoc, "id" | "cycleId" | "recipientId" | "recipientCode" | "amountMinor" | "reason" | "grossMinor" | "allocations">): string =>
  st.reason === "withdraw"
    ? sealSettlement(LMM_SEAL_KEY.value(), { id: st.id, planId: st.cycleId, landlordId: st.recipientId, recipientCode: st.recipientCode, grossMinor: st.grossMinor ?? 0, sendMinors: [st.amountMinor], paymentRefs: (st.allocations ?? []).map((a) => `${a.cycleId}:${a.amountMinor}`) })
    : sealSettlement(LMM_SEAL_KEY.value(), { id: st.id, planId: st.cycleId, landlordId: st.recipientId, recipientCode: st.recipientCode, grossMinor: st.amountMinor, sendMinors: [st.amountMinor], paymentRefs: [] });
/** The money numbers of a tenant's cycle were changed outside the system: freeze, alert, audit. Nothing is paid until Samuhia support has looked. */
export async function freezeForTamper(tenantId: string, why: string): Promise<void> {
  await col(COL.tenants).doc(tenantId).update({ frozen: true, frozenReason: why.slice(0, 200), updatedAt: now() });
  await alert("SEAL_MISMATCH", `LMMX ${tenantId}: ${why}. Tenant frozen.`);
  await audit({ action: "tamper_detected", actor: { type: "system" }, tenantId, summary: why });
}

/** Decides whether this cycle can be paid out now and, if so, locks a settlement and sends it. Safe to call repeatedly. */
export async function settleCycle(cycleId: string): Promise<string> {
  if ((await flags()).payoutsPaused) return "held:paused";
  const c0 = (await col(COL.cycles).doc(cycleId).get()).data() as CycleDoc | undefined;
  if (!c0) return "none";
  const t = (await col(COL.tenants).doc(c0.tenantId).get()).data() as TenantDoc | undefined;
  if (!t) return "none";
  if (t.frozen) return "held:frozen";
  if (!sealOk(c0)) { await freezeForTamper(t.tenantId, `cycle ${cycleId} money numbers do not match their seal`); return "held:tamper"; }
  const payable0 = c0.creditedMinor - c0.settledMinor - c0.inflightMinor;
  if (payable0 <= 0) { if (c0.payoutRequested) await col(COL.cycles).doc(cycleId).update({ payoutRequested: false }); return "none"; }
  const today = eatDate(now());
  const full = c0.creditedMinor >= c0.rentMinor, dueReached = today >= c0.dueDate;
  const dayBeforeNext = prevDay(nextDueDate(c0.dueDate, t.dueDay, 1));
  let reason: SettlementDoc["reason"], eligible: boolean;
  if (full) { reason = c0.settledMinor === 0 ? "full" : "topup"; eligible = dueReached || (c0.lastAvailableOn ?? today) <= today; }
  else if (c0.settledMinor === 0) { reason = "due_date"; eligible = dueReached; }
  else { reason = "topup"; eligible = today >= dayBeforeNext; }
  if (c0.payoutRequested) eligible = true;   // the tenant asked for it now: every safety check below still applies
  if (!eligible) return "held:not_due";

  const rec = await loadRecipient(t.activeRecipientId);
  const allowedAt = Math.max((rec.verifiedAt ?? Number.MAX_SAFE_INTEGER) + LMMX.FIRST_PAYOUT_MIN_RECIPIENT_AGE_MS, (t.landlordNoticeAt ?? Number.MAX_SAFE_INTEGER) + LMMX.LANDLORD_NOTICE_MIN_BEFORE_PAYOUT_MS);
  if (now() < allowedAt) { if (dueReached) await alert("SETTLEMENT_STUCK", `LMMX payout for ${t.tenantId} is waiting for the first-payout safety window`); return "held:first_payout_window"; }
  if (payable0 < minSendableMinor(rec.paystackType)) return "held:below_min";

  const pr = (await col(COL.payRecords).doc(t.tenantId).get()).data() as PayRecordDoc | undefined;
  const th = termsHashOf(t, rec);
  if (!pr || pr.termsHash !== th || !sameSeal(pr.termsSig, termsSigOf(pr.termsHash)) || pr.recipientId !== rec.recipientId) {
    await col(COL.tenants).doc(t.tenantId).update({ frozen: true, frozenReason: "terms seal mismatch", updatedAt: now() });
    await alert("SEAL_MISMATCH", `LMMX payout terms for ${t.tenantId} do not match their seal. Tenant frozen.`);
    await audit({ action: "tamper_detected", actor: { type: "system" }, tenantId: t.tenantId, summary: "pay record seal mismatch at payout; tenant frozen" });
    return "held:tamper";
  }

  const dayRef = col(COL.counters).doc(`out_${dayKey()}`);
  let sid = "";
  try {
    await db().runTransaction(async (tx) => {
      const [cs, ds] = await Promise.all([tx.get(col(COL.cycles).doc(cycleId)), tx.get(dayRef)]);
      const c = cs.data() as CycleDoc;
      if (!sealOk(c)) throw new Hold("tamper");
      const amount = c.creditedMinor - c.settledMinor - c.inflightMinor;
      if (amount <= 0) throw new Hold("nothing to pay");
      const out = (ds.data()?.outMinor as number | undefined) ?? 0;
      if (out + amount > X.OUTFLOW_CAP_MINOR) throw new Hold("daily outflow cap");
      sid = `${cycleId}_${c.settlementCount + 1}`;
      const reference = refOf(sid, 1);
      const base = { id: sid, cycleId, recipientId: rec.recipientId, recipientCode: rec.recipientCode, amountMinor: amount, reason };
      const st: SettlementDoc = { ...base, tenantId: t.tenantId, status: "locked", reference, attempt: 1, seal: sealOfSettlement(base), createdAt: now(), refs: [reference], transferCostMinor: transferCostMinor(amount, rec.channel) };
      tx.create(col(COL.settlements).doc(sid), st);
      tx.update(col(COL.cycles).doc(cycleId), { inflightMinor: c.inflightMinor + amount, settlementCount: FV.increment(1), balSeal: cycleSeal({ ...c, inflightMinor: c.inflightMinor + amount }) });
      tx.set(dayRef, { outMinor: FV.increment(amount) }, { merge: true });
    });
  } catch (e) {
    if ((e as { code?: number }).code === 6) return "held:race";   // another worker queued the same payout a moment ago
    if (e instanceof Hold && e.message === "tamper") { await freezeForTamper(t.tenantId, `cycle ${cycleId} money numbers do not match their seal`); return "held:tamper"; }
    if (e instanceof Hold) { if (/cap/.test(e.message)) await alert("OVER_CAP", `LMMX ${cycleId}: today's outflow cap reached`); return `held:${e.message}`; }
    throw e;
  }
  await audit({ action: "settlement_started", actor: { type: "system" }, tenantId: t.tenantId, summary: `payout ${sid} queued (${reason})` });
  await sendSettlement(sid);
  return `queued:${sid}`;
}

export async function sendSettlement(sid: string): Promise<void> {
  const ref = col(COL.settlements).doc(sid);
  const st = (await ref.get()).data() as SettlementDoc | undefined;
  if (!st || st.status !== "locked") return;
  if (st.transferCode) return;                                                         // already handed to Paystack: the webhook or the reconcile confirms it, never a second send
  if (st.notBefore && now() < st.notBefore) return;                                    // a withdrawal's quiet hour
  if (st.reason === "withdraw") {
    if ((await flags()).payoutsPaused) return;                                         // payouts are paused: it waits, nothing is lost
    const owner = (await col(COL.tenants).doc(st.tenantId).get()).data() as TenantDoc | undefined;
    if (!owner || owner.frozen) return;                                                // support froze the account during the quiet hour: it waits for them
  }
  const want = sealOfSettlement(st);
  if (!sameSeal(st.seal, want)) { await ref.update({ status: "blocked" }); await alert("SEAL_MISMATCH", `LMMX settlement ${sid} was altered`); await audit({ action: "tamper_detected", actor: { type: "system" }, tenantId: st.tenantId, summary: `settlement ${sid} seal mismatch` }); return; }
  const rec = await verifiedRecipientForPayout(st.recipientId);
  if (!rec || rec.recipientCode !== st.recipientCode) return;   // alert already raised; stays locked and is retried
  try {
    const res = await axios.post(`${PAYSTACK_API_BASE}/transfer`, { source: "balance", amount: st.amountMinor, recipient: st.recipientCode, reference: st.reference, currency: "KES", reason: `Rent via ${LMMX_BRAND}` }, { headers: hdr(), timeout: 30_000 });
    const status = String(res.data?.data?.status ?? "");
    if (status === "otp") { await alert("OTP_REQUIRED", `Paystack wants an OTP for ${sid}. Turn off transfer confirmation in Paystack settings.`); return; }
    if (status === "failed" || status === "reversed") { await bumpAttempt(st, status); return; }
    await ref.update({ transferCode: String(res.data?.data?.transfer_code ?? "") });
    if (status === "success") await finalize(sid);
  } catch (err) {
    const msg = String((err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? (err as Error)?.message ?? "");
    if (/balance/i.test(msg)) { await alert("LOW_BALANCE", `LMMX not enough Paystack balance for ${sid} (${st.amountMinor / 100})`); return; }
    if (/duplicate/i.test(msg)) return;   // the first attempt did go through; the webhook or the sweep confirms it
    await alert("TRANSFER_FAILED", `LMMX ${sid}: ${msg.slice(0, 80)}`);
    await bumpAttempt(st, "error");
  }
}

async function bumpAttempt(st: SettlementDoc, why: string): Promise<void> {
  const ref = col(COL.settlements).doc(st.id);
  if (st.attempt >= 3) {
    await ref.update({ status: "failed" });
    await db().runTransaction(async (tx) => {
      if (st.reason === "withdraw") {
        // a withdrawal that could not be sent: the credit goes back to the cycles it came from, so the tenant keeps their money
        for (const a of st.allocations ?? []) {
          const cref = col(COL.cycles).doc(a.cycleId); const c = (await tx.get(cref)).data() as CycleDoc;
          const next = { ...c, creditedMinor: c.creditedMinor + a.amountMinor, withdrawnMinor: (c.withdrawnMinor ?? 0) - a.amountMinor };
          tx.update(cref, { creditedMinor: next.creditedMinor, withdrawnMinor: next.withdrawnMinor, balSeal: cycleSeal(next) });
        }
        return;
      }
      const cref = col(COL.cycles).doc(st.cycleId); const c = (await tx.get(cref)).data() as CycleDoc;
      tx.update(cref, { inflightMinor: c.inflightMinor - st.amountMinor, balSeal: cycleSeal({ ...c, inflightMinor: c.inflightMinor - st.amountMinor }) });
    });
    await alert("TRANSFER_FAILED", `LMMX ${st.id} failed 3 times (${why}); held`);
    await audit({ action: "settlement_failed", actor: { type: "system" }, tenantId: st.tenantId, summary: `${st.id} failed after 3 attempts` });
    return;
  }
  const reference = refOf(st.id, st.attempt + 1);
  await ref.update({ attempt: st.attempt + 1, reference, refs: FV.arrayUnion(reference) });
}

/** Paystack tells us a transfer reached a final state (webhook). Only references we created are looked at. */
export async function onTransferEvent(event: string, d: { reference?: unknown; amount?: unknown; recipient?: { recipient_code?: string } }): Promise<void> {
  const reference = String(d?.reference ?? "");
  if (!reference.startsWith(LMMX_TRANSFER_REF_PREFIX)) return;
  const q = await col(COL.settlements).where("refs", "array-contains", reference).limit(1).get();
  if (q.empty) { await alert("PLAN_MISMATCH", `LMMX transfer ${reference} matches no settlement`); return; }
  const st = q.docs[0].data() as SettlementDoc;
  if (Number(d?.amount) !== st.amountMinor || (d?.recipient?.recipient_code && d.recipient.recipient_code !== st.recipientCode)) { await alert("AMOUNT_MISMATCH", `LMMX transfer ${reference}: amount or recipient differs`); return; }
  if (st.status !== "locked") return;
  if (event === "transfer.success") { await finalize(st.id); return; }
  if (event === "transfer.failed" || event === "transfer.reversed") { await alert(event === "transfer.failed" ? "TRANSFER_FAILED" : "TRANSFER_REVERSED", `LMMX ${st.id}`); if (reference === st.reference) await bumpAttempt(st, event); }
}

/** Asks Paystack about transfers that were sent but never confirmed. */
export async function reconcileLocked(sid: string): Promise<void> {
  const st = (await col(COL.settlements).doc(sid).get()).data() as SettlementDoc | undefined;
  if (!st || st.status !== "locked" || !st.transferCode) return;
  try {
    const res = await axios.get(`${PAYSTACK_API_BASE}/transfer/verify/${encodeURIComponent(st.reference)}`, { headers: hdr(), timeout: 20_000 });
    const d = res.data?.data;
    if (d?.status === "success" && Number(d.amount) === st.amountMinor) await finalize(sid);
    else if (d?.status === "failed" || d?.status === "reversed") await onTransferEvent(`transfer.${d.status}`, { reference: st.reference, amount: st.amountMinor });
  } catch { /* next sweep */ }
}

async function finalizeWithdrawal(sid: string): Promise<void> {
  const done = await db().runTransaction(async (tx) => {
    const sref = col(COL.settlements).doc(sid);
    const st = (await tx.get(sref)).data() as SettlementDoc | undefined;
    if (!st || st.status !== "locked" || st.reason !== "withdraw") return null;
    tx.update(sref, { status: "paid", paidAt: now() });
    ledger(tx, [{ tenantId: st.tenantId, cycleId: st.cycleId, type: "withdraw", amountMinor: st.amountMinor, direction: "out", ref: sid }, { tenantId: st.tenantId, cycleId: st.cycleId, type: "payout_fee", amountMinor: st.transferCostMinor, direction: "out", ref: sid }]);
    return st;
  });
  if (!done) return;
  await audit({ action: "withdraw_paid", actor: { type: "system" }, tenantId: done.tenantId, summary: `withdrawal ${sid} paid ${done.amountMinor / 100}` });
  const t = (await col(COL.tenants).doc(done.tenantId).get()).data() as TenantDoc;
  await sms(`lmmx_wd_paid_${sid}`, phoneOf(t), fitSms(`${dearLine(nameOf(t))} ${kes(done.amountMinor)} was sent to your M-PESA ${LMMX_BRAND}. Check your phone.`));
  await sms(`lmmx_wd_paid_ops_${sid}`, X.ALERT_MOBILE, fitSms(`LMMX withdrawal SENT ${kes(done.amountMinor)} tenant ${done.tenantId} ref ${sid}`));
}

async function finalize(sid: string): Promise<void> {
  const first = (await col(COL.settlements).doc(sid).get()).data() as SettlementDoc | undefined;
  if (first?.reason === "withdraw") return finalizeWithdrawal(sid);
  const moved = await db().runTransaction(async (tx) => {
    const sref = col(COL.settlements).doc(sid);
    const st = (await tx.get(sref)).data() as SettlementDoc | undefined;
    if (!st || st.status !== "locked") return null;
    const cref = col(COL.cycles).doc(st.cycleId), tref = col(COL.tenants).doc(st.tenantId);
    const [cs, ts] = await Promise.all([tx.get(cref), tx.get(tref)]);
    const c = cs.data() as CycleDoc, t = ts.data() as TenantDoc;
    const settled = c.settledMinor + st.amountMinor;
    const done = settled >= c.rentMinor;
    tx.update(sref, { status: "paid", paidAt: now() });
    tx.update(cref, {
      inflightMinor: c.inflightMinor - st.amountMinor, settledMinor: settled, balSeal: cycleSeal({ ...c, inflightMinor: c.inflightMinor - st.amountMinor, settledMinor: settled }), ...(done ? { payoutRequested: false } : {}), status: done ? "settled" : "partial_settled",
      ...(done ? {} : { legRentMinor: c.rentMinor - settled, legReserveCollectedMinor: 0 }),
    });
    tx.update(tref, { cur: { creditedMinor: c.creditedMinor, remainingMinor: Math.max(0, c.rentMinor - c.creditedMinor), dueDate: c.dueDate }, updatedAt: now() });
    ledger(tx, [
      { tenantId: st.tenantId, cycleId: st.cycleId, type: "payout", amountMinor: st.amountMinor, direction: "out", ref: sid },
      { tenantId: st.tenantId, cycleId: st.cycleId, type: "payout_fee", amountMinor: st.transferCostMinor, direction: "out", ref: sid },
    ]);
    return { st, c, t, settled };
  });
  if (!moved) return;
  const { st, c, t, settled } = moved;
  await audit({ action: "settlement_paid", actor: { type: "system" }, tenantId: st.tenantId, summary: `payout ${sid} paid ${st.amountMinor / 100}` });
  const left = Math.max(0, c.rentMinor - settled);
  const rec = await loadRecipient(st.recipientId);
  const who = firstName(nameOf(t)) || "Your tenant";
  await sms(`lmmx_paid_l_${sid}`, contactOf(rec).phone, fitSms(`Samuhia: ${kes(st.amountMinor)} rent from ${who} was sent to you via ${LMMX_BRAND}.${left > 0 ? ` ${kes(left)} is still expected.` : ""}`));
  await sms(`lmmx_paid_t_${sid}`, phoneOf(t), fitSms(`${dearLine(nameOf(t))} your landlord was paid ${kes(st.amountMinor)} for rent via ${LMMX_BRAND}.${left > 0 ? ` Balance ${kes(left)} stays on your plan.` : " Thank you."}`));
}
void fail;
