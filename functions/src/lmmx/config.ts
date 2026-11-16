// LMMX (standalone Lipa Mdogo Mdogo) server config. Like legacy lmm/config.ts: every number that decides where money goes lives in CODE.
// Firestore holds only the on/off and pause switches (lmm_config/standalone), and those can only make things SAFER.
import { bundleSecret } from "../secretsBundle";
import { LMM } from "../lmm/config";

export const LMMX_PEPPER = bundleSecret("LMMX_HASH_PEPPER");
export const LMMX_OTP_PEPPER = bundleSecret("LMMX_OTP_PEPPER");
export const LMMX_FIELD_KEY = bundleSecret("LMMX_FIELD_KEY");
export const LMMX_QUOTE_KEY = bundleSecret("LMMX_QUOTE_KEY");
export const LMMX_BOT_KEY = bundleSecret("LMMX_BOT_KEY");

export const X = {
  /** Shown to tenants and landlords as the number to call. Change it here (and deploy) if support moves. */
  SUPPORT_PHONE: "0791286165",
  ALERT_MOBILE: LMM.ALERT_MOBILE,
  OUTFLOW_CAP_MINOR: LMM.DAILY_OUTFLOW_CAP_MINOR,
  QUOTE_TTL_MS: 10 * 60_000,
  PAY_ATTEMPTS_PER_DAY: 20,
  PENDING_PAY_MS: 3 * 60_000,
  /** Desk bonuses (desk_ledger payables the top desk pays by hand). */
  LANDLORD_BONUS_PCT_BPS: 10_000, LANDLORD_BONUS_MIN_MINOR: 30_000, MIGRATION_BONUS_MINOR: 5_000,
  AVAILABILITY_LAG_DAYS: 2,
  TOP_RECENT_AUTH_S: 15 * 60,
  SAMUHIA_DOMAIN: "samuhia.co.ke",
  RATE: { linkPer10Min: 5, botPer10Min: 30, changePerDay: 30 },
  REASON_MIN: 10,
  NONCE_TTL_MS: 10 * 60_000,
} as const;

export const COL = {
  tenants: "lmm_tenants", payRecords: "lmm_pay_records", config: "lmm_config",
  recipients: "lmmx_recipients", cycles: "lmmx_cycles", payments: "lmmx_payments", settlements: "lmmx_settlements", ledger: "lmmx_ledger",
  changes: "lmmx_changes", otps: "lmmx_otps", locks: "lmmx_locks", audit: "lmmx_audit", auditMeta: "lmmx_audit_meta", anchors: "lmmx_audit_anchors",
  leads: "lmmx_leads", nonces: "lmmx_nonces", earnings: "lmmx_desk_earnings", rate: "lmmx_rate", counters: "lmm_counters", smsLog: "lmm_sms_log",
} as const;
