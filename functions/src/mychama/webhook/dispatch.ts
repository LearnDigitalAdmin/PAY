// TRACK B — routes a VERIFIED Paystack event to the shared handlers. MyChama references only.
// Error contract (matches the webhook's HTTP answers):
//   * returns normally  => the event is fully dealt with (applied, already applied, or permanently refused) => HTTP 200
//   * throws            => transient problem (Firestore, network)                                            => HTTP 500, Paystack retries
import { mychamaDb } from "../config";
import {
  handleMyChamaPayment, handleMyChamaPlanBilling, handleMyChamaReportAlacarte,
  handleMyChamaReportCreditTopup, handleMyChamaSmsTopup,
} from "./handlers";
import { isSafeChamaId, parseMyChamaReference } from "./util";

export interface PaystackChargeData {
  reference?: unknown;
  amount?: unknown;
  currency?: unknown;
  status?: unknown;
  gateway_response?: unknown;
  metadata?: unknown;
}

export type DispatchOutcome = "handled" | "ignored_non_mychama" | "ignored_invalid";

const asMeta = (m: unknown): Record<string, unknown> => (m && typeof m === "object" ? (m as Record<string, unknown>) : {});

/** Reference-derived chamaId wins (it is how the doc path was built); metadata.chamaId is only a fallback. */
function resolveChamaId(parsedChamaId: string, meta: Record<string, unknown>, reference: string): string {
  if (isSafeChamaId(parsedChamaId)) {
    if (typeof meta.chamaId === "string" && meta.chamaId !== parsedChamaId) {
      console.warn("MyChama webhook: metadata.chamaId differs from the reference — using the reference", reference);
    }
    return parsedChamaId;
  }
  return isSafeChamaId(meta.chamaId) ? meta.chamaId : "";
}

export async function dispatchChargeSuccess(data: PaystackChargeData): Promise<DispatchOutcome> {
  const parsed = parseMyChamaReference(data.reference);
  if (!parsed) {
    console.warn("MyChama webhook: ignoring non-MyChama reference");
    return "ignored_non_mychama";
  }
  const reference = data.reference as string;
  const meta = asMeta(data.metadata);
  const chamaId = resolveChamaId(parsed.chamaId, meta, reference);

  // Never apply money without an amount AND a currency to check (Paystack always sends both).
  if (!chamaId || typeof data.amount !== "number" || !Number.isFinite(data.amount) || typeof data.currency !== "string") {
    console.error("MyChama webhook: success event without a usable chamaId/amount/currency — NOT applied", reference);
    return "ignored_invalid";
  }
  const paid = data.amount;
  const cur = data.currency;

  switch (parsed.kind) {
    case "payment":
      await handleMyChamaPayment(reference, chamaId, paid, cur);
      break;
    case "sms_topup":
      await handleMyChamaSmsTopup(reference, chamaId, paid, cur);
      break;
    case "plan_billing": {
      const plan = typeof meta.plan === "string" ? meta.plan : typeof meta.toPlan === "string" ? meta.toPlan : undefined;
      await handleMyChamaPlanBilling(reference, chamaId, plan, paid, cur);
      break;
    }
    case "report_credit_topup":
      await handleMyChamaReportCreditTopup(reference, chamaId, paid, cur);
      break;
    case "report_alacarte":
      await handleMyChamaReportAlacarte(reference, chamaId, paid, cur);
      break;
  }
  return "handled";
}

/**
 * charge.failed: flip the matching doc to `failed` — but ONLY if it is still `pending`
 * (the legacy branch overwrote whatever status was there, including a `success`).
 */
export async function dispatchChargeFailed(data: PaystackChargeData): Promise<DispatchOutcome> {
  const parsed = parseMyChamaReference(data.reference);
  if (!parsed) {
    console.warn("MyChama webhook: ignoring non-MyChama reference");
    return "ignored_non_mychama";
  }
  const reference = data.reference as string;
  const chamaId = resolveChamaId(parsed.chamaId, asMeta(data.metadata), reference);
  if (!chamaId) {
    console.error("MyChama webhook: failed event without a usable chamaId", reference);
    return "ignored_invalid";
  }

  const db = mychamaDb();
  const ref = db.doc(`chamas/${chamaId}/${parsed.collection}/${reference}`);
  const message = typeof data.gateway_response === "string" ? data.gateway_response.slice(0, 200) : "";
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data()?.status !== "pending") return;
    tx.update(ref, { status: "failed", ...(message ? { paystackMessage: message } : {}), updatedAt: Date.now() });
  });
  return "handled";
}
