// MyChama's HostPinnacle SMS sender. OWNED BY P0 (shared by Track A's linking
// codes and Track B's payment-confirmation SMS) — moved verbatim from
// index.ts; behaviour is unchanged.
//
// ANY Cloud Function that calls sendMyChamaSms() MUST list
// ...MYCHAMA_HP_SECRETS in its `secrets: [...]`, otherwise .value() is empty
// at runtime and the SMS silently fails (the legacy paystackCallback does not
// bind them today — see docs/mychama/CONNECTOR_CONTRACT.md §9).
import { defineSecret } from "firebase-functions/params";
import axios from "axios";

// MyChama's own HostPinnacle credentials — separate from PAY's shared
// SMS_CONFIG so MyChama's sender ID/branding never gets mixed with another
// product's. Set with:
//   firebase functions:secrets:set MYCHAMA_HP_SMS_USERID (and _PASSWORD/_APIKEY/_SENDERID)
const MYCHAMA_HP_USERID = defineSecret("MYCHAMA_HP_SMS_USERID");
const MYCHAMA_HP_PASSWORD = defineSecret("MYCHAMA_HP_SMS_PASSWORD");
const MYCHAMA_HP_APIKEY = defineSecret("MYCHAMA_HP_SMS_APIKEY");
const MYCHAMA_HP_SENDERID = defineSecret("MYCHAMA_HP_SMS_SENDERID");

export async function sendMyChamaSms(phoneE164: string, message: string): Promise<void> {
  await axios.post("https://smsportal.hostpinnacle.co.ke/SMSApi/send", {
    userid: MYCHAMA_HP_USERID.value(),
    password: MYCHAMA_HP_PASSWORD.value(),
    apikey: MYCHAMA_HP_APIKEY.value(),
    senderid: MYCHAMA_HP_SENDERID.value(),
    mobile: phoneE164.replace(/^\+/, ""),
    msg: message.slice(0, 400),
    sendMethod: "quick",
    msgType: "text",
    output: "json",
    duplicatecheck: "true",
  });
}

/**
 * Same HostPinnacle account/secrets, but REPORTS failure (returns false) instead of silently succeeding.
 * Used for login OTPs, where an SMS that never left must not look "sent". Bind ...MYCHAMA_HP_SECRETS.
 */
export async function sendHpSmsChecked(phoneE164: string, message: string): Promise<boolean> {
  try {
    const params = new URLSearchParams({
      userid: MYCHAMA_HP_USERID.value(),
      password: MYCHAMA_HP_PASSWORD.value(),
      senderid: MYCHAMA_HP_SENDERID.value(),
      sendMethod: "quick",
      mobile: phoneE164.replace(/^\+/, ""),
      msg: message.slice(0, 400),
      msgType: "text",
      duplicatecheck: "false",
      output: "json",
    });
    const res = await axios.post("https://smsportal.hostpinnacle.co.ke/SMSApi/send", params.toString(), {
      headers: { apikey: MYCHAMA_HP_APIKEY.value(), "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 10_000,
    });
    const d = res.data;
    const isError = d?.status === "error" || d?.ErrorCode !== undefined ||
      (typeof d?.status === "string" && d.status.toLowerCase().includes("fail"));
    if (isError) console.error("HostPinnacle rejected the send:", JSON.stringify(d));
    return !isError;
  } catch (e) {
    console.error("HostPinnacle request failed:", (e as Error).message);
    return false;
  }
}

export const MYCHAMA_HP_SECRETS = [
  MYCHAMA_HP_USERID,
  MYCHAMA_HP_PASSWORD,
  MYCHAMA_HP_APIKEY,
  MYCHAMA_HP_SENDERID,
];
