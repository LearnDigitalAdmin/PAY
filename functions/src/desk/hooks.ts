// Webhook-side desk facts for everything except SMS (see sms.ts): rent, Plot Yangu subscriptions, MyChama platform
// charges and refunds. Each writes ONLY when the charge carries a deskCommission (written by whoever attached the split).
import { DESK, deskDb } from "./db";
import {
  findDeskAgentByCode, monthKeyEAT, paystackMoneyFacts, productOfEntityKey, readDeskCommission, writeDeskAudit,
  writeDeskEvent, writeDeskEventResilient, type EventOutcome,
} from "./events";
import type { DeskEventDoc, DeskEventType } from "./types";

/** rent_payment — from the `transactions/{reference}` document written by initiateRentCharge. */
export async function recordRentPaymentEvent(p: { reference: string; data: unknown; transaction: unknown; retryDelayMs?: number }): Promise<EventOutcome> {
  const c = readDeskCommission((p.transaction as { deskCommission?: unknown } | undefined)?.deskCommission);
  if (!c) return "skipped";
  const money = paystackMoneyFacts(p.data);
  const product = productOfEntityKey(c.entityKey);
  if (!money || !product) {
    await writeDeskAudit({ action: "desk_event_skipped", agentId: c.agentId, entityKey: c.entityKey, meta: { reference: p.reference, reason: "unusable_settlement_facts" } });
    return "skipped";
  }
  return writeDeskEventResilient({
    eventId: `rent_payment:${p.reference}`, type: "rent_payment", product, entityKey: c.entityKey, agentId: c.agentId,
    paystackRef: p.reference, grossMinor: money.grossMinor, feeMinor: money.feeMinor, agentSharePct: c.sharePct, paidAt: money.paidAt,
  }, p.retryDelayMs);
}

/** subscription_payment — Plot Yangu, from `subscriptions/{reference}` when PMS stored a deskCommission on it. */
export async function recordSubscriptionEvent(p: { reference: string; data: unknown; subscription: unknown; planId?: string; retryDelayMs?: number }): Promise<EventOutcome> {
  const c = readDeskCommission((p.subscription as { deskCommission?: unknown } | undefined)?.deskCommission);
  if (!c) return "skipped";
  const money = paystackMoneyFacts(p.data);
  const product = productOfEntityKey(c.entityKey);
  if (!money || !product) {
    await writeDeskAudit({ action: "desk_event_skipped", agentId: c.agentId, entityKey: c.entityKey, meta: { reference: p.reference, reason: "unusable_settlement_facts" } });
    return "skipped";
  }
  return writeDeskEventResilient({
    eventId: `subscription_payment:${p.reference}`, type: "subscription_payment", product, entityKey: c.entityKey, agentId: c.agentId,
    paystackRef: p.reference, grossMinor: money.grossMinor, feeMinor: money.feeMinor, agentSharePct: c.sharePct, paidAt: money.paidAt,
    periodMonth: monthKeyEAT(money.paidAt), ...(p.planId ? { plan: p.planId } : {}),
  }, p.retryDelayMs);
}

// ───────────────────────────── MyChama platform charges ─────────────────────────────
export type MyChamaDeskKind = "sms_topup" | "plan_billing" | "report_credit_topup" | "report_alacarte";
const EVENT_TYPE: Record<MyChamaDeskKind, DeskEventType> = {
  sms_topup: "sms_purchase", plan_billing: "subscription_payment", report_credit_topup: "report_purchase", report_alacarte: "report_purchase",
};
/** What the Paystack charge payload adds to a MyChama handler: the real amount and fee (minor units) and the payment time. */
export interface MyChamaChargeFacts { amountKobo?: unknown; feesKobo?: unknown; paidAt?: unknown }

/**
 * After the transactional apply succeeded (or was already applied): write the desk event for a MyChama platform charge,
 * only if the INTENT document has a deskCommission (written by Chama). MCS- -> sms_purchase, MCP- -> subscription_payment
 * (plan, periodMonth in Africa/Nairobi), MCX-/MCR- -> report_purchase. Contributions, loans and MGR never come here.
 * Throws only on a transient error (the handlers are idempotent, so the webhook's 500 -> retry is safe).
 */
export async function recordMyChamaDeskEvent(p: {
  kind: MyChamaDeskKind; reference: string; facts?: MyChamaChargeFacts; intent: Record<string, unknown> | undefined;
}): Promise<EventOutcome> {
  const c = readDeskCommission(p.intent?.deskCommission);
  if (!c) return "skipped";
  const money = paystackMoneyFacts({ amount: p.facts?.amountKobo, fees: p.facts?.feesKobo, paid_at: p.facts?.paidAt });
  const product = productOfEntityKey(c.entityKey);
  if (!money || !product) {
    await writeDeskAudit({ action: "desk_event_skipped", agentId: c.agentId, entityKey: c.entityKey, meta: { reference: p.reference, reason: "unusable_settlement_facts" } });
    return "skipped";
  }
  // Chama stores the desk CODE; the id comes from desk_agents. Prefer the id on the commission only when the code lookup fails.
  let agentId = c.agentId;
  if (c.agentCode) {
    const found = await findDeskAgentByCode(c.agentCode);
    if (found) agentId = found.agentId;
  }
  const type = EVENT_TYPE[p.kind];
  const credits = Number(p.intent?.credits);
  const planRaw = p.intent?.toPlan ?? p.intent?.plan;
  const event: DeskEventDoc = {
    eventId: `${type}:${p.reference}`, type, product, entityKey: c.entityKey, agentId, paystackRef: p.reference,
    grossMinor: money.grossMinor, feeMinor: money.feeMinor, agentSharePct: c.sharePct, paidAt: money.paidAt,
    ...(p.kind === "sms_topup" && Number.isSafeInteger(credits) && credits > 0 ? { credits } : {}),
    ...(p.kind === "plan_billing" ? { periodMonth: monthKeyEAT(money.paidAt), ...(typeof planRaw === "string" ? { plan: planRaw } : {}) } : {}),
  };
  try {
    return (await writeDeskEvent(event)) ? "written" : "duplicate";
  } catch (err) {
    if (/^Invalid desk event/.test((err as Error)?.message ?? "")) {
      await writeDeskAudit({ action: "desk_event_skipped", agentId, entityKey: c.entityKey, meta: { reference: p.reference, reason: (err as Error).message } });
      return "skipped";
    }
    throw err;
  }
}

// ───────────────────────────── refunds ─────────────────────────────
/** The refunded transaction's reference from a Paystack `refund.processed` payload (transaction_reference). */
export function refundedReference(data: unknown): string {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const direct = d.transaction_reference;
  if (typeof direct === "string" && direct) return direct;
  const nested = (d.transaction as { reference?: unknown } | undefined)?.reference;
  return typeof nested === "string" ? nested : "";
}

/**
 * refund.processed: when a desk_events document exists for the refunded transaction, write the `refund` event (the desk
 * trigger turns it into reversal rows). Otherwise the refund is none of desk's business and is ignored.
 */
export async function recordRefundEvent(data: unknown): Promise<EventOutcome | "ignored"> {
  const originalRef = refundedReference(data);
  if (!originalRef) return "ignored";
  const snap = await deskDb().collection(DESK.events).where("paystackRef", "==", originalRef).limit(10).get();
  const original = snap.docs.map((d) => d.data() as Partial<DeskEventDoc>).find((e) => e.type !== "refund");
  if (!original || !original.agentId || !original.entityKey || !original.product) return "ignored";
  const d = data as Record<string, unknown>;
  const id = [d.refund_reference, d.id, originalRef].find((v) => (typeof v === "string" && v !== "") || typeof v === "number");
  const event: DeskEventDoc = {
    eventId: `refund:${String(id)}`, type: "refund", product: original.product, entityKey: original.entityKey, agentId: original.agentId,
    paystackRef: originalRef, grossMinor: original.grossMinor as number, feeMinor: original.feeMinor as number,
    agentSharePct: original.agentSharePct as number, paidAt: Date.now(), originalRef,
  };
  try {
    return (await writeDeskEvent(event)) ? "written" : "duplicate";
  } catch (err) {
    if (/^Invalid desk event/.test((err as Error)?.message ?? "")) {
      await writeDeskAudit({ action: "desk_event_skipped", agentId: event.agentId, entityKey: event.entityKey, meta: { eventId: event.eventId, reason: (err as Error).message } });
      return "skipped";
    }
    throw err;
  }
}
