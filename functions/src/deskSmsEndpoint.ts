// Private function MyRegister calls to plan the desk part of a school SMS top-up. Auth is Cloud Run IAM only
// (invoker: "private"): the MyRegister runtime service account must hold roles/run.invoker on this function.
import { onRequest } from "firebase-functions/v2/https";

import { handleDeskSmsRequest } from "./desk/smsRequest";
import { BUNDLE_SECRETS } from "./secretsBundle";

export const deskSmsCommission = onRequest({
  region: "africa-south1", invoker: "private", cors: false, memory: "256MiB", timeoutSeconds: 30, maxInstances: 3,
  secrets: BUNDLE_SECRETS,
}, async (req, res) => {
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  try {
    const out = await handleDeskSmsRequest(req.body);
    res.status(out.status).json(out.body);
  } catch (err) {
    // Register treats any non-200 as "no desk split" and charges normally, so a desk fault never blocks a payment.
    console.error("deskSmsCommission failed:", (err as Error)?.message);
    res.status(500).json({ error: "internal" });
  }
});
