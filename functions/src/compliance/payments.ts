// KES 200 report payments. Reference prefix CRP_ routes the Paystack webhook here (see the branch in index.ts).
// PMS / Landlord Watch: company revenue, the customer pays exactly KES 200.00 and we absorb Paystack's fee.
// Desk reports are paid through the desk ticket flow (CYBER_DSK_ references), not here.
import * as admin from "firebase-admin";
import { REPORT_PRICE_MINOR } from "./constants";

type Db = admin.firestore.Firestore;
const ORDER_ID = /^[a-f0-9]{16}$/;
export const reportsCol = (db: Db) => db.collection("complianceReports");

/** Idempotent. Called by the webhook and by status() when the webhook is late. */
export async function settleReportPayment(db: Db, reference: string, data: Record<string, unknown>, metadata: Record<string, unknown>): Promise<void> {
  const orderId = String(metadata.orderId ?? "");
  if (!ORDER_ID.test(orderId) || !reference.startsWith(`CRP_${orderId}_`)) { console.error(`Compliance report: unusable reference/metadata for ${reference}`); return; }
  const amountKobo = Number(data.amount);
  const gross = amountKobo / 100;
  const fees = data.fees ? Number(data.fees) / 100 : 0;
  const received = data.amount_received ? Number(data.amount_received) / 100 : gross - fees;
  const ref = reportsCol(db).doc(orderId);

  const outcome = await db.runTransaction(async (tx) => {
    const d = (await tx.get(ref)).data();
    if (!d) return "missing" as const;
    if (d.entitled === true) return "already" as const;
    if (d.reference !== reference) return "stale_reference" as const;           // only the latest payment attempt can settle the order
    if (Math.round(amountKobo) !== REPORT_PRICE_MINOR) {
      tx.update(ref, { state: "failed", error: { code: "CR_PAYMENT_FAILED", message: "The payment amount did not match. Please contact support." } });
      return "mismatch" as const;
    }
    tx.update(ref, { state: "paid", entitled: true, paidAt: Date.now(), error: null, grossAmount: gross, paystackFees: fees, amountReceived: received });
    tx.set(db.collection("platform_revenue").doc(reference), {
      reference, type: "compliance_report", orderId, channel: d.channel, userId: d.uid, propertyId: d.propertyId, month: d.month, kind: d.kind,
      grossAmount: gross, paystackFees: fees, netRevenue: received, status: "success",
      createdAt: admin.firestore.FieldValue.serverTimestamp(), paidAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    tx.set(db.collection("platform_stats").doc("totals"), {
      totalComplianceReports: admin.firestore.FieldValue.increment(1),
      totalComplianceReportRevenue: admin.firestore.FieldValue.increment(received),
      lastComplianceReportDate: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return "paid" as const;
  });
  console.log(`Compliance report payment ${reference}: ${outcome}`);
}

/** charge.failed: let the user try again. */
export async function failReportPayment(db: Db, reference: string, reason: unknown): Promise<void> {
  const m = /^CRP_([a-f0-9]{16})_/.exec(reference);
  if (!m) return;
  const ref = reportsCol(db).doc(m[1]);
  await db.runTransaction(async (tx) => {
    const d = (await tx.get(ref)).data();
    if (!d || d.state !== "payment_pending" || d.reference !== reference) return;
    tx.update(ref, { state: "payment_required", error: { code: "CR_PAYMENT_FAILED", message: "The M-Pesa payment was not completed. You can try again." }, failureReason: String(reason ?? "") });
  });
}
