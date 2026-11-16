// One-time codes: "LMM4683" (setup / change) and "LMC7391" (cancel a change). Stored only as an HMAC bound to the record AND the exact terms.
import { sendHpSms } from "../hpSms";
import { toMsisdn } from "../phone/safaricom";
import { LMMX } from "./contract";
import { COL } from "./config";
import { code4, codeHash, randId, safeEq } from "./crypto";
import { fail } from "./errors";
import { audit, col, db, now } from "./store";
import type { OtpDoc } from "./types";

export const otpKey = (tenantId: string, purpose: string, changeId?: string): string => `${tenantId}_${purpose}_${changeId ?? "-"}`;

export interface IssueResult { expiresAt: number; resendsLeft: number }
/** Creates (or replaces) the single active code for this tenant+purpose, texts it, and returns when it expires. A resend invalidates the old code. */
export async function issueOtp(p: { tenantId: string; purpose: "setup" | "change" | "cancel"; changeId?: string; payloadHash: string; phoneE164: string; compose: (c4: string) => string }): Promise<IssueResult> {
  const ref = col(COL.otps).doc(otpKey(p.tenantId, p.purpose, p.changeId));
  const prev = (await ref.get()).data() as OtpDoc | undefined;
  const recent = (prev?.sends ?? []).filter((t) => now() - t < 3_600_000);
  if (recent.length >= LMMX.OTP_RESEND_MAX_PER_HOUR) return fail("LMMX_E_RATE", "Too many codes were sent. Please try again in a while.");
  if ((prev?.totalWrong ?? 0) >= LMMX.OTP_SETUP_TOTAL_ATTEMPTS_MAX) return fail("LMMX_E_OTP_LOCKED", "Too many wrong codes. Ask the top desk for help.");
  const c = code4();
  const id = randId("OTP");
  const doc: OtpDoc & { otpId: string } = {
    otpId: id, tenantId: p.tenantId, purpose: p.purpose, changeId: p.changeId, payloadHash: p.payloadHash, hash: codeHash(id, c, p.payloadHash), expiresAt: now() + LMMX.OTP_TTL_MS,
    attempts: 0, totalWrong: prev?.totalWrong ?? 0, lockedUntil: 0, usedAt: null, sends: [...recent, now()], createdAt: now(),
  };
  const ok = (await sendHpSms({ mobile: toMsisdn(p.phoneE164), message: p.compose(c) })).success;
  if (!ok) return fail("LMMX_E_INTERNAL", "We could not send the SMS. Please try again.");
  await ref.set(JSON.parse(JSON.stringify(doc)));
  return { expiresAt: doc.expiresAt, resendsLeft: LMMX.OTP_RESEND_MAX_PER_HOUR - doc.sends.length };
}

export type OtpVia = "desk" | "bot" | "tenant";
/** Checks a 4-digit code. Throws LMMX_E_OTP_* on any problem (and counts wrong tries); returns on success and burns the code. */
export async function verifyOtp(p: { tenantId: string; purpose: "setup" | "change" | "cancel"; changeId?: string; input: string; expectedPayloadHash: string; via: OtpVia; actorDesk?: string }): Promise<void> {
  const ref = col(COL.otps).doc(otpKey(p.tenantId, p.purpose, p.changeId));
  const input = String(p.input ?? "").replace(/\D/g, "").slice(-4);
  type Out = "ok" | "wrong" | "expired" | "locked" | "none";
  const o: { v: Out } = { v: "none" };
  await db().runTransaction(async (tx) => {
    const d = (await tx.get(ref)).data() as (OtpDoc & { otpId: string }) | undefined;
    if (!d || d.usedAt) { o.v = "none"; return; }
    if (d.lockedUntil > now() || d.totalWrong >= LMMX.OTP_SETUP_TOTAL_ATTEMPTS_MAX) { o.v = "locked"; return; }
    if (d.expiresAt < now()) { o.v = "expired"; return; }
    const good = input.length === 4 && safeEq(d.payloadHash, p.expectedPayloadHash) && safeEq(d.hash, codeHash(d.otpId, input, d.payloadHash));
    if (good) { tx.update(ref, { usedAt: now() }); o.v = "ok"; return; }
    const attempts = d.attempts + 1;
    tx.update(ref, { attempts, totalWrong: d.totalWrong + 1, ...(attempts >= LMMX.OTP_MAX_ATTEMPTS ? { lockedUntil: now() + LMMX.OTP_LOCK_MS, attempts: 0 } : {}) });
    o.v = "wrong";
  });
  const outcome = o.v;
  if (outcome === "ok") return;
  if (outcome === "wrong" || outcome === "locked") await audit({ action: p.purpose === "setup" ? "setup_otp_failed" : "change_otp_failed", actor: { type: p.via === "desk" ? "desk" : p.via === "bot" ? "bot" : "tenant", deskCode: p.actorDesk }, tenantId: p.tenantId, summary: `${p.purpose} code ${outcome} via ${p.via}` });
  if (outcome === "locked") return fail("LMMX_E_OTP_LOCKED", "Too many wrong codes. Try again later.");
  if (outcome === "expired") return fail("LMMX_E_OTP_EXPIRED", "That code has expired. Ask for a new one.");
  return fail("LMMX_E_OTP_INVALID", "That code is not right.");
}
export async function otpState(tenantId: string, purpose: "setup" | "change", changeId?: string): Promise<{ expiresAt?: number; attemptsLeft?: number; locked?: boolean; resendsLeft?: number }> {
  const d = (await col(COL.otps).doc(otpKey(tenantId, purpose, changeId)).get()).data() as OtpDoc | undefined;
  if (!d || d.usedAt) return {};
  const recent = d.sends.filter((t) => now() - t < 3_600_000).length;
  return { expiresAt: d.expiresAt, attemptsLeft: Math.max(0, LMMX.OTP_MAX_ATTEMPTS - d.attempts), locked: d.lockedUntil > now() || d.totalWrong >= LMMX.OTP_SETUP_TOTAL_ATTEMPTS_MAX, resendsLeft: Math.max(0, LMMX.OTP_RESEND_MAX_PER_HOUR - recent) };
}
