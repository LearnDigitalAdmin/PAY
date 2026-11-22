// Two manual triggers on money that is already in the system: "pay my landlord now" and "withdraw to my own M-PESA".
// Nobody types an amount: the server takes everything available (rent paid in and not yet sent), never less than KES 50. Both go out within 24 hours
// through the SAME sealed transfer machinery as the normal landlord payout (settle.ts): the destination is the landlord account on record, or the
// tenant's own phone on record (OTP to that phone first). Credits are reserved inside one transaction, so nothing can be paid twice or overdrawn.
import { dearLine } from "../lmm/dear";
import { LMM_SEAL_KEY } from "../lmm/seal";
import { X } from "./config";
import { COL } from "./config";
import { LMMX, LMMX_BRAND, eatDate, fitSms, kes, lmmxText, maskName, maskPhone, shortDate, transferCostMinor, withdrawBreakdown, withdrawInstalmentCapMinor } from "./contract";
import type { PayoutRequestOut, WithdrawConfirmOut, WithdrawStartOut } from "./contract";
import { H, sha256 } from "./crypto";
import { fail } from "./errors";
import { audit, col, db, flags, FV, ledger, now, rateOk } from "./store";
import { issueOtp, verifyOtp } from "./otp";
import type { OtpVia } from "./otp";
import { cycleSeal, loadCycles, remainingOf, sealOk } from "./cycles";
import { ensureWalletRecipient } from "./recipients";
import { dayKey, freezeForTamper, refOf, sealOfSettlement, settleCycle } from "./settle";
import { activationSealOf, loadRecipient, nameOf, phoneOf, sms } from "./tenants";
import { paymentSeal } from "./payments";
import { normalizeKePhone } from "./contract";
import type { CycleDoc, PaymentDoc, PayRecordDoc, SettlementDoc, TenantDoc } from "./types";
import { safeEq } from "./crypto";

void LMM_SEAL_KEY;
const held = (c: CycleDoc): number => Math.max(0, c.creditedMinor - c.settledMinor - c.inflightMinor);
export type Eligibility = { ok: true } | { ok: false; kind: "state" | "tamper"; message: string };
/** The extra rules for WITHDRAWALS ONLY (paying the landlord is never limited by them). Pure: it gets the data and decides, so it can run inside the reservation transaction.
 *  1) the plan has been active for 2 weeks (when it became active is signed, and cross-checked with the sealed setup record);
 *  2) every instalment behind the balance is within the cap for the plan (KES 300 a day; weekly x7, biweekly x14; the stricter of the plan at payment time and the plan now).
 *  The signatures on the activation date and on each payment are checked, so editing them in the database is caught instead of trusted. */
export function withdrawEligibility(x: { tenant: TenantDoc; payRecord?: PayRecordDoc; payments: PaymentDoc[]; heldCycleIds: ReadonlySet<string>; nowMs: number }): Eligibility {
  const t = x.tenant;
  if (t.status !== "active") return { ok: false, kind: "state", message: "Withdrawals are only for an active plan." };
  if (typeof t.consentAt !== "number") return { ok: false, kind: "tamper", message: "activation date missing" };
  if (t.activeSeal && !safeEq(t.activeSeal, activationSealOf(t.tenantId, t.consentAt))) return { ok: false, kind: "tamper", message: "activation date does not match its seal" };
  const recAt = x.payRecord?.setupCompletedAt;
  if (typeof recAt !== "number" || Math.abs(recAt - t.consentAt) > 10 * 60_000) return { ok: false, kind: "tamper", message: "activation date does not match the setup record" };
  const opensAt = Math.max(t.consentAt, recAt) + LMMX.WITHDRAW_MIN_ACTIVE_MS;
  if (x.nowMs < opensAt) return { ok: false, kind: "state", message: `Withdrawals open after your plan has been active for 2 weeks, from ${shortDate(eatDate(opensAt))}. You can still use Pay my landlord now.` };
  for (const p of x.payments) {
    if (p.status !== "credited" || !x.heldCycleIds.has(p.cycleId)) continue;
    if (p.paySeal && !safeEq(p.paySeal, paymentSeal({ reference: p.reference, tenantId: p.tenantId, cycleId: p.cycleId, creditMinor: p.creditMinor, creditedAt: p.creditedAt ?? 0, freq: p.freq ?? t.frequency }))) return { ok: false, kind: "tamper", message: `payment ${p.reference} does not match its seal` };
    const cap = Math.min(withdrawInstalmentCapMinor((p.freq as TenantDoc["frequency"] | undefined) ?? t.frequency), withdrawInstalmentCapMinor(t.frequency));
    if (p.creditMinor > cap) return { ok: false, kind: "state", message: `One of your payments (${kes(p.creditMinor)}) is more than the withdrawal limit for your plan (${kes(cap)} at a time). You can still use Pay my landlord now.` };
  }
  return { ok: true };
}
/** When withdrawals open for this tenant (2 weeks after the plan became active). */
export const withdrawOpensAt = (t: Pick<TenantDoc, "consentAt">): number | undefined => (typeof t.consentAt === "number" ? t.consentAt + LMMX.WITHDRAW_MIN_ACTIVE_MS : undefined);

export async function balanceOf(tenantId: string): Promise<{ cycles: CycleDoc[]; availableMinor: number; tampered: boolean }> {
  const cycles = await loadCycles(tenantId);
  return { cycles, availableMinor: cycles.reduce((n, c) => n + held(c), 0), tampered: cycles.some((c) => !sealOk(c)) };
}
export async function summaryBalance(t: TenantDoc): Promise<{ availableMinor: number; withdrawFeeMinor: number; payoutPending: boolean; withdrawEligibleAt?: number }> {
  const { cycles, availableMinor } = await balanceOf(t.tenantId);
  const wd = await col(COL.settlements).where("tenantId", "==", t.tenantId).where("reason", "==", "withdraw").where("status", "==", "locked").limit(1).get();
  const opens = withdrawOpensAt(t);
  return { availableMinor, withdrawFeeMinor: availableMinor >= LMMX.MIN_PAYOUT_MINOR ? withdrawBreakdown(availableMinor).feeMinor : 0, payoutPending: !wd.empty || cycles.some((c) => c.payoutRequested), ...(opens ? { withdrawEligibleAt: opens } : {}) };
}
const tooLittle = (have: number): never => fail("LMMX_E_AMOUNT", `You need at least ${kes(LMMX.MIN_PAYOUT_MINOR)} paid in to do this. You have ${kes(have)}.`);
const ops = (key: string, text: string) => sms(key, X.ALERT_MOBILE, fitSms(text));

// ------------------------------------------------------------------------------------------------------------- pay my landlord now
export async function requestLandlordPayout(t: TenantDoc, via: "tenant" | "bot"): Promise<PayoutRequestOut> {
  if (t.frozen) return fail("LMMX_E_FROZEN", "Your account is on hold. Please contact support.");
  if ((await flags()).payoutsPaused) return fail("LMMX_E_DISABLED", "Payouts are paused for a short while. Please try again later.");
  if (!(await rateOk(`pay|${t.tenantId}`, LMMX.PAYOUT_REQUESTS_PER_DAY, 86_400_000))) return fail("LMMX_E_RATE", "You have asked too many times today.");
  const b = await balanceOf(t.tenantId);
  if (b.tampered) { await freezeForTamper(t.tenantId, "cycle money numbers do not match their seal (pay-landlord request)"); return fail("LMMX_E_TAMPER", "We could not check your balance. Please contact Samuhia support."); }
  if (b.availableMinor < LMMX.MIN_PAYOUT_MINOR) return tooLittle(b.availableMinor);
  const rec = await loadRecipient(t.activeRecipientId);
  if (rec.status !== "verified") return fail("LMMX_E_FROZEN", "Your landlord's account is on hold. Please contact support.");
  const due = b.cycles.filter((c) => held(c) > 0);
  for (const c of due) await col(COL.cycles).doc(c.cycleId).update({ payoutRequested: true });
  await audit({ action: "payout_requested", actor: { type: via === "bot" ? "bot" : "tenant" }, tenantId: t.tenantId, summary: `pay landlord now: ${b.availableMinor / 100} requested via ${via}` });
  await ops(`lmmx_pay_req_${t.tenantId}_${now()}`, `LMMX payout request: tenant ${t.tenantId} ${maskName(nameOf(t))} asks to pay landlord ${kes(b.availableMinor)} now. Sends within 24h.`);
  let delayed = false;
  for (const c of due) { try { const r = await settleCycle(c.cycleId); if (r.startsWith("held:first_payout") || r === "held:paused") delayed = true; } catch (e) { console.error("LMMX immediate payout attempt failed", (e as Error).message); } }
  return { requestedMinor: b.availableMinor, message: delayed ? `Request received. ${kes(b.availableMinor)} will go to your landlord. This landlord account is new, so the first payout waits for a short safety check.` : `Request received. ${kes(b.availableMinor)} will be sent to your landlord within 24 hours.` };
}

// ------------------------------------------------------------------------------------------------------------- withdraw to my own M-PESA
const wdHash = (t: Pick<TenantDoc, "tenantId" | "phoneHash">): string => sha256(`wd|${t.tenantId}|${t.phoneHash}`);

/** Step 1: the number must be the phone on record; the code goes to that phone. */
export async function startWithdraw(t: TenantDoc, phoneInput: unknown, via: OtpVia): Promise<WithdrawStartOut> {
  if (t.frozen) return fail("LMMX_E_FROZEN", "Your account is on hold. Please contact support.");
  const phone = normalizeKePhone(phoneInput);
  if (!phone || H("phone", phone) !== t.phoneHash || phoneOf(t) !== phone) return fail("LMMX_E_VALIDATION", "Withdrawals go only to the M-PESA number on your account.");
  if ((await flags()).payoutsPaused) return fail("LMMX_E_DISABLED", "Withdrawals are paused for a short while. Please try again later.");
  if (!(await rateOk(`wd|${t.tenantId}`, 10, 86_400_000))) return fail("LMMX_E_RATE", "You have asked too many times today.");
  const pend = await col(COL.settlements).where("tenantId", "==", t.tenantId).where("reason", "==", "withdraw").where("status", "==", "locked").limit(1).get();
  if (!pend.empty) return fail("LMMX_E_STATE", "A withdrawal is already on its way.");
  const b = await balanceOf(t.tenantId);
  if (b.tampered) { await freezeForTamper(t.tenantId, "cycle money numbers do not match their seal (withdraw start)"); return fail("LMMX_E_TAMPER", "We could not check your balance. Please contact Samuhia support."); }
  if (b.availableMinor < LMMX.MIN_PAYOUT_MINOR) return tooLittle(b.availableMinor);
  const held0 = new Set(b.cycles.filter((c) => held(c) > 0).map((c) => c.cycleId));
  const payRec = (await col(COL.payRecords).doc(t.tenantId).get()).data() as PayRecordDoc | undefined;
  const pays = (await col(COL.payments).where("tenantId", "==", t.tenantId).where("status", "==", "credited").get()).docs.map((d) => d.data() as PaymentDoc);
  const el = withdrawEligibility({ tenant: t, payRecord: payRec, payments: pays, heldCycleIds: held0, nowMs: now() });
  if (!el.ok) {
    if (el.kind === "tamper") { await freezeForTamper(t.tenantId, `withdraw eligibility: ${el.message}`); return fail("LMMX_E_TAMPER", "We could not check your account. Please contact Samuhia support."); }
    return fail("LMMX_E_STATE", el.message);
  }
  const bd = withdrawBreakdown(b.availableMinor), fee = bd.feeMinor, net = bd.netMinor;
  if (net < LMMX.MIN_CREDIT_MINOR) return tooLittle(b.availableMinor);
  const res = await issueOtp({ tenantId: t.tenantId, purpose: "withdraw", payloadHash: wdHash(t), phoneE164: phone, compose: (c4) => lmmxText.withdraw({ netMinor: net, phone: maskPhone(phone), supportPhone: X.SUPPORT_PHONE, code4: c4 }) });
  await audit({ action: "withdraw_started", actor: { type: via === "bot" ? "bot" : "tenant" }, tenantId: t.tenantId, summary: `withdraw code sent (available ${b.availableMinor / 100}) via ${via}` });
  return { availableMinor: b.availableMinor, serviceFeeMinor: bd.serviceFeeMinor, transferFeeMinor: bd.transferFeeMinor, feeMinor: fee, netMinor: net, otpExpiresAt: res.expiresAt };
}

/** Step 2: the right code reserves everything available, in one transaction, and queues one sealed transfer to the tenant's own wallet. */
export async function confirmWithdraw(t: TenantDoc, otp: string, via: OtpVia): Promise<WithdrawConfirmOut> {
  if (t.frozen) return fail("LMMX_E_FROZEN", "Your account is on hold. Please contact support.");
  if ((await flags()).payoutsPaused) return fail("LMMX_E_DISABLED", "Withdrawals are paused for a short while. Please try again later.");
  await verifyOtp({ tenantId: t.tenantId, purpose: "withdraw", input: otp, expectedPayloadHash: wdHash(t), via });
  const wallet = await ensureWalletRecipient({ tenantId: t.tenantId, name: nameOf(t), phoneE164: phoneOf(t), phoneHash: t.phoneHash, walletRecipientId: t.walletRecipientId });
  const res = await db().runTransaction(async (tx) => {
    const tref = col(COL.tenants).doc(t.tenantId);
    const tt = (await tx.get(tref)).data() as TenantDoc;
    if (tt.frozen) return fail("LMMX_E_FROZEN", "Your account is on hold. Please contact support.");
    if (tt.status !== "active" && tt.status !== "paused") return fail("LMMX_E_STATE", "This is not available right now.");
    const cs = (await tx.get(col(COL.cycles).where("tenantId", "==", t.tenantId).where("status", "in", ["open", "funded", "partial_settled"]))).docs;
    const cycles = cs.map((d) => ({ ref: d.ref, c: d.data() as CycleDoc }));
    if (cycles.some((x) => !sealOk(x.c))) return { tamper: true as const };
    const payRec = (await tx.get(col(COL.payRecords).doc(t.tenantId))).data() as PayRecordDoc | undefined;
    const pays = (await tx.get(col(COL.payments).where("tenantId", "==", t.tenantId).where("status", "==", "credited"))).docs.map((d) => d.data() as PaymentDoc);
    const open = await tx.get(col(COL.settlements).where("tenantId", "==", t.tenantId).where("reason", "==", "withdraw").where("status", "==", "locked"));
    if (!open.empty) return fail("LMMX_E_STATE", "A withdrawal is already on its way.");
    const dayRef = col(COL.counters).doc(`out_${dayKey()}`);
    const outToday = ((await tx.get(dayRef)).data()?.outMinor as number | undefined) ?? 0;   // the same daily outflow cap the landlord payouts use
    const allocations = cycles.filter((x) => held(x.c) > 0).map((x) => ({ cycleId: x.c.cycleId, amountMinor: held(x.c) }));
    const gross = allocations.reduce((n, a) => n + a.amountMinor, 0);
    if (gross < LMMX.MIN_PAYOUT_MINOR) return tooLittle(gross);
    const el = withdrawEligibility({ tenant: tt, payRecord: payRec, payments: pays, heldCycleIds: new Set(allocations.map((a) => a.cycleId)), nowMs: now() });
    if (!el.ok) { if (el.kind === "tamper") return { tamper: true as const }; return fail("LMMX_E_STATE", el.message); }
    const bd = withdrawBreakdown(gross), fee = bd.feeMinor, net = bd.netMinor;
    if (net < LMMX.MIN_CREDIT_MINOR) return tooLittle(gross);
    if (outToday + net > X.OUTFLOW_CAP_MINOR) return fail("LMMX_E_DISABLED", "Withdrawals are very busy today. Please try again tomorrow.");
    const seq = (tt.withdrawSeq ?? 0) + 1, id = `${t.tenantId}_W${seq}`, reference = refOf(id, 1);
    let cur = tt.cur;
    for (const x of cycles) {
      const a = allocations.find((y) => y.cycleId === x.c.cycleId); if (!a) continue;
      const next = { ...x.c, creditedMinor: x.c.creditedMinor - a.amountMinor, withdrawnMinor: (x.c.withdrawnMinor ?? 0) + a.amountMinor };
      tx.update(x.ref, { creditedMinor: next.creditedMinor, withdrawnMinor: next.withdrawnMinor, balSeal: cycleSeal(next), payoutRequested: false, ...(x.c.status === "funded" && next.creditedMinor < next.rentMinor ? { status: "open" } : {}) });
      if (!cur || cur.dueDate === x.c.dueDate) cur = { creditedMinor: next.creditedMinor, remainingMinor: remainingOf(next), dueDate: next.dueDate };
    }
    const base = { id, cycleId: `WD_${t.tenantId}`, recipientId: wallet.recipientId, recipientCode: wallet.recipientCode, amountMinor: net, reason: "withdraw" as const, grossMinor: gross, allocations };
    const st: SettlementDoc = { ...base, tenantId: t.tenantId, status: "locked", reference, attempt: 1, seal: sealOfSettlement(base), createdAt: now(), refs: [reference], transferCostMinor: transferCostMinor(net, "phone"), feeMinor: fee, notBefore: now() + LMMX.WITHDRAW_HOLD_MS };
    tx.create(col(COL.settlements).doc(id), JSON.parse(JSON.stringify(st)));
    tx.update(tref, { withdrawSeq: seq, ...(cur ? { cur } : {}), updatedAt: now() });
    tx.set(dayRef, { outMinor: FV.increment(net) }, { merge: true });
    ledger(tx, [{ tenantId: t.tenantId, cycleId: `WD_${t.tenantId}`, type: "withdraw_service", amountMinor: bd.serviceFeeMinor, direction: "in", ref: id }]);
    // for 72 hours after a withdrawal this phone and this ID cannot set up a new plan (see createTenant / setPlan)
    tx.set(col(COL.locks).doc(`wdcool_phone_${t.phoneHash.slice(0, 40)}`), { at: now(), tenantId: t.tenantId });
    tx.set(col(COL.locks).doc(`wdcool_id_${t.idHash.slice(0, 40)}`), { at: now(), tenantId: t.tenantId });
    return { id, gross, fee, net, service: bd.serviceFeeMinor, transfer: bd.transferFeeMinor };
  });
  if ("tamper" in res) { await freezeForTamper(t.tenantId, "cycle money numbers do not match their seal (withdraw confirm)"); return fail("LMMX_E_TAMPER", "We could not check your balance. Please contact Samuhia support."); }
  await audit({ action: "withdraw_requested", actor: { type: via === "bot" ? "bot" : "tenant" }, tenantId: t.tenantId, summary: `withdrawal ${res.id}: ${res.gross / 100} taken, ${res.net / 100} to be sent (fee ${res.fee / 100}) via ${via}` });
  await sms(`lmmx_wd_req_${res.id}`, phoneOf(t), fitSms(`${dearLine(nameOf(t))} we received your ${LMMX_BRAND} withdrawal: ${kes(res.net)} goes to your M-PESA within 24 hours (after the ${kes(res.service)} service fee and the ${kes(res.transfer)} M-PESA fee).`));
  await ops(`lmmx_wd_req_ops_${res.id}`, `LMMX WITHDRAWAL REQUEST ${kes(res.gross)} (send ${kes(res.net)}) tenant ${t.tenantId} ${maskName(nameOf(t))} ${maskPhone(phoneOf(t))} ref ${res.id}. Sends within 24h.`);
  return { requestedMinor: res.gross, serviceFeeMinor: res.service, transferFeeMinor: res.transfer, feeMinor: res.fee, netMinor: res.net, message: `Withdrawal requested. ${kes(res.net)} will be sent to your M-PESA within 24 hours (${kes(res.service)} service fee and ${kes(res.transfer)} M-PESA fee taken).` };
}
