// SMS top-up commissions (Plot Yangu and MyRegister, both charged on the MAIN Paystack account by chargeSmsTopUp).
//   plan   — when the charge starts: resolve the desk owner, reserve the first-purchase rule, build the split
//   settle — in the webhook, after the tokens were credited: write the desk_events fact
//   release— on a failed / abandoned charge: free the first-purchase reservation
// A desk commission must NEVER block a customer's payment: every failure here degrades to "no desk split", leaves an
// audit row and a log line, and the charge proceeds.
import * as admin from "firebase-admin";
import { customerDocId, DESK, deskDb } from "./db";
import { getDeskConfig, type DeskConfig } from "./config";
import { smsPlan } from "./money";
import { resolveDeskOwner } from "./owner";
import { getOrCreateDeskSplit } from "./split";
import { paystackMoneyFacts, productOfEntityKey, readDeskCommission, writeDeskAudit, writeDeskEventResilient, type EventOutcome } from "./events";
import type { DeskCommission, DeskCustomerDoc } from "./types";

/** A first-purchase reservation older than this is dead (the charge was abandoned and never reported failed). */
export const FIRST_PURCHASE_RESERVATION_MS = 30 * 60 * 1000;

export type DeskSmsPlan =
  | { applied: false; reason: string }
  | { applied: true; splitCode: string; commission: DeskCommission; reservedFirstPurchase: boolean };

interface ReserveOutcome { exists: boolean; sharePct: number; rule: string; reserved: boolean }

/** Eligibility + share + reservation in ONE transaction, so two concurrent charges can never both be a "first purchase". */
async function planAndReserve(
  entityKey: string, reference: string, grossMinor: number, credits: number, cfg: DeskConfig, now: number,
): Promise<ReserveOutcome> {
  const db = deskDb();
  const ref = db.collection(DESK.customers).doc(customerDocId(entityKey));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { exists: false, sharePct: 0, rule: "no_customer", reserved: false };
    const c = snap.data() as Partial<DeskCustomerDoc>;
    const liveReservation = typeof c.firstPurchaseReservedRef === "string" && c.firstPurchaseReservedRef !== ""
      && typeof c.firstPurchaseReservedAt === "number" && now - c.firstPurchaseReservedAt < FIRST_PURCHASE_RESERVATION_MS;
    const eligible = c.firstPurchaseUsed !== true && !liveReservation;
    const plan = smsPlan({ grossMinor, credits, firstPurchaseEligible: eligible }, cfg);
    // The reservation is taken only when the first-purchase rule is what produced this share; the events trigger consumes it.
    const reserved = plan.rule === "sms_first_purchase";
    if (reserved) tx.update(ref, { firstPurchaseReservedRef: reference, firstPurchaseReservedAt: now });
    return { exists: true, sharePct: plan.agentSharePct, rule: plan.rule, reserved };
  });
}

/**
 * Called by chargeSmsTopUp for a Plot Yangu landlord (and for a verified school, see notes). Returns the split to attach
 * to the charge and the `deskCommission` to store on the pending document, or `applied:false` (the plain charge).
 */
export async function planDeskSmsCharge(p: {
  entityKey: string; reference: string; grossMinor: number; credits: number; now?: number;
}): Promise<DeskSmsPlan> {
  const now = p.now ?? Date.now();
  let reserved = false;
  try {
    if (!productOfEntityKey(p.entityKey)) return { applied: false, reason: "invalid_entity_key" };
    const owner = await resolveDeskOwner(p.entityKey);
    if (!owner) return { applied: false, reason: "no_desk_owner" };
    const cfg = await getDeskConfig();
    const out = await planAndReserve(p.entityKey, p.reference, p.grossMinor, p.credits, cfg, now);
    reserved = out.reserved;
    if (!out.exists || !(out.sharePct > 0)) {
      return { applied: false, reason: out.rule };   // "no_margin": the desk earns nothing on this purchase
    }
    const splitCode = await getOrCreateDeskSplit([{ subaccount: owner.subaccountCode, sharePct: out.sharePct }], "sms");
    return {
      applied: true, splitCode, reservedFirstPurchase: out.reserved,
      commission: { agentCode: owner.agentCode, agentId: owner.agentId, sharePct: out.sharePct, rule: out.rule, entityKey: p.entityKey },
    };
  } catch (err) {
    console.error("Desk SMS commission failed — charging without a desk split:", p.reference, (err as Error)?.message);
    if (reserved) await releaseFirstPurchaseReservation(p.entityKey, p.reference);
    await writeDeskAudit({ action: "desk_sms_resolution_failed", entityKey: p.entityKey, meta: { reference: p.reference, error: String((err as Error)?.message ?? err).slice(0, 300) } });
    return { applied: false, reason: "desk_resolution_failed" };
  }
}

/** Frees the reservation, but only if it is still THIS charge's (a newer charge may legitimately hold it). */
export async function releaseFirstPurchaseReservation(entityKey: string, reference: string): Promise<boolean> {
  try {
    const db = deskDb();
    const ref = db.collection(DESK.customers).doc(customerDocId(entityKey));
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists || (snap.data() as Partial<DeskCustomerDoc>).firstPurchaseReservedRef !== reference) return false;
      tx.update(ref, {
        firstPurchaseReservedRef: admin.firestore.FieldValue.delete(),
        firstPurchaseReservedAt: admin.firestore.FieldValue.delete(),
      });
      return true;
    });
  } catch (err) {
    console.error("Could not release the first-purchase reservation:", reference, (err as Error)?.message);
    await writeDeskAudit({ action: "desk_reservation_release_failed", entityKey, meta: { reference, error: String((err as Error)?.message ?? err).slice(0, 300) } });
    return false;
  }
}

/** charge.failed / abandoned: release the reservation recorded on the pending sms-topup-transactions document. */
export async function releaseSmsReservationFor(pending: unknown, reference: string): Promise<boolean> {
  const c = readDeskCommission((pending as { deskCommission?: unknown } | undefined)?.deskCommission);
  return c ? releaseFirstPurchaseReservation(c.entityKey, reference) : false;
}

/**
 * Settlement: after the token credit succeeded and ONLY if the pending document carries a deskCommission, write
 * `sms_purchase:<reference>` with the REAL gross and fee from the webhook. Create-only, so a replayed webhook adds nothing.
 * Never throws (the tokens are already credited; throwing would make Paystack replay the webhook and credit twice).
 */
export async function recordSmsPurchaseEvent(p: {
  reference: string; tokens: number; data: unknown; pending: unknown; retryDelayMs?: number;
}): Promise<EventOutcome> {
  const commission = readDeskCommission((p.pending as { deskCommission?: unknown } | undefined)?.deskCommission);
  if (!commission) return "skipped";
  const money = paystackMoneyFacts(p.data);
  const product = productOfEntityKey(commission.entityKey);
  if (!money || !product || !Number.isSafeInteger(p.tokens) || p.tokens < 1) {
    console.error("Desk SMS event not written — unusable settlement facts:", p.reference);
    await writeDeskAudit({ action: "desk_event_skipped", agentId: commission.agentId, entityKey: commission.entityKey, meta: { reference: p.reference, reason: "unusable_settlement_facts" } });
    return "skipped";
  }
  return writeDeskEventResilient({
    eventId: `sms_purchase:${p.reference}`, type: "sms_purchase", product, entityKey: commission.entityKey,
    agentId: commission.agentId, paystackRef: p.reference, grossMinor: money.grossMinor, feeMinor: money.feeMinor,
    agentSharePct: commission.sharePct, paidAt: money.paidAt, credits: p.tokens,
  }, p.retryDelayMs);
}
