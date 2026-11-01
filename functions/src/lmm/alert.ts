// Anything odd goes to ONE fixed number (LMM.ALERT_MOBILE, in code). Alerts are de-duplicated per kind per hour so a loop cannot flood it.
import * as admin from "firebase-admin";
import { LMM } from "./config";
import { sendSms } from "./sms";

export type AlertKind =
  | "SEAL_MISMATCH" | "RECIPIENT_MISMATCH" | "RECIPIENT_MISSING" | "AMOUNT_MISMATCH" | "PAYMENT_UNVERIFIED" | "OVER_CAP" | "TRANSFER_FAILED"
  | "TRANSFER_REVERSED" | "OTP_REQUIRED" | "BAD_SIGNATURE" | "LOW_BALANCE" | "PLAN_MISMATCH" | "SETTLEMENT_STUCK" | "INVOICE_APPLY_FAILED" | "UNEXPECTED";

/** Never throws, never blocks the payment path. Returns whether an SMS went out. */
export async function alertOps(kind: AlertKind, detail: string): Promise<boolean> {
  const line = `LMM ALERT ${kind}: ${detail}`.replace(/[^\x20-\x7E]/g, "").slice(0, 150);
  console.error(line);
  try {
    const hour = new Date().toISOString().slice(0, 13).replace(/\D/g, "");
    await admin.firestore().collection("lmm_alerts").doc(`${kind}_${hour}`).create({ detail: detail.slice(0, 500), createdAt: admin.firestore.FieldValue.serverTimestamp() });
  } catch (e) {
    if ((e as { code?: number }).code === 6) return false;   // already alerted this hour
  }
  return sendSms(LMM.ALERT_MOBILE, line);
}
