// SMS-code challenge for proving a MyChama-registered phone. Tap-to-send (never automatic), one live
// challenge per (user, pending group), codes stored only as HMACs, attempt/send limits, no phone or ID
// ever returned in full. Collections are server-only (see docs/mychama/firestore.rules.fragment).
import { HttpsError } from "firebase-functions/v2/https";
import { MYCHAMA_LIMITS, MYCHAMA_PATHS, type RequestCodeResponse } from "../contract";
import { plotDb } from "../config";
import { myChamaError } from "../errors";
import { sendMyChamaSms } from "../sms";
import { eatDateIso } from "../sync/dates";
import type { Caller } from "../sync/identity";
import { counterId, challengeIdFor, hashCode, randomCode, safeEqualHex } from "./crypto";
import { planLinkPass, pendingViews } from "./engine";

const L = MYCHAMA_LIMITS;

export async function requestCode(caller: Caller, pendingId: string): Promise<RequestCodeResponse> {
  if (!pendingId) throw myChamaError("invalid_target", "Unknown verification request.", "invalid-argument");

  const plan = await planLinkPass(caller);
  const view = pendingViews(caller.uid, plan.actions).find((p) => p.pendingId === pendingId);
  if (!view) throw myChamaError("invalid_target", "Unknown verification request.", "invalid-argument");

  const db = plotDb();
  const now = Date.now();
  const day = eatDateIso(now).replace(/-/g, "");
  const challengeId = challengeIdFor(caller.uid, pendingId);
  const chRef = db.doc(MYCHAMA_PATHS.challenge(challengeId));
  const userCtr = db.doc(MYCHAMA_PATHS.challenge(`lim_u_${counterId("u", caller.uid)}_${day}`));
  const phoneCtr = db.doc(MYCHAMA_PATHS.challenge(`lim_p_${counterId("p", view.phoneKey)}_${day}`));

  const code = randomCode(L.CODE_LENGTH);
  const expiresAt = now + L.CODE_TTL_SECONDS * 1000;

  await db.runTransaction(async (tx) => {
    const [ch, uc, pc] = await Promise.all([tx.get(chRef), tx.get(userCtr), tx.get(phoneCtr)]);
    const last = ch.exists ? Number(ch.data()?.lastSentAt || 0) : 0;
    if (last && now - last < L.CODE_RESEND_COOLDOWN_SECONDS * 1000) {
      throw myChamaError("rate_limited", "Please wait before requesting another code.", "resource-exhausted", Math.ceil((L.CODE_RESEND_COOLDOWN_SECONDS * 1000 - (now - last)) / 1000));
    }
    if (Number(uc.data()?.count || 0) >= L.CODE_MAX_SENDS_PER_USER_PER_DAY || Number(pc.data()?.count || 0) >= L.CODE_MAX_SENDS_PER_PHONE_PER_DAY) {
      throw myChamaError("send_limit_reached", "Too many codes requested today. Try again tomorrow.", "resource-exhausted");
    }
    tx.set(userCtr, { count: Number(uc.data()?.count || 0) + 1, day, updatedAt: now });
    tx.set(phoneCtr, { count: Number(pc.data()?.count || 0) + 1, day, updatedAt: now });
    tx.set(chRef, {
      uid: caller.uid, phoneKey: view.phoneKey, codeHash: hashCode(challengeId, code),
      expiresAt, attempts: 0, lastSentAt: now, createdAt: ch.exists ? Number(ch.data()?.createdAt || now) : now,
    });
  });

  try {
    await sendMyChamaSms(view.phoneE164, `Samuhia Payments: your MyChama linking code is ${code}. Valid for ${Math.round(L.CODE_TTL_SECONDS / 60)} minutes. Never share it.`);
  } catch (e) {
    console.error("mychama link: SMS send failed:", (e as Error)?.message || e);   // never log the code or phone
    await chRef.delete().catch(() => undefined);
    throw myChamaError("upstream_failure", "We could not send the code. Please try again shortly.", "unavailable");
  }
  return { challengeId, maskedPhone: view.maskedPhone, expiresAt, resendAfter: now + L.CODE_RESEND_COOLDOWN_SECONDS * 1000 };
}

/** Validates the code; on success consumes the challenge and returns the proven phone key. */
export async function verifyCode(uid: string, challengeId: string, rawCode: string): Promise<string> {
  const db = plotDb();
  const now = Date.now();
  const code = (rawCode || "").replace(/\s+/g, "");
  const chRef = db.doc(MYCHAMA_PATHS.challenge(challengeId));

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(chRef);
    const d = snap.data();
    if (!snap.exists || !d || d.uid !== uid) return { kind: "invalid" as const };
    if (Number(d.expiresAt || 0) < now) { tx.delete(chRef); return { kind: "expired" as const }; }
    const attempts = Number(d.attempts || 0);
    if (attempts >= L.CODE_MAX_ATTEMPTS) return { kind: "locked" as const };

    const ok = /^\d+$/.test(code) && code.length === L.CODE_LENGTH && safeEqualHex(hashCode(challengeId, code), String(d.codeHash || ""));
    if (ok) { tx.delete(chRef); return { kind: "ok" as const, phoneKey: String(d.phoneKey) }; }
    tx.update(chRef, { attempts: attempts + 1 });
    return { kind: "wrong" as const, remaining: Math.max(0, L.CODE_MAX_ATTEMPTS - attempts - 1) };
  });

  switch (result.kind) {
    case "ok": return result.phoneKey;
    case "expired": throw myChamaError("code_expired", "That code has expired. Request a new one.", "deadline-exceeded");
    case "locked": throw myChamaError("code_attempts_exceeded", "Too many wrong attempts. Request a new code.", "resource-exhausted");
    case "wrong":
      // remainingAttempts rides in details next to `code` (extra key; see track-A-notes.md).
      throw new HttpsError("failed-precondition", "That code is not correct.", { code: "code_invalid", remainingAttempts: result.remaining });
    default: throw myChamaError("code_invalid", "That code is not correct.", "failed-precondition");
  }
}
