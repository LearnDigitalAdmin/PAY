// KES 99 extra-transcript payments. COMPANY revenue: no desk, no split, the customer pays exactly KES 99.00 and we absorb
// the Paystack fee. Reference prefix LWT_ routes the Paystack webhook here (see the branch added in index.ts).
import axios from "axios";
import * as admin from "firebase-admin";
import { PAYSTACK_API_BASE, PAYSTACK_SECRET_KEY } from "../desk/paystack";
import { EXTRA_TRANSCRIPT_PRICE_KES } from "./constants";
import type { PaystackPort } from "./service";

type Db = admin.firestore.Firestore;
const REQUEST_ID = /^[a-f0-9]{16}$/;

export const paystackPort: PaystackPort = {
  async charge(payload) {
    const res = await axios.post(`${PAYSTACK_API_BASE}/charge`, payload, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY.value()}`, "Content-Type": "application/json" },
      timeout: 20_000,
    });
    if (!res.data?.status) throw new Error(`Paystack error: ${res.data?.message}`);
    return { status: String(res.data.data?.status ?? "pending"), displayText: res.data.data?.display_text ?? null };
  },
  async verify(reference) {
    const res = await axios.get(`${PAYSTACK_API_BASE}/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY.value()}` }, timeout: 15_000,
    });
    const d = res.data?.data;
    if (!d) return null;
    const s = String(d.status);
    return { status: s === "success" ? "success" : s === "failed" || s === "abandoned" || s === "reversed" ? "failed" : "pending", data: d };
  },
};

/** Idempotent. Called by the webhook and by transcriptStatus (when the webhook is late). */
export async function settleTranscriptPayment(db: Db, reference: string, data: Record<string, unknown>, metadata: Record<string, unknown>): Promise<void> {
  const requestId = String(metadata.requestId ?? "");
  if (!REQUEST_ID.test(requestId) || !reference.startsWith(`LWT_${requestId}_`)) {
    console.error(`Landlord Watch: unusable reference/metadata for ${reference}`);
    return;
  }
  const amountKobo = Number(data.amount);
  const gross = amountKobo / 100;
  const fees = data.fees ? Number(data.fees) / 100 : 0;
  const received = data.amount_received ? Number(data.amount_received) / 100 : gross - fees;
  const ref = db.collection("lwTranscripts").doc(requestId);

  const outcome = await db.runTransaction(async (tx) => {
    const d = (await tx.get(ref)).data();
    if (!d) return "missing" as const;
    if (d.state === "paid" || d.state === "generating" || d.state === "ready") return "already" as const;
    if (Math.round(amountKobo) !== EXTRA_TRANSCRIPT_PRICE_KES * 100) {
      tx.update(ref, { state: "failed", error: { code: "LW_PAYMENT_FAILED", message: "The payment amount did not match. Please contact support." } });
      return "mismatch" as const;
    }
    tx.update(ref, { state: "paid", reference, paidAt: Date.now(), error: null, grossAmount: gross, paystackFees: fees, amountReceived: received });
    tx.set(db.collection("platform_revenue").doc(reference), {
      reference, type: "landlord_watch_transcript", requestId, ownerId: d.ownerId, month: d.month,
      grossAmount: gross, paystackFees: fees, netRevenue: received, status: "success",
      createdAt: admin.firestore.FieldValue.serverTimestamp(), paidAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    tx.set(db.collection("platform_stats").doc("totals"), {
      totalLandlordWatchTranscripts: admin.firestore.FieldValue.increment(1),
      totalLandlordWatchRevenue: admin.firestore.FieldValue.increment(received),
      lastLandlordWatchTranscriptDate: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return "paid" as const;
  });
  console.log(`Landlord Watch payment ${reference}: ${outcome}`);
}

/** charge.failed from Paystack: let the user retry. */
export async function failTranscriptPayment(db: Db, reference: string, reason: unknown): Promise<void> {
  const m = /^LWT_([a-f0-9]{16})_/.exec(reference);
  if (!m) return;
  const ref = db.collection("lwTranscripts").doc(m[1]);
  await db.runTransaction(async (tx) => {
    const d = (await tx.get(ref)).data();
    if (!d || d.state !== "payment_pending" || d.reference !== reference) return;
    tx.update(ref, { state: "payment_required", error: { code: "LW_PAYMENT_FAILED", message: "The M-Pesa payment was not completed. You can try again." }, failureReason: String(reason ?? "") });
  });
}
