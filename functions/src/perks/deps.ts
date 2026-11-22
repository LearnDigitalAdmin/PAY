// THE ONLY FILE in perks/ that imports from the rest of PAY/functions.
// To move Perks into its own codebase, re-implement these exports (Firestore handle, region, secrets binding, SMS sender)
// and copy the folder. Nothing else here depends on PAY. tests/perks.check.js enforces this boundary.
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";
import { plotDb } from "../mychama/config";
import { MYCHAMA_REGION } from "../mychama/contract";
import { HP_SECRETS, sendHpSms } from "../hpSms";
import { registerSmsProduct } from "../sms/registry";
import { perksDlr } from "./dlr";

export { HttpsError };
export const REGION = MYCHAMA_REGION;
/** Bind on every Perks function that can send SMS. Credentials: the shared HP_SMS_* secrets in app-secrets-bundle. */
export const SECRETS = HP_SECRETS;
export const db = (): admin.firestore.Firestore => plotDb();
export const sendSms = async (e164: string, message: string, link?: { ref: string }): Promise<{ success: boolean; error?: string; providerId?: string }> => {
  const r = await sendHpSms({ mobile: e164.replace(/^\+/, ""), message, track: { product: "perks", ref: link?.ref } });
  return { success: r.success, error: r.error, providerId: (r.providerIds || [])[0] };
};
// Delivery reports for sends tagged product "perks" update perks_smsLog (see ./dlr.ts). Webhook itself lives in ../sms.
registerSmsProduct("perks", (ev, d) => perksDlr(db(), ev, d));
