// TRACK B — mychamaPayInitiate: a linked PAY user pays their OWN chama obligation by mobile money.
// Mirrors Chama `mychama/payments.py::initiatePayment` (self-pay branch) field-for-field, charging with the
// NEW Paystack account's key. Money is only ever marked received by the webhook (../webhook).
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { REGION, MYCHAMA_PAYSTACK_SECRET_KEY, MYCHAMA_ID_PEPPER, mychamaDb, plotDb, normalizeKePhone, computePhoneKey } from "../config";
import { myChamaError } from "../errors";
import { MYCHAMA_PATHS } from "../contract";
import type { ChamaLinkDoc, PayInitiateRequest, PayInitiateResponse } from "../contract";
import {
  MAX_INTENTS_PER_HOUR, PAYMENT_INTENT_TTL_SECONDS, contributionFees, loanRepaymentFees, mgrContributionFees,
  mainAccountChargeSubunits, onlineCollectionAllowed, type FeeBreakdown,
} from "./fees";
import { chargeMobileMoney } from "./paystack";
import { recordResult, releaseKey, reserveKey } from "./idempotency";
import {
  SPLIT_KEY_VERSION, assertGrossWithinLimit, cleanRequest, detectProvider, isSafeId, isValidKenyanPhone, phoneRejectionMessage, validateTarget,
  type CleanRequest, type Target,
} from "./validate";

const PURPOSE_CODE = { contribution: "CNT", loan_repayment: "LNR", mgr_contribution: "MGR" } as const;
const RAND = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function buildReference(chamaId: string, code: string): string {
  let rand = "";
  for (let i = 0; i < 6; i++) rand += RAND[Math.floor(Math.random() * RAND.length)];
  return `MCA-${chamaId}-${code}-${Date.now()}-${rand}`;
}

/** The ONE place a chama link is resolved: active links only; chamaId -> memberId comes from the link. */
async function resolveLink(uid: string, chamaId: string): Promise<ChamaLinkDoc> {
  const snap = await plotDb().collection(MYCHAMA_PATHS.links(uid)).where("chamaId", "==", chamaId).get();
  const links = snap.docs.map((d) => d.data() as ChamaLinkDoc).filter((l) => l && l.uid === uid);
  const active = links.filter((l) => l.state === "active" && isSafeId(l.memberId));
  if (active.length === 1) return active[0];
  if (active.length > 1) console.error("mychamaPayInitiate: more than one active link for one chama — refusing", { chamaId });
  if (!active.length && links.some((l) => l.state === "needs_reverify")) {
    throw myChamaError("link_needs_reverify", "Please re-verify your phone to pay this chama.", "failed-precondition");
  }
  throw myChamaError("not_linked", "You are not linked to this chama.", "permission-denied");
}

export const mychamaPayInitiate = onCall(
  { region: REGION, cors: true, maxInstances: 10, timeoutSeconds: 60, secrets: [MYCHAMA_PAYSTACK_SECRET_KEY, MYCHAMA_ID_PEPPER] },
  async (req): Promise<PayInitiateResponse> => {
    const uid = req.auth?.uid;
    if (!uid) throw myChamaError("unauthenticated", "Sign in to pay.", "unauthenticated");
    const role: "landlord" | "tenant" = (req.auth?.token as { role?: string } | undefined)?.role === "landlord" ? "landlord" : "tenant";

    // 1. shape-check everything the client sent
    const r: CleanRequest = cleanRequest(req.data as Partial<PayInitiateRequest> | undefined);

    // 2. the link decides WHICH member this is — never the client
    const link = await resolveLink(uid, r.chamaId);
    const memberId = link.memberId;

    const db = mychamaDb();
    let chama: FirebaseFirestore.DocumentData;
    let member: FirebaseFirestore.DocumentData;
    let target: Target;
    let plan = "free";
    let fee: FeeBreakdown;
    let phoneOnFile = "";

    try {
      // 3. chama / plan / settlement
      const chamaSnap = await db.doc(`chamas/${r.chamaId}`).get();
      chama = chamaSnap.data() || {};
      if (!chamaSnap.exists || chama.status === "suspended") {
        throw myChamaError("chama_unavailable", "This chama isn't available right now.", "failed-precondition");
      }
      plan = chama.plan || "free";
      if (!onlineCollectionAllowed(plan) || !chama.settlementSplitCode || chama.settlementSplitKeyVersion !== SPLIT_KEY_VERSION || !chama.settlementSubaccountCode) {
        throw myChamaError("online_collection_disabled", "This chama can't collect online payments yet.", "failed-precondition");
      }

      // 4. member
      const memberSnap = await db.doc(`chamas/${r.chamaId}/members/${memberId}`).get();
      member = memberSnap.data() || {};
      if (!memberSnap.exists || member.status !== "active") {
        throw myChamaError("not_linked", "Your membership in this chama isn't active.", "permission-denied");
      }
      phoneOnFile = normalizeKePhone(member.phoneNormalized || member.phone || "");
      // payment-time re-check of the link's phone binding (Track A also flips the link on sync)
      if (!phoneOnFile || computePhoneKey(phoneOnFile) !== link.boundPhoneKey) {
        throw myChamaError("link_needs_reverify", "Please re-verify your phone to pay this chama.", "failed-precondition");
      }

      // 5. target belongs to this member and is payable
      target = await validateTarget(db, r.chamaId, memberId, r);

      // 6. fees (server-side only) + sane gross
      fee = r.purpose === "contribution" ? contributionFees(r.amount)
        : r.purpose === "loan_repayment" ? loanRepaymentFees(r.amount, plan)
        : mgrContributionFees(r.amount, plan);
      assertGrossWithinLimit(fee.gross);

      // 7. rate limit — same rule as Chama (per member, rolling hour, over paymentIntents)
      const recent = await db.collection(`chamas/${r.chamaId}/paymentIntents`)
        .where("memberId", "==", memberId).where("createdAt", ">=", Date.now() - 60 * 60 * 1000)
        .limit(MAX_INTENTS_PER_HOUR).get();
      if (recent.size >= MAX_INTENTS_PER_HOUR) {
        throw myChamaError("rate_limited", "Too many payment attempts this hour. Please try again later.", "resource-exhausted", 600);
      }
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      console.error("mychamaPayInitiate: mychama1 read failed", { chamaId: r.chamaId, err: (e as Error)?.message });
      throw myChamaError("chama_unavailable", "We couldn't reach the chama right now. Please try again.", "unavailable");
    }

    // 8. phone: default = member's phone on file; an explicit valid KE number is allowed and recorded
    const phone = r.phone ? normalizeKePhone(r.phone) : phoneOnFile;
    if (!isValidKenyanPhone(phone)) throw myChamaError("invalid_phone", phoneRejectionMessage(r.phone ?? phone), "invalid-argument");
    const phoneOverridden = phone !== phoneOnFile;
    const provider = detectProvider(phone);

    // 9. idempotency (same collection as Chama shared/idempotency.py)
    const reservation = await reserveKey(db, r.chamaId, r.clientRequestId);
    if (reservation.kind === "in_flight") {
      throw myChamaError("rate_limited", "This payment is already being processed. Please wait a moment.", "aborted", 5);
    }
    if (reservation.kind === "replay") {
      const prev = reservation.result;
      const prevRef = typeof prev.reference === "string" ? prev.reference : "";
      // the key is per chama, not per member: make sure the stored result is MINE before returning it
      const prevIntent = isSafeId(prevRef) ? (await db.doc(`chamas/${r.chamaId}/paymentIntents/${prevRef}`).get()).data() : undefined;
      if (!prevIntent || prevIntent.memberId !== memberId) {
        throw myChamaError("invalid_target", "That clientRequestId was already used.", "already-exists");
      }
      return {
        reference: prevRef,
        grossAmount: Number(prev.grossAmount),
        paystackFee: Number(prev.paystackFee),
        ourFee: Number(prev.ourFee),
        message: typeof prev.message === "string" ? prev.message : null,
      };
    }

    // 10. intent doc (shape of Chama initiatePayment + arrearId as CYBER stores it + audit extras)
    const reference = buildReference(r.chamaId, PURPOSE_CODE[r.purpose]);
    const ts = Date.now();
    const intentRef = db.doc(`chamas/${r.chamaId}/paymentIntents/${reference}`);

    try {
      await intentRef.set({
        chamaId: r.chamaId,
        memberId,
        purpose: r.purpose,
        reference,
        amount: fee.net,
        grossAmount: fee.gross,
        paystackFee: fee.paystackFee,
        ourFee: fee.ourFee,
        currency: "KES",
        phone,
        provider,
        status: "pending",
        channel: "app",
        via: "pay_portal",
        initiatedBy: { uid, role },
        phoneOverridden,
        memberPhoneOnFile: phoneOnFile,
        contributionId: target.contributionId,
        loanId: target.loanId,
        installmentNo: target.installmentNo,
        potId: target.potId,
        potPeriod: target.potPeriod,
        arrearId: target.arrearId,
        splitCode: chama.settlementSplitCode,
        createdAt: ts,
        updatedAt: ts,
        expiresAt: ts + PAYMENT_INTENT_TTL_SECONDS * 1000,
      });
    } catch (e) {
      await releaseKey(db, r.chamaId, r.clientRequestId);
      console.error("mychamaPayInitiate: could not create intent", (e as Error)?.message);
      throw myChamaError("internal", "Could not start the payment. Please try again.", "internal");
    }

    // 11. STK push with the NEW account's key
    let message: string | null = null;
    try {
      message = (await chargeMobileMoney({
        secretKey: MYCHAMA_PAYSTACK_SECRET_KEY.value(),
        email: `${memberId}@mychama.app`,
        amountKes: fee.gross,
        phoneE164: phone,
        provider,
        reference,
        subaccountCode: chama.settlementSubaccountCode,
        transactionChargeSubunits: mainAccountChargeSubunits(fee.gross, fee.net),
        metadata: {
          chargeType: "mychama_payment",
          targetProject: "mychama1",
          chamaId: r.chamaId,
          memberId,
          purpose: r.purpose,
          splitCode: chama.settlementSplitCode,
          channel: "app",
          via: "pay_portal",
        },
      })).message;
      await intentRef.update({ paystackMessage: message || "", updatedAt: Date.now() });
    } catch (e: any) {
      console.error("mychamaPayInitiate: Paystack charge failed", { reference, http: e?.response?.status, msg: e?.response?.data?.message || e?.message });
      try { await intentRef.update({ status: "failed", updatedAt: Date.now() }); } catch (_) { /* best effort */ }
      await releaseKey(db, r.chamaId, r.clientRequestId);
      throw myChamaError("upstream_failure", "Could not start the payment with Paystack. Please try again.", "unavailable");
    }

    const result: PayInitiateResponse = { reference, grossAmount: fee.gross, paystackFee: fee.paystackFee, ourFee: fee.ourFee, message };
    try {
      await recordResult(db, r.chamaId, r.clientRequestId, { ...result });
    } catch (e) {
      // the STK is already on the member's phone — never fail the call for a bookkeeping write
      console.error("mychamaPayInitiate: could not record idempotent result (non-fatal)", (e as Error)?.message);
    }
    return result;
  }
);
