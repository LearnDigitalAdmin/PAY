// TRACK B — missed-webhook sweep for the NEW Paystack account.
//
// Same logic as the legacy `reconcileMyChamaIntents` in ../../index.ts (pending > 5 min, /transaction/verify,
// apply through the SAME transactional handler, failed/expired handling, 404 + > 1 h => expired) but it verifies
// with MYCHAMA_PAYSTACK_SECRET_KEY and binds the HostPinnacle secrets.
//
// The two sweeps must never fight over one intent: THIS sweep only acts on intents created at/after the cutover
// timestamp stored in the plot project at  mychamaConfig/cutover { cutoverAt: <epoch ms> }  (see cutover.md).
// While that doc is missing this sweep does nothing. The legacy sweep keeps everything else until it is deleted.
import axios from "axios";
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as admin from "firebase-admin";
import { MYCHAMA_PAYSTACK_SECRET_KEY, mychamaDb, plotDb } from "../config";
import { MYCHAMA_HP_SECRETS } from "../sms";
import { PAYSTACK_API_BASE } from "../pay/paystack";
import { handleMyChamaPayment } from "./handlers";

export const CUTOVER_DOC = "mychamaConfig/cutover";
const FIVE_MIN = 5 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

/** Moves a still-`pending` doc to a terminal status; never overwrites success/failed/expired. */
async function setIfPending(ref: admin.firestore.DocumentReference, patch: Record<string, unknown>): Promise<void> {
  await mychamaDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists && snap.data()?.status === "pending") tx.update(ref, { ...patch, updatedAt: Date.now() });
  });
}

export const reconcileMyChamaIntentsV2 = onSchedule(
  {
    schedule: "every 10 minutes",
    timeZone: "Africa/Nairobi",
    region: "us-central1",
    memory: "256MiB",
    timeoutSeconds: 300,
    secrets: [MYCHAMA_PAYSTACK_SECRET_KEY, ...MYCHAMA_HP_SECRETS],
  },
  async () => {
    const cutoverAt = Number((await plotDb().doc(CUTOVER_DOC).get()).data()?.cutoverAt);
    if (!Number.isFinite(cutoverAt) || cutoverAt <= 0) {
      console.log("MyChama reconcile V2: no cutover timestamp yet — nothing to do");
      return;
    }

    const db2 = mychamaDb();
    const now = Date.now();
    const snap = await db2.collectionGroup("paymentIntents").where("status", "==", "pending").limit(200).get();

    for (const doc of snap.docs) {
      const intent = doc.data();
      const createdAt = Number(intent.createdAt) || 0;
      const age = now - createdAt;
      const reference = doc.id;
      if (createdAt < cutoverAt) continue;                       // legacy sweep's territory
      if (intent.applyBlockedAt) continue;                       // a permanent mismatch is waiting for a human
      if (age < FIVE_MIN) continue;                              // give the webhook a chance first
      if (!reference.startsWith("MCW-") && !reference.startsWith("MCA-")) continue;
      const chamaId = doc.ref.parent.parent?.id;
      if (!chamaId) continue;

      try {
        const res = await axios.get(`${PAYSTACK_API_BASE}/transaction/verify/${encodeURIComponent(reference)}`, {
          headers: { Authorization: `Bearer ${MYCHAMA_PAYSTACK_SECRET_KEY.value()}` },
          timeout: 15000,
        });
        const tData = res.data?.data;
        const status = tData?.status;

        if (status === "success") {
          console.log(`MyChama reconcile V2: applying missed payment ${reference}`);
          await handleMyChamaPayment(reference, chamaId, tData.amount, tData.currency);
        } else if (status === "failed" || status === "reversed") {
          await setIfPending(doc.ref, { status: "failed", paystackMessage: tData?.gateway_response || status });
        } else if (age > ONE_HOUR) {
          // Never confirmed within the hour — the member never entered a PIN.
          await setIfPending(doc.ref, { status: "expired" });
        }
      } catch (e: any) {
        console.error(`MyChama reconcile V2: verify failed for ${reference}`, e?.message || e);
        // Paystack has no record of it and it is over an hour old: the STK prompt never became a charge.
        if (e?.response?.status === 404 && age > ONE_HOUR) await setIfPending(doc.ref, { status: "expired" });
      }
    }
  }
);
