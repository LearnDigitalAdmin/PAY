// Tamper-evidence for money destinations and amounts. The key lives in Secret Manager (never in Firestore, never in the client).
// A value stored in Firestore is only trusted when its HMAC seal still matches; a mismatch blocks the transfer and raises an alert.
import * as crypto from "crypto";
import { bundleSecret } from "../secretsBundle";

export const LMM_SEAL_KEY = bundleSecret("LMM_SEAL_KEY");

const hmac = (key: string, label: string, parts: ReadonlyArray<string | number>): string =>
  crypto.createHmac("sha256", key).update([label, ...parts.map(String)].join("\u241f")).digest("hex");

/** Peppered fingerprint of an account number, so the database never holds a bare copy that could be matched or edited in place. */
export const fingerprint = (key: string, bankCode: string, accountNumber: string): string => hmac(key, "acct", [bankCode.toUpperCase(), accountNumber.replace(/\s+/g, "")]);

export const sealRecipient = (key: string, r: { landlordId: string; recipientCode: string; type: string; bankCode: string; fp: string }): string =>
  hmac(key, "recipient", [r.landlordId, r.recipientCode, r.type, r.bankCode.toUpperCase(), r.fp]);

/** Everything that decides one settlement: the plan, the recipient, how much and in how many parts. Re-checked right before sending. */
export const sealSettlement = (key: string, s: { id: string; planId: string; landlordId: string; recipientCode: string; grossMinor: number; sendMinors: number[]; paymentRefs: string[] }): string =>
  hmac(key, "settlement", [s.id, s.planId, s.landlordId, s.recipientCode, s.grossMinor, s.sendMinors.join(","), [...s.paymentRefs].sort().join(",")]);

export function sameSeal(a: unknown, b: string): boolean {
  if (typeof a !== "string" || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
