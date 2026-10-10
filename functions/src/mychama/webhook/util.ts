// TRACK B — pure helpers for the MyChama webhook (no Firebase imports => unit-testable).
import * as crypto from "crypto";

/**
 * Paystack signs the RAW request body with HMAC-SHA512 (hex) using the account's secret key.
 * Constant-time compare; any missing/odd-length signature is simply "invalid".
 */
export function verifyPaystackSignature(rawBody: Buffer | string, signature: string | undefined, secret: string): boolean {
  if (!signature || !secret) return false;
  const expected = Buffer.from(crypto.createHmac("sha512", secret).update(rawBody).digest("hex"), "utf8");
  const given = Buffer.from(String(signature).trim(), "utf8");
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

export type MyChamaRefKind = "payment" | "sms_topup" | "plan_billing" | "report_credit_topup" | "report_alacarte";

export interface ParsedRef {
  kind: MyChamaRefKind;
  /** "" when the reference is too short to carry one (caller may fall back to metadata.chamaId). */
  chamaId: string;
  /** mychama1 subcollection (under chamas/{chamaId}) that holds the doc whose id IS the reference. */
  collection: "paymentIntents" | "smsTopUps" | "planBilling" | "reportCreditTopUps" | "reportAlacartePurchases";
}

const KINDS: Record<string, { kind: MyChamaRefKind; collection: ParsedRef["collection"]; tail: number }> = {
  // tail = number of trailing segments that are NOT part of the chamaId
  MCW: { kind: "payment", collection: "paymentIntents", tail: 3 },            // MCW-{chama}-{CNT|LNR|MGR}-{ms}-{rand}
  MCA: { kind: "payment", collection: "paymentIntents", tail: 3 },
  MCS: { kind: "sms_topup", collection: "smsTopUps", tail: 2 },               // MCS-{chama}-{ms}-{rand}
  MCP: { kind: "plan_billing", collection: "planBilling", tail: 2 },
  MCX: { kind: "report_credit_topup", collection: "reportCreditTopUps", tail: 2 },
  MCR: { kind: "report_alacarte", collection: "reportAlacartePurchases", tail: 2 },
};

/** null => NOT a MyChama reference (the webhook then logs and answers 200 without applying anything). */
export function parseMyChamaReference(reference: unknown): ParsedRef | null {
  if (typeof reference !== "string" || reference.length > 200) return null;
  const parts = reference.split("-");
  const k = Object.prototype.hasOwnProperty.call(KINDS, parts[0]) ? KINDS[parts[0]] : undefined;
  if (!k) return null;
  // chamaId = everything between the prefix and the fixed-shape tail, so ids that contain "-" still resolve
  const chamaId = parts.length > k.tail + 1 ? parts.slice(1, parts.length - k.tail).join("-") : "";
  return { kind: k.kind, chamaId, collection: k.collection };
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** A chamaId is put into a Firestore path — only ever use one that passes this. */
export const isSafeChamaId = (v: unknown): v is string => typeof v === "string" && SAFE_ID.test(v);
