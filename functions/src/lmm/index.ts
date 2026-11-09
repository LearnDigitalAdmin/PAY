// Lipa Mos Mos: pay rent a little at a time. Money waits in Samuhia's Paystack balance, then the landlord is paid by transfer.
import * as admin from "firebase-admin";
import { onCall, HttpsError, CallableRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { PAYSTACK_SECRET_KEY } from "../desk/paystack";

import { toMsisdn } from "../phone/safaricom";
import { alertOps } from "./alert";
import { LMM } from "./config";
import { createSealedRecipient } from "./recipient";
import { missedReminder } from "./reminders";
import { LMM_SEAL_KEY } from "./seal";
import { applySettlement, creditPayment, onTransferEvent, reconcileSent, sendSettlement, settlePlan, settlementsCol, type Secrets } from "./settle";
import { daysUntil, eatDate, payoutDue } from "./due";
import { minSendableMinor, smallPayoutNotice } from "./fees";
import { plansCol, paymentsCol, recipientKind, resolveTarget, type PlanDoc } from "./plan";
import { lmmText, sendOnce } from "./sms";
import { BUNDLE_SECRETS } from "../secretsBundle";

export { lmm_getPlan, lmm_start, lmm_pay } from "./plan";

export const lmmSecrets = (): Secrets => ({ paystack: PAYSTACK_SECRET_KEY.value(), seal: LMM_SEAL_KEY.value() });
/** Called by the Paystack webhook (after it has verified the signature) for a charge.success whose reference starts with LMM_. */
export const handleLmmCharge = (reference: string, data: { amount?: unknown }) => creditPayment(lmmSecrets(), reference, Number(data?.amount));
/** Called by the webhook for transfer.success / transfer.failed / transfer.reversed. */
export const handleLmmTransfer = (event: string, data: unknown) => onTransferEvent(lmmSecrets(), event, data);

/**
 * A signed-in landlord turns Lipa Mos Mos on for their registered payout account. The account is taken from THIS request, and it must
 * match the account on their profile, so neither a tampered profile nor a stray request can create a recipient on its own.
 */
export const lmm_setupRecipient = onCall(
  { region: "africa-south1", cors: true, timeoutSeconds: 60, memory: "256MiB", maxInstances: 5, secrets: BUNDLE_SECRETS },
  async (request: CallableRequest<{ settlementType?: string; bankCode?: string; accountNumber?: string; name?: string }>) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first");
    const landlordId = request.auth.uid;
    const d = request.data ?? {};
    const prof = (await admin.firestore().collection("users").doc(landlordId).get()).data()?.paymentInfo;
    if (!prof?.accountId) throw new HttpsError("failed-precondition", "Set up your payout account first");
    const norm = (x: unknown) => String(x ?? "").replace(/\s+/g, "");
    if (norm(prof.accountNumber) !== norm(d.accountNumber) || String(prof.settlementType ?? "") !== String(d.settlementType ?? "")) {
      throw new HttpsError("invalid-argument", "These details do not match your registered payout account");
    }
    const r = await createSealedRecipient(lmmSecrets(), { landlordId, settlementType: String(d.settlementType ?? ""), bankCode: String(d.bankCode ?? prof.settlementBankCode ?? ""), accountNumber: String(d.accountNumber ?? ""), name: String(d.name ?? prof.businessName ?? prof.name ?? "Landlord") });
    if (!r.ok) throw new HttpsError("failed-precondition", `Lipa Mos Mos is not available for this payout account: ${r.reason ?? "unsupported"}`);
    return { ok: true };
  });

/** The signed-in landlord's own Lipa Mos Mos status (the recipient document itself is never readable by the app). */
export const lmm_recipientStatus = onCall({ region: "africa-south1", cors: true, maxInstances: 5 }, async (request: CallableRequest<unknown>) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first");
  const r = (await admin.firestore().collection("lmm_recipients").doc(request.auth.uid).get()).data();
  return r ? { status: r.status === "active" ? "active" : "unsupported", reason: r.status === "active" ? null : r.reason ?? null, last4: r.last4 ?? "" } : { status: "none", reason: null, last4: "" };
});

const eat = (now: number) => new Date(now + 3 * 3_600_000);

/** 10:00 Nairobi daily: resume anything half-done, pay out plans whose due date has come, warn and remind tenants, expire dead charges. */
export const lmm_dailySweep = onSchedule(
  { schedule: "0 10 * * *", timeZone: "Africa/Nairobi", region: "us-central1", timeoutSeconds: 540, memory: "512MiB", secrets: BUNDLE_SECRETS },
  async () => {
    const s = lmmSecrets(); const now = Date.now();
    try {
      // 1) finish what was left half-done
      for (const d of (await settlementsCol().where("status", "in", ["locked", "paid_unapplied"]).get()).docs) {
        const st = d.data();
        try {
          if (st.status === "locked") { await sendSettlement(s, d.id); await reconcileSent(s, d.id); if (now - Number(st.createdAt) > 24 * 3_600_000) await alertOps("SETTLEMENT_STUCK", `${d.id} is still not paid after 24h`); }
          else await applySettlement(d.id);
        } catch (e) { await alertOps("UNEXPECTED", `resume ${d.id}: ${(e as Error).message}`); }
      }
      // 2) pay out every plan whose DUE DATE has come (the earliest open invoice's dueDate, today or already past; the 5th only when nothing is invoiced).
      //    Whatever has been collected goes, even if the target was not reached (invoices become "partial"). A plan that was missed on its day is caught up here.
      const today = eatDate(now);
      for (const d of (await plansCol().where("creditedMinor", ">", 0).get()).docs) {
        const p = d.data() as PlanDoc;
        let dueOn: string | null;
        try { dueOn = (await resolveTarget(p.agentId, p.tenantId, p)).dueOn; } catch (e) { console.error("LMM due date failed", d.id, (e as Error).message); continue; }
        if (!payoutDue(dueOn, today)) continue;
        try {
          const r = await settlePlan(s, d.id, "due");
          if (r === "below_floor" && p.tenantPhone) {
            // too little to send even after the fee: nothing goes, the money stays on the plan, and the tenant is told (once per due date)
            const kind = await recipientKind(p.agentId);
            if (kind) await sendOnce(`floor_${d.id}_${dueOn ?? today.slice(0, 7)}`, toMsisdn(p.tenantPhone), lmmText.tooSmallAtDue({ name: p.tenantName, creditedMinor: p.creditedMinor, minMinor: minSendableMinor(kind) }));
          }
        } catch (e) { await alertOps("UNEXPECTED", `settle ${d.id}: ${(e as Error).message}`); }
      }
      // 3) tenant messages: the 5-day fee warning, then the gentle missed-payment reminder
      for (const d of (await plansCol().where("status", "==", "active").get()).docs) {
        const p = d.data() as PlanDoc;
        try {
          const { targetMinor, basis, dueOn } = await resolveTarget(p.agentId, p.tenantId, p);
          // 3a) FIVE DAYS BEFORE THE DUE DATE a tenant holding under KES 300 is told what a payout will cost them. Once per due date and kind of notice.
          if (p.tenantPhone && dueOn && p.creditedMinor > 0 && p.creditedMinor < LMM.MIN_SETTLEMENT_MINOR) {
            const days = daysUntil(dueOn, now);
            const kind = days >= 0 && days <= LMM.WARN_DAYS_BEFORE_DUE ? await recipientKind(p.agentId) : null;
            const n = kind ? smallPayoutNotice(p.creditedMinor, kind) : null;
            if (n) {
              const msisdn = toMsisdn(p.tenantPhone);
              const sent = await sendOnce(`warn_${d.id}_${dueOn}_${n.kind}`, msisdn, n.kind === "fee_from_rent"
                ? lmmText.feeWarning({ name: p.tenantName, creditedMinor: n.creditedMinor, feeMinor: n.feeMinor, netMinor: n.netMinor, dueOn })
                : lmmText.tooSmallWarning({ name: p.tenantName, creditedMinor: n.creditedMinor, minMinor: n.minMinor, dueOn }));
              if (sent) { await d.ref.update({ lastSmsAt: now }); continue; }   // one message a day is enough
            }
          }
          if (basis !== "invoices") continue;          // nothing is due yet (no open invoice): never nag
          const remaining = targetMinor - p.creditedMinor;
          const m = missedReminder({ frequency: p.frequency, status: p.status, remainingMinor: remaining, createdAt: p.createdAt, lastPaymentAt: p.lastPaymentAt, lastSmsAt: p.lastSmsAt, missedCount: p.missedCount }, now);
          if (m.send && p.tenantPhone) {
            const sent = await sendOnce(`miss_${d.id}_${eat(now).toISOString().slice(0, 10)}`, toMsisdn(p.tenantPhone), lmmText.missed({ name: p.tenantName, days: m.days, balanceMinor: remaining }));
            if (sent) await d.ref.update({ lastSmsAt: now, missedCount: admin.firestore.FieldValue.increment(1) });
          }
        } catch (e) { console.error("LMM reminder failed", d.id, (e as Error).message); }
      }
      // 4) charges nobody confirmed
      for (const st of ["initiating", "pending"]) {
        for (const d of (await paymentsCol().where("status", "==", st).where("createdAt", "<", now - LMM.PENDING_PAYMENT_TTL_MS).get()).docs) await d.ref.update({ status: "expired" });
      }
    } catch (e) { await alertOps("UNEXPECTED", `sweep: ${(e as Error).message}`); }
  });
