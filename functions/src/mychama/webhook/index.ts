// TRACK B — the NEW MyChama Paystack webhook (new account, new key, MyChama references only).
// Register this function's URL in the NEW Paystack dashboard (see docs/mychama/cutover.md).
// The legacy `paystackCallback` in ../../index.ts is untouched and keeps serving old-account in-flight payments.
//
// NOTE: ../index.ts does `export * from "./webhook"` — keep ONLY deployable functions exported from here.
import { onRequest } from "firebase-functions/v2/https";
import { REGION, MYCHAMA_PAYSTACK_SECRET_KEY } from "../config";
import { MYCHAMA_HP_SECRETS } from "../sms";
import { dispatchChargeFailed, dispatchChargeSuccess, type PaystackChargeData } from "./dispatch";
import { verifyPaystackSignature } from "./util";

export { reconcileMyChamaIntentsV2 } from "./reconcile";

export const mychamaPaystackCallback = onRequest(
  {
    region: REGION,
    cors: false,
    maxInstances: 10,
    timeoutSeconds: 60,
    // ...MYCHAMA_HP_SECRETS is REQUIRED: the confirmation SMS is sent from inside the handler. The legacy webhook
    // does not bind them, so its confirmation SMS has most likely been failing silently (see contract §9).
    secrets: [MYCHAMA_PAYSTACK_SECRET_KEY, ...MYCHAMA_HP_SECRETS],
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    // Signature is over the RAW bytes — never re-serialise req.body.
    const raw = req.rawBody;
    if (!raw || !verifyPaystackSignature(raw, req.headers["x-paystack-signature"]?.toString(), MYCHAMA_PAYSTACK_SECRET_KEY.value())) {
      console.error("MyChama webhook: invalid or missing signature");
      res.status(400).json({ error: "Invalid signature" });
      return;
    }

    let event: { event?: unknown; data?: PaystackChargeData };
    try {
      event = JSON.parse(raw.toString("utf8"));
    } catch {
      res.status(400).json({ error: "Invalid JSON" });
      return;
    }
    const data: PaystackChargeData = event.data && typeof event.data === "object" ? event.data : {};

    try {
      if (event.event === "charge.success") {
        // Paystack only sends charge.success for successful charges; a contradicting status is ignored defensively.
        if (data.status !== undefined && data.status !== "success") {
          console.warn("MyChama webhook: charge.success with non-success status — ignored");
        } else {
          await dispatchChargeSuccess(data);
        }
      } else if (event.event === "charge.failed") {
        await dispatchChargeFailed(data);
      }
      // every other event type: acknowledged, nothing to do
      res.status(200).json({ received: true });
    } catch (e) {
      // transient (Firestore/network): 500 makes Paystack retry. Handlers are idempotent, so a retry is safe.
      console.error("MyChama webhook: transient error — asking Paystack to retry", (e as Error)?.message);
      res.status(500).json({ error: "Internal error" });
    }
  }
);
