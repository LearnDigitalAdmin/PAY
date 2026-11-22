// Perks callables. Two entry points keep the surface small and easy to relocate:
//   perks_op  - operator actions (allow-listed uids in perks_config/operators)
//   perks_me  - the signed-in customer's own account (identity = phone proven by the OTP login token)
import { onCall, type CallableRequest } from "firebase-functions/v2/https";
import { db, HttpsError, REGION, SECRETS, sendSms } from "./deps";
import { handleCustomer, handleOperator } from "./handlers";
import { P, PerksError } from "./types";

const toHttps = (e: unknown) => {
  if (e instanceof PerksError) return new HttpsError(e.code, e.message);
  if (e instanceof HttpsError) return e;
  console.error("perks internal error:", (e as Error)?.message);
  return new HttpsError("internal", "Something went wrong. Please try again.");
};

async function requireOperator(req: CallableRequest): Promise<string> {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const snap = await db().doc(`${P.config}/operators`).get();
  const uids = ((snap.data() || {}).uids as string[] | undefined) || [];
  if (!uids.includes(req.auth.uid)) throw new HttpsError("permission-denied", "This account is not a Perks operator.");
  return req.auth.uid;
}

export const perks_op = onCall({ region: REGION, cors: true, maxInstances: 5, timeoutSeconds: 60, secrets: SECRETS }, async (req) => {
  const uid = await requireOperator(req);
  const d = (req.data || {}) as { action?: unknown; payload?: Record<string, unknown> };
  try { return await handleOperator(db(), sendSms, uid, String(d.action ?? ""), d.payload || {}); } catch (e) { throw toHttps(e); }
});

export const perks_me = onCall({ region: REGION, cors: true, maxInstances: 10, timeoutSeconds: 30 }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const t = req.auth.token as { otp_phone?: unknown; phone_number?: unknown };
  const phone = typeof t.otp_phone === "string" ? t.otp_phone : typeof t.phone_number === "string" ? t.phone_number : "";
  if (!phone) throw new HttpsError("permission-denied", "Verify your phone number to continue.");
  const d = (req.data || {}) as { action?: unknown; payload?: Record<string, unknown> };
  try { return await handleCustomer(db(), { uid: req.auth.uid, phone }, String(d.action ?? ""), d.payload || {}); } catch (e) { throw toHttps(e); }
});
