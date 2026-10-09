// TRACK B — owns this directory. Stub from P0: the real handler verifies the
// x-paystack-signature HMAC with MYCHAMA_PAYSTACK_SECRET_KEY and applies MyChama
// references only via ./handlers (shared with the legacy webhook in index.ts).
import { onRequest } from "firebase-functions/v2/https";
import { REGION, MYCHAMA_PAYSTACK_SECRET_KEY } from "../config";
import { MYCHAMA_HP_SECRETS } from "../sms";

export const mychamaPaystackCallback = onRequest(
  { region: REGION, cors: false, maxInstances: 10, timeoutSeconds: 60, secrets: [MYCHAMA_PAYSTACK_SECRET_KEY, ...MYCHAMA_HP_SECRETS] },
  async (_req, res) => {
    // P0 stub: acknowledge nothing, apply nothing. Track B replaces this.
    res.status(501).json({ error: "not_implemented" });
  }
);
