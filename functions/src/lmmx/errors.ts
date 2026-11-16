import { HttpsError } from "firebase-functions/v2/https";
import type { LmmxErrorCode } from "./contract";

const MAP: Record<LmmxErrorCode, ConstructorParameters<typeof HttpsError>[0]> = {
  LMMX_E_AUTH: "unauthenticated", LMMX_E_FORBIDDEN: "permission-denied", LMMX_E_SIG: "permission-denied", LMMX_E_RATE: "resource-exhausted",
  LMMX_E_VALIDATION: "invalid-argument", LMMX_E_DUPLICATE: "already-exists", LMMX_E_NOT_FOUND: "not-found", LMMX_E_OTP_INVALID: "invalid-argument",
  LMMX_E_OTP_LOCKED: "resource-exhausted", LMMX_E_OTP_EXPIRED: "failed-precondition", LMMX_E_REVIEW_REQUIRED: "failed-precondition", LMMX_E_FROZEN: "failed-precondition",
  LMMX_E_DISABLED: "failed-precondition", LMMX_E_AMOUNT: "invalid-argument", LMMX_E_QUOTE: "failed-precondition", LMMX_E_STATE: "failed-precondition",
  LMMX_E_TAMPER: "failed-precondition", LMMX_E_RECIPIENT_BLOCKED: "failed-precondition", LMMX_E_NEEDS_REAUTH: "unauthenticated", LMMX_E_DESK_NOT_READY: "failed-precondition",
  LMMX_E_INTERNAL: "internal",
};
/** Messages are short, safe to show, and never say whether a phone, ID or account exists. */
export class LmmxError extends Error { constructor(public lmmx: LmmxErrorCode, message: string) { super(message); } }
export const fail = (code: LmmxErrorCode, message: string): never => { throw new LmmxError(code, message); };
export function toHttps(e: unknown): HttpsError {
  if (e instanceof LmmxError) return new HttpsError(MAP[e.lmmx], e.message, { lmmx: e.lmmx });
  if (e instanceof HttpsError) return e;
  console.error("LMMX unexpected:", (e as Error)?.stack ?? e);
  return new HttpsError("internal", "Something went wrong. Please try again.", { lmmx: "LMMX_E_INTERNAL" });
}
