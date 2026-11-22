// Shared HostPinnacle delivery tracking. Importing this module (from src/index.ts) installs the tracker into sendHpSms, so EVERY
// product that sends through hpSms.ts is tracked with no code change; products that want to react to delivery reports call
// registerSmsProduct(product, handler) and tag sends with track: { product, ref }.
import { onRequest } from "firebase-functions/v2/https";
import { setDispatchTracker } from "../hpSms";
import { plotDb } from "../mychama/config";
import { MYCHAMA_REGION } from "../mychama/contract";
import { BUNDLE_SECRETS, bundleSecret } from "../secretsBundle";
import { recordDispatch, type RecordArgs } from "./dispatch";
import { handleHpWebhook } from "./webhook";

export { registerSmsProduct } from "./registry";
/** Add key HP_WEBHOOK_TOKEN to the app-secrets-bundle JSON (a long random string). */
const HP_WEBHOOK_TOKEN = bundleSecret("HP_WEBHOOK_TOKEN");

/** For senders that do not go through hpSms.ts (e.g. MyChama's own HostPinnacle account). Never throws. */
export async function trackDispatch(a: RecordArgs): Promise<string[]> {
  try { return await recordDispatch(plotDb(), a); } catch (e) { console.error("trackDispatch failed:", (e as Error).message); return []; }
}
setDispatchTracker(trackDispatch);

/** Callback URL for the HostPinnacle portal: https://<function-url>/?t=<HP_WEBHOOK_TOKEN>  (GET or POST). */
export const hpSmsWebhook = onRequest({ region: MYCHAMA_REGION, secrets: BUNDLE_SECRETS, maxInstances: 5, timeoutSeconds: 30, cors: false }, async (req, res) => {
  try {
    const r = await handleHpWebhook(plotDb(), { method: req.method, query: req.query as Record<string, unknown>, body: req.body, headers: req.headers as Record<string, unknown> }, HP_WEBHOOK_TOKEN.value());
    res.status(r.status).type("text/plain").send(r.body);
  } catch (e) { console.error("hpSmsWebhook fatal:", (e as Error).message); res.status(500).send("error"); }
});
