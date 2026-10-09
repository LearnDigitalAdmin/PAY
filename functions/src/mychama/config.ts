import * as admin from "firebase-admin";
import * as crypto from "crypto";
import { defineSecret } from "firebase-functions/params";
import { MYCHAMA_REGION } from "./contract";

export const REGION = MYCHAMA_REGION;

// ─── Secrets (declare ONCE here; bind per-function via `secrets: [...]`) ───
/** The NEW Paystack account's secret key. Used ONLY by MyChama code paths. */
export const MYCHAMA_PAYSTACK_SECRET_KEY = defineSecret("MYCHAMA_PAYSTACK_SECRET_KEY");
/** HMAC pepper for idKey/phoneKey. MUST be the identical value in mychama1 (Python side). */
export const MYCHAMA_ID_PEPPER = defineSecret("MYCHAMA_ID_PEPPER");
// HostPinnacle SMS secrets live in ./sms.ts (MYCHAMA_HP_SECRETS).

// ─── Firestore handles ───
const MYCHAMA_PROJECT_ID = "mychama1";
const MYCHAMA_APP_NAME = "mychama";   // same app name index.ts used — one shared instance
let mychamaDbCached: admin.firestore.Firestore | null = null;

/** mychama1 Firestore via IAM (default service account); no JSON key. Lazy + idempotent. */
export function mychamaDb(): admin.firestore.Firestore {
  if (mychamaDbCached) return mychamaDbCached;
  const existing = admin.apps.find((a) => a && a.name === MYCHAMA_APP_NAME);
  const mychamaApp = existing || admin.initializeApp(
    { credential: admin.credential.applicationDefault(), projectId: MYCHAMA_PROJECT_ID },
    MYCHAMA_APP_NAME
  );
  mychamaDbCached = mychamaApp.firestore();
  mychamaDbCached.settings({ ignoreUndefinedProperties: true });
  return mychamaDbCached;
}

/** plot (this project's default) Firestore. */
export function plotDb(): admin.firestore.Firestore {
  if (!admin.apps.length) admin.initializeApp();
  return admin.firestore();
}

// ─── Identity normalisation (CROSS-REPO CONTRACT — mirror in mychama1) ───
/** trim, uppercase, drop every non-alphanumeric. "12 345-678" -> "12345678". */
export function normalizeIdNumber(raw: string): string {
  return (raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Mirrors Chama functions/shared/phone.py::normalize_phone. Returns "" when unusable. */
export function normalizeKePhone(raw: string): string {
  const digits = (raw || "").replace(/\D/g, "");
  if (/^254[17]\d{8}$/.test(digits)) return "+" + digits;
  if (/^0[17]\d{8}$/.test(digits)) return "+254" + digits.slice(1);
  if (/^[17]\d{8}$/.test(digits)) return "+254" + digits;
  return digits ? "+" + digits : "";
}

function hmacHex(value: string): string {
  return crypto.createHmac("sha256", MYCHAMA_ID_PEPPER.value()).update(value).digest("hex");
}
/** idKey stored on mychama1 member docs as `idKey`. Bind MYCHAMA_ID_PEPPER to any function calling this. */
export function computeIdKey(rawIdNumber: string): string {
  const n = normalizeIdNumber(rawIdNumber);
  return n ? hmacHex("id:" + n) : "";
}
/** Phone proof key stored on links (`boundPhoneKey`). Input must be E.164 (normalizeKePhone). */
export function computePhoneKey(e164: string): string {
  return e164 ? hmacHex("ph:" + e164) : "";
}
/** "+254712345123" -> "07•• ••• 123" */
export function maskPhone(e164: string): string {
  const digits = (e164 || "").replace(/\D/g, "");
  const local = digits.startsWith("254") ? "0" + digits.slice(3) : digits;
  return local.length >= 6 ? `${local.slice(0, 2)}•• ••• ${local.slice(-3)}` : "•••";
}
