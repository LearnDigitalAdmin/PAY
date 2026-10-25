// Purpose-bound OTPs for Landlord Watch. Same gateway and rules as the sign-in OTP: 6 digits, 5 minutes, single use,
// 5 wrong tries, 60 s resend cool-down, 5 codes per phone per hour. The SMS goes to the OWNER phone on the property.
import * as crypto from "crypto";
import type * as admin from "firebase-admin";
import { OTP_MAX_ATTEMPTS, OTP_MAX_SENDS_PER_PHONE_PER_HOUR, OTP_RESEND_COOLDOWN_MS, OTP_TTL_MS } from "./constants";
import { LwError } from "./errors";
import { lwHmac, safeEqual } from "./keys";

type Db = admin.firestore.Firestore;
const HOUR = 3_600_000;

export interface OtpDeps {
  sendSms: (phoneE164: string, message: string) => Promise<boolean>;
  now: () => number;
  code: () => string;
}
export const defaultOtpDeps = (sendSms: OtpDeps["sendSms"]): OtpDeps => ({ sendSms, now: Date.now, code: () => String(crypto.randomInt(100000, 1000000)) });

const otpDocId = (actorKey: string, scope: string) => lwHmac("otp-doc", `${actorKey}|${scope}`).slice(0, 40);

export async function sendOtp(
  db: Db,
  p: { actorKey: string; scope: string; ownerPhone: string; phoneKey: string; text: (code: string) => string },
  deps: OtpDeps,
): Promise<{ expiresInSec: number; resendInSec: number }> {
  const ref = db.collection("lwOtp").doc(otpDocId(p.actorKey, p.scope));
  const rateRef = db.collection("lwOtpRate").doc(p.phoneKey);
  const code = deps.code();
  const now = deps.now();

  const verdict = await db.runTransaction(async (tx) => {
    const [cur, rate] = await Promise.all([tx.get(ref), tx.get(rateRef)]);
    const last = Number(cur.data()?.lastSentAt ?? 0);
    if (last && now - last < OTP_RESEND_COOLDOWN_MS) return { retry: Math.ceil((OTP_RESEND_COOLDOWN_MS - (now - last)) / 1000), kind: "cooldown" as const };
    const r = rate.data();
    const windowStart = Number(r?.windowStart ?? 0);
    const inWindow = windowStart && now - windowStart < HOUR;
    const sends = inWindow ? Number(r?.count ?? 0) : 0;
    if (sends >= OTP_MAX_SENDS_PER_PHONE_PER_HOUR) return { retry: Math.ceil((HOUR - (now - windowStart)) / 1000), kind: "rate" as const };
    tx.set(rateRef, { windowStart: inWindow ? windowStart : now, count: sends + 1 });
    tx.set(ref, { codeHash: lwHmac("otp-code", `${p.actorKey}|${p.scope}|${code}`), expiresAt: now + OTP_TTL_MS, attempts: 0, lastSentAt: now, previousLastSentAt: last });
    return null;
  });
  if (verdict?.kind === "cooldown") throw new LwError("LW_OTP_COOLDOWN", "Please wait before asking for another code.", { retryAfterSec: verdict.retry });
  if (verdict?.kind === "rate") throw new LwError("LW_RATE_LIMITED", "Too many codes requested. Try again later.", { retryAfterSec: verdict.retry });

  const sent = await deps.sendSms(p.ownerPhone, p.text(code));
  if (!sent) {
    await ref.delete().catch(() => undefined);
    throw new LwError("LW_SMS_FAILED", "We could not send the code. Please try again in a moment.");
  }
  return { expiresInSec: OTP_TTL_MS / 1000, resendInSec: OTP_RESEND_COOLDOWN_MS / 1000 };
}

export async function verifyOtp(db: Db, p: { actorKey: string; scope: string; code: string }, deps: OtpDeps): Promise<void> {
  const ref = db.collection("lwOtp").doc(otpDocId(p.actorKey, p.scope));
  const now = deps.now();
  const code = String(p.code ?? "").replace(/\s/g, "");

  const outcome = await db.runTransaction(async (tx) => {
    const d = (await tx.get(ref)).data();
    if (!d) return { kind: "expired" as const };
    if (now > Number(d.expiresAt)) { tx.delete(ref); return { kind: "expired" as const }; }
    if (Number(d.attempts) >= OTP_MAX_ATTEMPTS) return { kind: "locked" as const };
    const good = /^\d{6}$/.test(code) && safeEqual(String(d.codeHash), lwHmac("otp-code", `${p.actorKey}|${p.scope}|${code}`));
    if (good) { tx.delete(ref); return { kind: "ok" as const }; }
    const attempts = Number(d.attempts) + 1;
    tx.update(ref, { attempts });
    return attempts >= OTP_MAX_ATTEMPTS ? { kind: "locked" as const } : { kind: "wrong" as const, left: OTP_MAX_ATTEMPTS - attempts };
  });

  if (outcome.kind === "expired") throw new LwError("LW_OTP_EXPIRED", "That code has expired. Please request a new one.");
  if (outcome.kind === "locked") throw new LwError("LW_OTP_LOCKED", "Too many wrong attempts. Please request a new code.");
  if (outcome.kind === "wrong") throw new LwError("LW_OTP_WRONG", "That code is not correct.", { attemptsLeft: outcome.left });
}

export function otpText(lang: "en" | "sw", purpose: "unlock" | "download", code: string): string {
  if (lang === "sw") {
    return purpose === "unlock"
      ? `Landlord Watch: nambari yako ya uthibitisho ni ${code}. Itumie kufungua maelezo ya mali yako. Inaisha baada ya dakika 5. Usimpe mtu yeyote.`
      : `Landlord Watch: nambari yako ya uthibitisho ni ${code}. Itumie kupakua taarifa ya mwezi. Inaisha baada ya dakika 5. Usimpe mtu yeyote.`;
  }
  return purpose === "unlock"
    ? `Landlord Watch: your verification code is ${code}. Use it to unlock your property details. Valid for 5 minutes. Do not share it.`
    : `Landlord Watch: your verification code is ${code}. Use it to download your monthly transcript. Valid for 5 minutes. Do not share it.`;
}
