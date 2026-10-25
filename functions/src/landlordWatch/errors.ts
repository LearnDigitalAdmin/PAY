import { HttpsError, type FunctionsErrorCode } from "firebase-functions/v2/https";

export type LwCode =
  | "LW_BAD_OWNER_ID" | "LW_NOT_FOUND" | "LW_RATE_LIMITED" | "LW_NO_PHONE_ON_FILE" | "LW_OTP_COOLDOWN" | "LW_OTP_WRONG"
  | "LW_OTP_EXPIRED" | "LW_OTP_LOCKED" | "LW_SMS_FAILED" | "LW_LOCKED" | "LW_CONNECTION_LIMIT" | "LW_BAD_MONTH"
  | "LW_PAYMENT_FAILED" | "LW_NOT_ALLOWED" | "LW_UNAVAILABLE";

export interface LwExtra { retryAfterSec?: number; attemptsLeft?: number }

export class LwError extends Error {
  constructor(public readonly code: LwCode, message: string, public readonly extra: LwExtra = {}) {
    super(message);
    this.name = "LwError";
  }
}

const HTTPS_CODE: Record<LwCode, FunctionsErrorCode> = {
  LW_BAD_OWNER_ID: "invalid-argument", LW_NOT_FOUND: "not-found", LW_RATE_LIMITED: "resource-exhausted",
  LW_NO_PHONE_ON_FILE: "failed-precondition", LW_OTP_COOLDOWN: "resource-exhausted", LW_OTP_WRONG: "permission-denied",
  LW_OTP_EXPIRED: "deadline-exceeded", LW_OTP_LOCKED: "permission-denied", LW_SMS_FAILED: "unavailable",
  LW_LOCKED: "failed-precondition", LW_CONNECTION_LIMIT: "resource-exhausted", LW_BAD_MONTH: "invalid-argument",
  LW_PAYMENT_FAILED: "unavailable", LW_NOT_ALLOWED: "permission-denied", LW_UNAVAILABLE: "internal",
};

/** Callable transport: HttpsError whose details carry the LW code. */
export function toHttpsError(e: unknown): HttpsError {
  if (e instanceof HttpsError) return e;
  if (e instanceof LwError) return new HttpsError(HTTPS_CODE[e.code], e.message, { lw: e.code, ...e.extra });
  console.error("Landlord Watch unexpected error:", e);
  return new HttpsError("internal", "Something went wrong. Please try again.", { lw: "LW_UNAVAILABLE" });
}

/** Bot transport: plain JSON error. */
export function toBotError(e: unknown): { code: LwCode; message: string; retryAfterSec?: number; attemptsLeft?: number } {
  if (e instanceof LwError) return { code: e.code, message: e.message, ...e.extra };
  console.error("Landlord Watch unexpected error:", e);
  return { code: "LW_UNAVAILABLE", message: "Something went wrong. Please try again." };
}
