// ONE place for HostPinnacle credentials and sending. Credentials come ONLY from Firebase secrets (Secret Manager); nothing reads
// process.env or a .env file. A secret's .value() is empty unless the function lists it, so EVERY function that can send an SMS
// (directly or through a helper) must include ...HP_SECRETS in its `secrets: [...]`.
//   firebase functions:secrets:set HP_SMS_USERID   (and HP_SMS_PASSWORD / HP_SMS_APIKEY / HP_SMS_SENDERID)
import axios from "axios";
import { defineSecret } from "firebase-functions/params";

export const HP_SMS_USERID = defineSecret("HP_SMS_USERID");
export const HP_SMS_PASSWORD = defineSecret("HP_SMS_PASSWORD");
export const HP_SMS_APIKEY = defineSecret("HP_SMS_APIKEY");
export const HP_SMS_SENDERID = defineSecret("HP_SMS_SENDERID");

/** Bind on any function that sends SMS: `secrets: [...HP_SECRETS]`. */
export const HP_SECRETS = [HP_SMS_USERID, HP_SMS_PASSWORD, HP_SMS_APIKEY, HP_SMS_SENDERID];

export const HP_SMS_API_URL = "https://smsportal.hostpinnacle.co.ke/SMSApi/send";

export interface HpSmsOptions {
  /** Single number OR comma-separated list, e.g. "254700000001,254700000002" */
  mobile: string;
  message: string;
  /** Override the default sender ID. */
  senderId?: string;
  /** Duplicate suppression; default true. */
  duplicateCheck?: boolean;
}
export interface HpSmsResult { success: boolean; raw?: any; error?: string }

/** Never throws. Logs loudly when a secret is missing, so "no SMS" is never silent again. */
export async function sendHpSms(opts: HpSmsOptions): Promise<HpSmsResult> {
  try {
    const userid = HP_SMS_USERID.value();
    const apikey = HP_SMS_APIKEY.value();
    if (!userid || !apikey) {
      console.error("HostPinnacle SMS NOT SENT: secrets HP_SMS_USERID / HP_SMS_APIKEY are empty. Bind ...HP_SECRETS on this function and set the secrets.");
      return { success: false, error: "SMS credentials not configured" };
    }
    const params = new URLSearchParams({
      userid, password: HP_SMS_PASSWORD.value() || "", sendMethod: "quick", mobile: opts.mobile, msg: opts.message,
      senderid: opts.senderId || HP_SMS_SENDERID.value() || "", msgType: "text",
      duplicatecheck: opts.duplicateCheck === false ? "false" : "true", output: "json",
    });
    const res = await axios.post(HP_SMS_API_URL, params.toString(), {
      headers: { apikey, "Content-Type": "application/x-www-form-urlencoded" }, timeout: 10_000,
    });
    const d = res.data;
    console.log(`HostPinnacle SMS response for ${opts.mobile}:`, JSON.stringify(d));
    const isError = d?.status === "error" || d?.ErrorCode !== undefined || (typeof d?.status === "string" && d.status.toLowerCase().includes("fail"));
    return isError ? { success: false, raw: d, error: d?.message || "API error" } : { success: true, raw: d };
  } catch (err: any) {
    const msg = err?.response?.data ? JSON.stringify(err.response.data) : err?.message;
    console.error(`HostPinnacle SMS send error for ${opts.mobile}:`, msg);
    return { success: false, error: msg };
  }
}
