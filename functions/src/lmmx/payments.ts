// Quote -> pay (M-PESA STK through Paystack /charge) -> credit (webhook, verified). The desk's share rides on a Paystack FLAT split; the rest waits in
// Samuhia's Paystack balance until the landlord is paid.
import axios from "axios";
import * as crypto from "crypto";
import { dearLine } from "../lmm/dear";
import { verifyCharge } from "../lmm/settle";
import { checkSafaricomPhone } from "../phone/safaricom";
import { PAYSTACK_API_BASE, PAYSTACK_SECRET_KEY } from "../desk/paystack";
import { getOrCreateFlatSplit } from "../desk/split";
import { COL, X } from "./config";
import { LMMX, LMMX_BRAND, LMMX_PAYMENT_REF_PREFIX, LMMX_TOP_DESK, eatDate, fitSms, isValidCredit, kes, quoteCoversCosts, quoteInstalment, shortDate } from "./contract";
import type { Quote, TenantQuoteOut } from "./contract";
import { H, readToken, sha256, signToken } from "./crypto";
import { fail } from "./errors";
import { alert, audit, col, db, FV, flags, ledger, now } from "./store";
import { addBusinessDays, holidays, remainingOf, targetCycle } from "./cycles";
import { loadRecipient, nameOf, normId, phoneOf, sms } from "./tenants";
import type { CycleDoc, PaymentDoc, RecipientDoc, TenantDoc } from "./types";
import { settleCycle } from "./settle";
import { payableBonus } from "./bonuses";

interface QuoteToken { tid: string; cyc: string; c: number; g: number; t: number; s: number; cc: number; lr: number; exp: number }

async function quoteState(t: TenantDoc, credit: number) {
  if (t.frozen) return fail("LMMX_E_FROZEN", "Your account is on hold. Please contact support.");
  if (t.status !== "active" || t.rentSource !== "lmm") return fail("LMMX_E_STATE", "Payments are not open for this account.");
  if (!(await flags()).enabled) return fail("LMMX_E_DISABLED", "Lipa Mdogo Mdogo is not switched on yet.");
  const r: RecipientDoc = await loadRecipient(t.activeRecipientId);
  if (r.status !== "verified") return fail("LMMX_E_FROZEN", "Payments are paused for this account. Please contact support.");
  const tc = await targetCycle(t);
  if (!tc) return fail("LMMX_E_STATE", "Your rent is fully covered for now. Your landlord will be paid.");
  const c = tc.cycle, remaining = remainingOf(c);
  if (!Number.isSafeInteger(credit) || credit % 100 !== 0) return fail("LMMX_E_AMOUNT", "Enter a whole-shilling amount.");
  if (credit > remaining) return fail("LMMX_E_AMOUNT", `That is more than you owe. The balance is ${kes(remaining)}.`);
  if (!isValidCredit(credit) && credit !== remaining) return fail("LMMX_E_AMOUNT", `The least you can pay is ${kes(LMMX.MIN_CREDIT_MINOR)} (the last bit of your rent can be less).`);
  const q = quoteInstalment({ creditMinor: credit, rentMinor: c.legRentMinor, channel: r.channel, reserveCollectedMinor: c.legReserveCollectedMinor, remainingRentMinor: remaining });
  if (!quoteCoversCosts(q)) { await alert("AMOUNT_MISMATCH", `LMMX quote does not cover costs for ${t.tenantId}`); return fail("LMMX_E_INTERNAL", "Could not price this payment."); }
  return { tc, q, r, remaining };
}

export async function makeQuote(t: TenantDoc, credit: number): Promise<TenantQuoteOut> {
  const { tc, q, remaining } = await quoteState(t, credit);
  const exp = now() + X.QUOTE_TTL_MS;
  const body: QuoteToken = { tid: t.tenantId, cyc: tc.cycle.cycleId, c: q.creditMinor, g: q.chargeMinor, t: q.transferReserveMinor, s: q.serviceFeeMinor, cc: tc.cycle.creditedMinor, lr: tc.cycle.legReserveCollectedMinor, exp };
  return {
    quoteId: signToken("quote", body as unknown as Record<string, unknown>), expiresAt: exp, creditMinor: q.creditMinor, transferReserveMinor: q.transferReserveMinor, serviceFeeMinor: q.serviceFeeMinor,
    collectionAllowanceMinor: q.collectionAllowanceMinor, chargeMinor: q.chargeMinor, feesMinor: q.feesMinor, payByDate: tc.cycle.payByDate, remainingAfterMinor: remaining - q.creditMinor,
  };
}

async function deskSubaccount(uid: string): Promise<string | null> {
  const a = (await col("agents").doc(uid).get()).data()?.paymentInfo as { accountId?: unknown } | undefined;
  return typeof a?.accountId === "string" && a.accountId.startsWith("ACCT_") ? a.accountId : null;
}

export async function startPayment(t: TenantDoc, quoteId: unknown, payerPhone: unknown): Promise<{ reference: string; displayText: string; chargeMinor: number }> {
  const tok = readToken<QuoteToken>("quote", quoteId);
  if (!tok || tok.tid !== t.tenantId || tok.exp < now()) return fail("LMMX_E_QUOTE", "That price expired. Please get a new one.");
  const phone = checkSafaricomPhone(payerPhone);
  if (!phone.ok) return fail("LMMX_E_VALIDATION", phone.message);
  const { tc, q, r } = await quoteState(t, tok.c);
  if (tc.cycle.cycleId !== tok.cyc || q.chargeMinor !== tok.g || q.transferReserveMinor !== tok.t || q.serviceFeeMinor !== tok.s || tc.cycle.creditedMinor !== tok.cc || tc.cycle.legReserveCollectedMinor !== tok.lr)
    return fail("LMMX_E_QUOTE", "Your balance changed. Please get a new price.");
  void r;
  const recent = await col(COL.payments).where("tenantId", "==", t.tenantId).where("createdAt", ">", now() - 86_400_000).get();
  if (recent.docs.some((d) => { const p = d.data() as PaymentDoc; return p.status === "initiating" || (p.status === "pending" && now() - p.createdAt < X.PENDING_PAY_MS); })) return fail("LMMX_E_STATE", "A payment prompt is already waiting on your phone. Please finish it or wait a few minutes.");
  if (recent.size >= X.PAY_ATTEMPTS_PER_DAY) return fail("LMMX_E_RATE", "Too many attempts today. Please try again tomorrow.");

  if (tc.isNew) { try { await col(COL.cycles).doc(tc.cycle.cycleId).create(tc.cycle); } catch (e) { if ((e as { code?: number }).code !== 6) throw e; } }
  // the desk's share: a flat Paystack split to its subaccount (COG-0000 earns nothing). No subaccount: the platform keeps it and we record that.
  let splitCode: string | undefined, deskShare = 0;
  if (t.deskCode !== LMMX_TOP_DESK && q.deskShareMinor > 0) {
    const sub = await deskSubaccount(t.deskUid);
    if (sub && q.deskShareMinor < q.chargeMinor) { splitCode = await getOrCreateFlatSplit([{ subaccount: sub, amountMinor: q.deskShareMinor }], "lmmx", q.chargeMinor); deskShare = q.deskShareMinor; }
    else await alert("UNEXPECTED", `LMMX desk ${t.deskCode} has no payout subaccount; share kept by platform`);
  }
  const reference = `${LMMX_PAYMENT_REF_PREFIX}${t.tenantId}_${now().toString(36)}${crypto.randomBytes(3).toString("hex")}`.slice(0, 60);
  const p: PaymentDoc = {
    reference, paymentId: reference, tenantId: t.tenantId, cycleId: tc.cycle.cycleId, quoteId: sha256(String(quoteId)).slice(0, 16), phone: phone.e164, status: "initiating", creditMinor: q.creditMinor, reserveMinor: q.transferReserveMinor,
    serviceMinor: q.serviceFeeMinor, chargeMinor: q.chargeMinor, feesMinor: q.feesMinor, deskShareMinor: deskShare, ...(deskShare ? { deskUid: t.deskUid, deskCode: t.deskCode, splitCode } : {}), createdAt: now(), payerHash: H("phone", phone.e164),
  };
  await col(COL.payments).doc(reference).create(JSON.parse(JSON.stringify(p)));
  try {
    const res = await axios.post(`${PAYSTACK_API_BASE}/charge`, {
      email: `tenant${t.tenantId}@samuhia.co.ke`, amount: q.chargeMinor, currency: "KES", mobile_money: { phone: phone.e164, provider: "mpesa" }, reference, ...(splitCode ? { split_code: splitCode } : {}),
      metadata: { lmmx: true, tenantId: t.tenantId, cycleId: tc.cycle.cycleId, creditMinor: q.creditMinor, chargeMinor: q.chargeMinor },
    }, { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY.value()}`, "Content-Type": "application/json" }, timeout: 30_000 });
    if (!res.data?.status) throw new Error(res.data?.message || "Paystack refused the charge");
    await col(COL.payments).doc(reference).update({ status: "pending" });
    return { reference, displayText: String(res.data.data?.display_text || "Check your phone for the M-PESA prompt"), chargeMinor: q.chargeMinor };
  } catch (err) {
    await col(COL.payments).doc(reference).update({ status: "failed" });
    const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || (err as Error)?.message || "";
    return fail("LMMX_E_INTERNAL", `The payment could not be started${msg ? `: ${String(msg).slice(0, 80)}` : "."}`);
  }
}

/** Called by the Paystack webhook (signature already verified) for charge.success with a reference starting LMX_. Credits exactly once. */
export async function creditPayment(reference: string, webhookAmount: number): Promise<"credited" | "ignored" | "rejected"> {
  const pref = col(COL.payments).doc(reference);
  const p = (await pref.get()).data() as PaymentDoc | undefined;
  if (!p) { await alert("PLAN_MISMATCH", `LMMX charge ${reference} has no record`); return "rejected"; }
  if (p.status === "credited") return "ignored";
  const v = await verifyCharge({ paystack: PAYSTACK_SECRET_KEY.value(), seal: "" }, reference);
  if (!v.ok) { await alert("PAYMENT_UNVERIFIED", `Paystack does not confirm ${reference}`); return "rejected"; }
  const covers = p.chargeMinor - Math.ceil((p.chargeMinor * LMMX.COLLECTION_BPS) / 10_000) >= p.creditMinor + p.reserveMinor + p.serviceMinor;
  if (v.amount !== p.chargeMinor || !covers || (Number.isFinite(webhookAmount) && webhookAmount !== v.amount)) {
    await pref.update({ status: "rejected" });
    await alert("AMOUNT_MISMATCH", `${reference} paid ${v.amount}, expected ${p.chargeMinor}. Needs a manual refund.`);
    await audit({ action: "payment_rejected", actor: { type: "system" }, tenantId: p.tenantId, summary: `amount mismatch on ${reference}` });
    return "rejected";
  }
  const hol = await holidays();
  const availableOn = addBusinessDays(eatDate(now()), X.AVAILABILITY_LAG_DAYS, hol);
  const state = await db().runTransaction(async (tx) => {
    const cref = col(COL.cycles).doc(p.cycleId), tref = col(COL.tenants).doc(p.tenantId);
    const [ps, cs, ts] = await Promise.all([tx.get(pref), tx.get(cref), tx.get(tref)]);
    if ((ps.data() as PaymentDoc).status === "credited") return null;
    const c = cs.data() as CycleDoc | undefined, t = ts.data() as TenantDoc | undefined;
    if (!c || !t) return fail("LMMX_E_STATE", "cycle or tenant missing");
    const credited = c.creditedMinor + p.creditMinor;
    const status = credited >= c.rentMinor ? (c.settledMinor === 0 && c.inflightMinor === 0 ? "funded" : c.status) : c.status;
    tx.update(pref, { status: "credited", creditedAt: now(), availableOn, paystackFeeMinor: v.fees });
    tx.update(cref, { creditedMinor: FV.increment(p.creditMinor), instalments: FV.increment(1), legReserveCollectedMinor: FV.increment(p.reserveMinor), lastCreditAt: now(), lastAvailableOn: availableOn, status, ...(c.firstCreditAt ? {} : { firstCreditAt: now() }) });
    const leftNow = Math.max(0, c.rentMinor - credited);
    tx.update(tref, { lastPaymentAt: now(), cur: { creditedMinor: credited, remainingMinor: leftNow, dueDate: c.dueDate } });
    ledger(tx, [
      { tenantId: p.tenantId, cycleId: p.cycleId, type: "collect", amountMinor: p.chargeMinor, direction: "in", ref: reference },
      { tenantId: p.tenantId, cycleId: p.cycleId, type: "collection_fee", amountMinor: v.fees, direction: "out", ref: reference },
      { tenantId: p.tenantId, cycleId: p.cycleId, type: "transfer_reserve", amountMinor: p.reserveMinor, direction: "in", ref: reference },
      { tenantId: p.tenantId, cycleId: p.cycleId, type: "service_desk", amountMinor: p.deskShareMinor, direction: "out", ref: reference },
      { tenantId: p.tenantId, cycleId: p.cycleId, type: "service_platform", amountMinor: p.serviceMinor - p.deskShareMinor, direction: "in", ref: reference },
    ]);
    if (p.deskShareMinor > 0) tx.set(col(COL.earnings).doc(reference), { deskCode: p.deskCode, deskUid: p.deskUid, tenantId: p.tenantId, deskShareMinor: p.deskShareMinor, createdAt: now(), month: eatDate(now()).slice(0, 7) });
    return { t, c, credited, instalments: c.instalments + 1 };
  });
  if (!state) return "ignored";
  await audit({ action: "payment_credited", actor: { type: "system" }, tenantId: p.tenantId, summary: `credited ${p.creditMinor / 100} (charge ${p.chargeMinor / 100}) ref ${reference.slice(-8)}` });
  const left = Math.max(0, state.c.rentMinor - state.credited);
  await sms(`lmmx_rcpt_${reference}`, phoneOf(state.t), fitSms(`${dearLine(nameOf(state.t))} we received ${kes(p.creditMinor)} towards your rent via ${LMMX_BRAND}. ${left > 0 ? `Balance ${kes(left)}. Pay by ${shortDate(state.c.payByDate)}.` : "Your rent is fully covered. Your landlord will be paid."}`));
  // a cycle fully credited by its due date through at least 2 instalments earns the desk a completion bonus (a payable the top desk pays by hand)
  if (left === 0 && state.instalments >= 2 && eatDate(now()) <= state.c.dueDate && state.t.deskCode !== LMMX_TOP_DESK && !state.c.completionBonusPaid) {
    const made = await payableBonus({ deskUid: state.t.deskUid, amountMinor: LMMX.COMPLETION_BONUS_MINOR, note: `Lipa Mdogo Mdogo completion bonus ${state.c.cycleId}`, parts: ["lmmx", "completion", state.c.cycleId] });
    if (made) { await col(COL.cycles).doc(state.c.cycleId).update({ completionBonusPaid: true }); await audit({ action: "bonus_accrued", actor: { type: "system" }, tenantId: p.tenantId, summary: `completion bonus for ${state.c.cycleId}` }); }
  }
  settleCycle(p.cycleId).catch((e) => console.error("LMMX settle after credit failed", (e as Error).message));
  return "credited";
}

export async function historyPage(tenantId: string, cursor?: string) {
  let q = col(COL.payments).where("tenantId", "==", tenantId).where("status", "==", "credited").orderBy("createdAt", "desc");
  if (cursor && /^\d+$/.test(cursor)) q = q.startAfter(Number(cursor));
  const snap = await q.limit(21).get();
  const docs = snap.docs.slice(0, 20).map((d) => d.data() as PaymentDoc);
  return { items: docs.map((p) => ({ paymentId: p.paymentId, at: p.creditedAt ?? p.createdAt, creditMinor: p.creditMinor, chargeMinor: p.chargeMinor, feesMinor: p.feesMinor, status: "success" as const })), ...(snap.docs.length > 20 ? { nextCursor: String(docs[docs.length - 1].createdAt) } : {}) };
}

/** The bot identifies a tenant by the WhatsApp sender's phone AND the ID number on the same record. */
export async function botTenant(phoneE164: string, idNumber: string): Promise<TenantDoc | null> {
  const q = await col(COL.tenants).where("phoneHash", "==", H("phone", phoneE164)).limit(5).get();
  return q.docs.map((d) => d.data() as TenantDoc).find((t) => t.status !== "closed" && t.status !== "migrated" && t.idHash === H("id", normId(idNumber))) ?? null;
}
export type { Quote };
