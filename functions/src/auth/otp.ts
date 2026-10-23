// Phone OTP login via HostPinnacle (replaces Firebase/Google phone auth + reCAPTCHA + Google SMS billing).
//
//   sendLoginOtp({ phone })        -> generates a 6-digit code, stores ONLY its keyed hash, SMSes it from OUR
//                                     HostPinnacle pool (nobody is charged; no tenant/agent SMS tokens are touched).
//   verifyLoginOtp({ phone, code }) -> checks the code (single use, 5 min, 5 tries), finds-or-creates the Firebase
//                                     Auth user for that phone and returns a custom token. The client then calls
//                                     signInWithCustomToken(), so everything downstream (Firestore rules keyed on
//                                     request.auth.uid, agentSyncClaims, tenants/{uid}) keeps working.
//
// uid continuity: existing people signed in with Firebase phone auth, so their Auth record already has this
// phoneNumber. We look the user up BY PHONE and reuse that uid — nobody gets a second account.
//
// Abuse / cost protection (every SMS costs us money): Kenyan mobiles only, 60s resend cooldown, 5 codes per phone
// per hour, 20 codes per IP per hour, global daily cap, 5 wrong guesses kills the code.
//
// Secrets: nothing new to set. HostPinnacle uses the existing MYCHAMA_HP_SMS_* secrets (MYCHAMA_HP_SECRETS) and
// hashing uses the existing MYCHAMA_ID_PEPPER (domain-separated labels, read-only use).
// Also required: roles/iam.serviceAccountTokenCreator on the functions' runtime service account (createCustomToken).
import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import * as crypto from "crypto";
import { REGION, normalizeKePhone, plotDb, MYCHAMA_ID_PEPPER } from "../mychama/config";
import { MYCHAMA_HP_SECRETS, sendHpSmsChecked } from "../mychama/sms";
import { checkSafaricomPhone } from "../phone/safaricom";

const OTP_SECRETS = [MYCHAMA_ID_PEPPER, ...MYCHAMA_HP_SECRETS];

const KE_MOBILE = /^\+254[17]\d{8}$/;
const COLLECTION = "authOtp";                 // server-only: no client rule should ever allow access
const OTP_TTL_MS = 5 * 60_000;
const RESEND_COOLDOWN_MS = 60_000;
const MAX_VERIFY_ATTEMPTS = 5;
const MAX_SENDS_PER_PHONE_PER_HOUR = 5;
const MAX_SENDS_PER_IP_PER_HOUR = 20;
const MAX_SENDS_PER_DAY = 3000;               // global safety valve on the HostPinnacle pool
const HOUR_MS = 3_600_000;

export interface SendOtpResponse { ok: true; expiresInSec: number; resendInSec: number }
export interface VerifyOtpResponse { token: string }

function hmac(label: string, value: string): string {
  return crypto.createHmac("sha256", MYCHAMA_ID_PEPPER.value()).update(`auth-otp:${label}:${value}`).digest("hex");
}

function cleanPhone(raw: unknown): string {
  const check = checkSafaricomPhone(raw);
  if (!check.ok) throw new HttpsError("invalid-argument", check.message);
  const phone = normalizeKePhone(check.e164);
  if (!KE_MOBILE.test(phone)) throw new HttpsError("invalid-argument", "Enter a valid Safaricom number, for example 0712 345 678.");
  return phone;
}

function callerIp(req: { rawRequest?: { headers?: Record<string, unknown>; ip?: string } }): string {
  const fwd = req.rawRequest?.headers?.["x-forwarded-for"];
  const first = typeof fwd === "string" ? fwd.split(",")[0].trim() : "";
  return first || req.rawRequest?.ip || "unknown";
}

export const sendLoginOtp = onCall(
  { region: REGION, cors: true, maxInstances: 20, secrets: OTP_SECRETS },
  async (req): Promise<SendOtpResponse> => {
    const phone = cleanPhone(req.data?.phone);
    const db = plotDb();
    const now = Date.now();
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");

    const chRef = db.collection(COLLECTION).doc(`ch_${hmac("ph", phone)}`);
    const ipRef = db.collection(COLLECTION).doc(`ip_${hmac("ip", callerIp(req)).slice(0, 32)}_${Math.floor(now / HOUR_MS)}`);
    const dayRef = db.collection(COLLECTION).doc(`day_${new Date(now).toISOString().slice(0, 10)}`);

    await db.runTransaction(async (tx) => {
      const [ch, ip, day] = await Promise.all([tx.get(chRef), tx.get(ipRef), tx.get(dayRef)]);
      const c = ch.data() || {};

      const wait = Math.ceil(((c.lastSentAt || 0) + RESEND_COOLDOWN_MS - now) / 1000);
      if (wait > 0) throw new HttpsError("resource-exhausted", `Please wait ${wait}s before requesting another code.`);

      const windowFresh = now - (c.windowStart || 0) < HOUR_MS;
      const windowCount = windowFresh ? (c.windowCount || 0) : 0;
      if (windowCount >= MAX_SENDS_PER_PHONE_PER_HOUR) {
        throw new HttpsError("resource-exhausted", "Too many codes requested for this number. Please try again in an hour.");
      }
      if ((ip.data()?.count || 0) >= MAX_SENDS_PER_IP_PER_HOUR) {
        throw new HttpsError("resource-exhausted", "Too many requests. Please try again later.");
      }
      if ((day.data()?.count || 0) >= MAX_SENDS_PER_DAY) {
        throw new HttpsError("unavailable", "Verification is temporarily unavailable. Please try again later.");
      }

      tx.set(chRef, {
        codeHash: hmac("otp", `${phone}:${code}`),
        expiresAt: now + OTP_TTL_MS,
        attempts: 0,
        lastSentAt: now,
        windowStart: windowFresh ? c.windowStart : now,
        windowCount: windowCount + 1,
      });
      tx.set(ipRef, { count: admin.firestore.FieldValue.increment(1), expireAt: new Date(now + 2 * HOUR_MS) }, { merge: true });
      tx.set(dayRef, { count: admin.firestore.FieldValue.increment(1) }, { merge: true });
    });

    const sent = await sendHpSmsChecked(
      phone,
      `Your Samuhia Payments verification code is ${code}. It expires in 5 minutes. Never share this code with anyone.`
    );
    if (!sent) {
      // Nothing reached the phone: invalidate the code and lift the cooldown so the person can retry at once.
      await chRef.set({ codeHash: null, lastSentAt: 0 }, { merge: true });
      throw new HttpsError("unavailable", "We could not send the SMS right now. Please try again in a moment.");
    }
    return { ok: true, expiresInSec: OTP_TTL_MS / 1000, resendInSec: RESEND_COOLDOWN_MS / 1000 };
  }
);

type Check = { ok: true } | { ok: false; reason: "none" | "expired" | "locked" | "wrong"; left?: number };

export const verifyLoginOtp = onCall(
  { region: REGION, cors: true, maxInstances: 20, secrets: OTP_SECRETS },
  async (req): Promise<VerifyOtpResponse> => {
    const phone = cleanPhone(req.data?.phone);
    const code = String(req.data?.code ?? "").replace(/\D/g, "");
    if (code.length !== 6) throw new HttpsError("invalid-argument", "Enter the 6-digit code.");

    const db = plotDb();
    const now = Date.now();
    const chRef = db.collection(COLLECTION).doc(`ch_${hmac("ph", phone)}`);

    // Outcome is returned (not thrown) from the transaction so the attempt counter is committed even on a miss.
    const check: Check = await db.runTransaction(async (tx) => {
      const snap = await tx.get(chRef);
      const c = snap.data();
      if (!c || !c.codeHash) return { ok: false, reason: "none" } as Check;
      if (c.expiresAt < now) { tx.update(chRef, { codeHash: null }); return { ok: false, reason: "expired" } as Check; }
      if (c.attempts >= MAX_VERIFY_ATTEMPTS) { tx.update(chRef, { codeHash: null }); return { ok: false, reason: "locked" } as Check; }

      const given = Buffer.from(hmac("otp", `${phone}:${code}`), "hex");
      const stored = Buffer.from(String(c.codeHash), "hex");
      if (given.length === stored.length && crypto.timingSafeEqual(given, stored)) {
        tx.update(chRef, { codeHash: null, attempts: 0 });   // single use
        return { ok: true } as Check;
      }
      const attempts = c.attempts + 1;
      tx.update(chRef, { attempts, ...(attempts >= MAX_VERIFY_ATTEMPTS ? { codeHash: null } : {}) });
      return { ok: false, reason: attempts >= MAX_VERIFY_ATTEMPTS ? "locked" : "wrong", left: MAX_VERIFY_ATTEMPTS - attempts } as Check;
    });

    if (!check.ok) {
      switch (check.reason) {
        case "wrong": throw new HttpsError("permission-denied", `Incorrect code. ${check.left} attempt${check.left === 1 ? "" : "s"} left.`);
        case "locked": throw new HttpsError("permission-denied", "Too many incorrect attempts. Please request a new code.");
        case "expired": throw new HttpsError("deadline-exceeded", "That code has expired. Please request a new one.");
        default: throw new HttpsError("failed-precondition", "No active code for this number. Please request a new one.");
      }
    }

    // Phone proven. Reuse the existing Auth user for this phone (keeps uid, tenants/{uid}, claims) or create one.
    const authAdmin = admin.auth();
    let user: admin.auth.UserRecord;
    try {
      user = await authAdmin.getUserByPhoneNumber(phone);
    } catch (e) {
      if ((e as { code?: string }).code !== "auth/user-not-found") throw e;
      try {
        user = await authAdmin.createUser({ phoneNumber: phone });
      } catch (e2) {
        if ((e2 as { code?: string }).code !== "auth/phone-number-already-exists") throw e2;
        user = await authAdmin.getUserByPhoneNumber(phone);   // lost a creation race: use the winner
      }
    }
    if (user.disabled) throw new HttpsError("permission-denied", "This account has been disabled. Please contact support.");

    // otp_phone: signed proof that THIS session verified this phone (custom-token sign-ins carry no built-in
    // phone_number claim). Read by agentSyncClaims, resolveCaller and the UI session.
    const token = await authAdmin.createCustomToken(user.uid, { otp_phone: phone });
    return { token };
  }
);
