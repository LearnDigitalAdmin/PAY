import type { CallableRequest } from "firebase-functions/v2/https";
import { LMMX_BOT_KEY, X, COL } from "./config";
import { LMMX_TOP_DESK, BOT_SIG_MAX_AGE_MS, botSigMessage, normalizeKePhone } from "./contract";
import { H, hmacHex, safeEq, sha256 } from "./crypto";
import { fail } from "./errors";
import { audit, col, db, flags, now, rateOk } from "./store";
import type { TenantDoc } from "./types";

export interface DeskCtx { uid: string; deskCode: string; rank: string; isTop: boolean; phone: string; ip: string }
const ipOf = (req: { rawRequest?: { headers?: Record<string, unknown>; ip?: string } }): string => {
  const f = req.rawRequest?.headers?.["x-forwarded-for"];
  return (typeof f === "string" ? f.split(",")[0].trim() : "") || req.rawRequest?.ip || "unknown";
};
export const callerIp = ipOf;

/** A signed-in desk agent: desk_agents/{uid} must exist and be active. The top desk is the agent whose code is COG-0000. */
export async function requireDesk(req: CallableRequest<unknown>): Promise<DeskCtx> {
  if (!req.auth) return fail("LMMX_E_AUTH", "Please sign in.");
  const d = (await col("desk_agents").doc(req.auth.uid).get()).data() as { agentCode?: string; status?: string; rank?: string; phone?: string } | undefined;
  if (!d || typeof d.agentCode !== "string" || d.status !== "active") return fail("LMMX_E_FORBIDDEN", "This account is not an active desk.");
  const isTop = d.agentCode === LMMX_TOP_DESK;
  if (!isTop && (await col(COL.locks).doc(`deskfreeze_${d.agentCode}`).get()).exists) return fail("LMMX_E_FROZEN", "Your desk is on hold. Please contact support.");
  return { uid: req.auth.uid, deskCode: d.agentCode, rank: String(d.rank ?? ""), isTop, phone: String(d.phone ?? ""), ip: ipOf(req) };
}

/** Top desk only: COG-0000, verified @samuhia.co.ke email, signed in within 15 minutes, and a written reason. Same bar as DESK's evaluateTopAccess. */
export async function requireTop(req: CallableRequest<unknown>, reason?: unknown): Promise<DeskCtx & { reason: string }> {
  const ctx = await requireDesk(req);
  if (!ctx.isTop) return fail("LMMX_E_FORBIDDEN", "Top desk access only.");
  const t = req.auth!.token as { email?: string; email_verified?: boolean; auth_time?: number };
  const okEmail = typeof t.email === "string" && t.email.toLowerCase().endsWith(`@${X.SAMUHIA_DOMAIN}`) && t.email_verified === true;
  if (!okEmail) return fail("LMMX_E_FORBIDDEN", `Top desk needs a verified @${X.SAMUHIA_DOMAIN} account.`);
  if (!t.auth_time || Math.floor(now() / 1000) - t.auth_time > X.TOP_RECENT_AUTH_S) return fail("LMMX_E_NEEDS_REAUTH", "Please sign in again to continue.");
  const r = typeof reason === "string" ? reason.trim() : "";
  if (reason !== undefined && r.length < X.REASON_MIN) return fail("LMMX_E_VALIDATION", `Write a reason of at least ${X.REASON_MIN} characters.`);
  return { ...ctx, reason: r };
}

export async function requireEnabled(): Promise<void> { if (!(await flags()).enabled) fail("LMMX_E_DISABLED", "Lipa Mdogo Mdogo for new tenants is not switched on yet."); }

export interface TenantCtx { uid: string; tenantId: string; tenant: TenantDoc; phone: string; ip: string }
/** The verified phone of this sign-in (phone_number, or otp_phone stamped by verifyLoginOtp), as E.164, or null. */
export function verifiedPhone(req: CallableRequest<unknown>): string | null {
  const t = (req.auth?.token ?? {}) as { otp_phone?: unknown; phone_number?: unknown };
  return normalizeKePhone(typeof t.otp_phone === "string" ? t.otp_phone : typeof t.phone_number === "string" ? t.phone_number : "");
}
/** After lmmx_tenant_link: the signed-in person IS this standalone tenant (uid stored on the tenant AND the phone still verified). */
export async function requireTenant(req: CallableRequest<unknown>, allow: ("awaiting_confirmation" | "active" | "paused" | "frozen" | "migrated")[] = ["active", "paused"]): Promise<TenantCtx> {
  if (!req.auth) return fail("LMMX_E_AUTH", "Please sign in.");
  const phone = verifiedPhone(req);
  if (!phone) return fail("LMMX_E_AUTH", "Please sign in with your phone number.");
  const tid = (req.auth.token as { lmmxTenantId?: unknown }).lmmxTenantId;
  const q = typeof tid === "string"
    ? await col(COL.tenants).doc(tid).get()
    : (await col(COL.tenants).where("authUid", "==", req.auth.uid).limit(1).get()).docs[0];
  const t = q?.data() as TenantDoc | undefined;
  if (!t || t.authUid !== req.auth.uid || !safeEq(t.phoneHash, H("phone", phone))) return fail("LMMX_E_AUTH", "Please link your account first.");
  const st = t.frozen ? "frozen" : (t.status as string);
  if (!(allow as string[]).includes(st)) return fail(t.frozen ? "LMMX_E_FROZEN" : "LMMX_E_STATE", t.frozen ? "Your account is on hold. Please contact support." : "This is not available right now.");
  return { uid: req.auth.uid, tenantId: t.tenantId, tenant: t, phone, ip: ipOf(req) };
}

/** Bot calls: ts within 5 minutes, nonce never seen, HMAC-SHA256 over botSigMessage with LMMX_BOT_KEY. */
export async function verifyBot(op: string, data: Record<string, unknown>): Promise<void> {
  const { ts, nonce, sig } = data as { ts?: unknown; nonce?: unknown; sig?: unknown };
  const bad = async (why: string): Promise<never> => { await audit({ action: "signature_failed", actor: { type: "bot" }, summary: `${op}: ${why}` }); return fail("LMMX_E_SIG", "Request not accepted."); };
  if (typeof ts !== "number" || typeof nonce !== "string" || typeof sig !== "string" || nonce.length < 8 || nonce.length > 80) return bad("fields");
  if (Math.abs(now() - ts) > BOT_SIG_MAX_AGE_MS) return bad("timestamp");
  if (!safeEq(sig, hmacHex(LMMX_BOT_KEY.value(), botSigMessage(op, ts, nonce, data)))) return bad("signature");
  try { await col(COL.nonces).doc(sha256(nonce).slice(0, 40)).create({ ts, exp: now() + X.NONCE_TTL_MS }); } catch (e) {
    if ((e as { code?: number }).code === 6) return bad("replay");
    throw e;
  }
  if (!(await rateOk(`bot|${op}`, 600, 60_000))) fail("LMMX_E_RATE", "Too many requests. Please wait a moment.");
}
export { db };
