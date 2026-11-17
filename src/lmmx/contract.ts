/**
 * LMMX CONTRACT v1  (Lipa Mdogo Mdogo, standalone tenants)  -  single source of truth
 *
 * SELF-CONTAINED: no imports. Types, plain constants and small PURE helpers only. It is copied VERBATIM (byte-identical) to:
 *   PAY   functions/src/lmmx/contract.ts      <- canonical copy, owned by CORE
 *   PAY   src/lmmx/contract.ts                (tenant web UI)
 *   DESK  src/desk/api/lmmxContract.ts        (desk web UI)
 *   DESK  functions/src/types/lmmx.contract.ts (WhatsApp bot)
 * Nobody edits their copy. A change goes to CORE as a Contract Change Request (see LMM_CONTRACT.md section 15).
 *
 * All money is integer MINOR units (KES x 100). Instalment credits are WHOLE SHILLINGS (multiples of 100). Timestamps are epoch ms.
 * Dates are Africa/Nairobi calendar days "YYYY-MM-DD". User-facing brand: "Lipa Mdogo Mdogo". Internal names keep "lmm"/"lmmx".
 */

export const LMMX_CONTRACT_VERSION = 2;
export const LMMX_REGION = "africa-south1";           // every lmmx_* callable
export const LMMX_BRAND = "Lipa Mdogo Mdogo";
export const LMMX_TOP_DESK = "COG-0000";
export const LMMX_BOT_PHONE_E164 = "+254101716473";   // WhatsApp bot 0101716473
export const LMMX_BOT_LINK = "https://wa.me/254101716473";
export const LMMX_LANDLORD_URL = "https://plot.samuhia.co.ke/";
export const LMMX_PAYMENT_REF_PREFIX = "LMX_";         // Paystack charge references (legacy LMM uses "LMM_")
export const LMMX_TRANSFER_REF_PREFIX = "lmx-";        // Paystack transfer references (legacy LMM uses "lmm-")

// ------------------------------------------------------------------------------------------------------------- money rules
export const LMMX = {
  MIN_CREDIT_MINOR: 1_000,              // KES 10 per instalment
  MAX_CREDIT_MINOR: 15_000_000,         // KES 150,000 per instalment
  RENT_MIN_MINOR: 100_000,              // KES 1,000
  RENT_MAX_MINOR: 15_000_000,           // KES 150,000 (Paystack's M-PESA wallet limit per transfer)
  /** Paystack's card/M-PESA collection fee. Transfers are NOT part of it. */
  COLLECTION_BPS: 150,
  /** What a transfer really costs us: Paystack's listed cost x 1.2 (assumed excise), rounded up to a shilling, plus KES 5. Confirm on a real Paystack statement. */
  TRANSFER_UPLIFT_BPS: 12_000,
  TRANSFER_BUFFER_MINOR: 500,
  /** Service fee, by instalment credit (minor units): bps of the credit. Larger instalments are cheaper. (v2.1: lowered, was 6 / 4 / 3 / 2 / 1.5%.) */
  SERVICE_BANDS: [
    { fromMinor: 1_000, bps: 400 },     // KES 10 - 99
    { fromMinor: 10_000, bps: 300 },    // KES 100 - 499
    { fromMinor: 50_000, bps: 200 },    // KES 500 - 1,999
    { fromMinor: 200_000, bps: 150 },   // KES 2,000 - 4,999
    { fromMinor: 500_000, bps: 100 },   // KES 5,000 and above
  ] as const,
  /** The desk keeps this share of the service fee, paid at once through the Paystack flat split. The platform keeps the rest. (v2.1: raised from 60% so desks lose little while the fee falls.) */
  DESK_SHARE_BPS: 7_500,
  /** KES 25 to the desk when a tenant's cycle is fully credited by its due date (needs at least 2 instalments). Paid as a top-desk payable. */
  COMPLETION_BONUS_MINOR: 2_500,
  DUE_DAY_DEFAULT: 5, DUE_DAY_MIN: 1, DUE_DAY_MAX: 28,
  DUE_DAY_CHANGES_PER_CYCLE: 1, DUE_DAY_LOCK_DAYS_BEFORE_DUE: 5,
  /** The first cycle's due date is the next dueDay that is at least this many days away. */
  FIRST_DUE_MIN_DAYS: 7,
  WARN_DAYS_BEFORE_DUE: 5,
  // security
  OTP_PREFIX: "LMM", OTP_DIGITS: 4, OTP_TTL_MS: 30 * 60_000, OTP_MAX_ATTEMPTS: 5, OTP_SETUP_TOTAL_ATTEMPTS_MAX: 10,
  OTP_LOCK_MS: 3_600_000, OTP_RESEND_MAX_PER_HOUR: 3,
  CANCEL_PREFIX: "LMC",
  SETUP_EXPIRY_MS: 72 * 3_600_000,
  CHANGE_COOLING_OFF_MS: 48 * 3_600_000,
  CHANGE_DEFER_DAYS_BEFORE_DUE: 3,
  FIRST_PAYOUT_MIN_RECIPIENT_AGE_MS: 48 * 3_600_000,
  LANDLORD_NOTICE_MIN_BEFORE_PAYOUT_MS: 24 * 3_600_000,
  DESK_NEW_TENANTS_PER_DAY: 15,
  DESK_RECIPIENT_CHECKS_PER_DAY: 20,
  RECIPIENT_TENANTS_BEFORE_REVIEW: 3,
  SMS_MAX_CHARS: 280,
} as const;

// ------------------------------------------------------------------------------------------------------------- enums
export type Channel = "phone" | "till" | "bank";          // M-PESA phone, M-PESA till, bank (paybill is NOT supported)
export const CHANNELS: readonly Channel[] = ["phone", "till", "bank"];
/** Paystack transfer-recipient type for each channel (identical to PAY's existing lmm/recipient.ts). */
export const PAYSTACK_TYPE: Record<Channel, "mobile_money" | "mobile_money_business" | "kepss"> = { phone: "mobile_money", till: "mobile_money_business", bank: "kepss" };
export const PAYSTACK_BANK_CODE: Partial<Record<Channel, string>> = { phone: "MPESA", till: "MPTILL" };
export type IdType = "national_id" | "alien_id" | "passport";
export type Frequency = "daily" | "weekly" | "biweekly";
export const FREQUENCIES: readonly Frequency[] = ["daily", "weekly", "biweekly"];
export type TenantStatus = "draft" | "awaiting_confirmation" | "active" | "paused" | "frozen" | "closed" | "migrated";
export type CycleStatus = "open" | "funded" | "partial_settled" | "settled" | "closed" | "refunded";
export type RecipientStatus = "pending" | "verified" | "needs_review" | "frozen" | "retired";
export type NameMatch = "matched" | "mismatch" | "unavailable";
export type ChangeKind = "recipient" | "rent";
export type ChangeStatus = "awaiting_tenant_otp" | "cooling_off" | "deferred" | "applied" | "cancelled" | "expired" | "rejected";
export type LeadStage = "new" | "to_contact" | "contacted" | "interested" | "follow_up" | "not_interested" | "closed_won" | "closed_lost";
export const LEAD_STAGES: readonly LeadStage[] = ["new", "to_contact", "contacted", "interested", "follow_up", "not_interested", "closed_won", "closed_lost"];
export type AuditAction =
  | "tenant_created" | "setup_otp_sent" | "setup_otp_failed" | "setup_confirmed" | "setup_expired" | "recipient_checked" | "recipient_created" | "recipient_reused"
  | "recipient_review_decided" | "change_requested" | "change_otp_failed" | "change_confirmed" | "change_cancelled" | "change_applied" | "tenant_link" | "due_day_changed"
  | "plan_changed" | "payment_credited" | "payment_rejected" | "settlement_started" | "settlement_paid" | "settlement_failed" | "refund" | "freeze" | "unfreeze"
  | "reassign" | "reveal" | "top_update" | "landlord_matched" | "tamper_detected" | "rate_limited" | "signature_failed" | "audit_verified" | "lead_updated" | "bonus_accrued";

export type LmmxErrorCode =
  | "LMMX_E_AUTH" | "LMMX_E_FORBIDDEN" | "LMMX_E_SIG" | "LMMX_E_RATE" | "LMMX_E_VALIDATION" | "LMMX_E_DUPLICATE" | "LMMX_E_NOT_FOUND" | "LMMX_E_OTP_INVALID"
  | "LMMX_E_OTP_LOCKED" | "LMMX_E_OTP_EXPIRED" | "LMMX_E_REVIEW_REQUIRED" | "LMMX_E_FROZEN" | "LMMX_E_DISABLED" | "LMMX_E_AMOUNT" | "LMMX_E_QUOTE" | "LMMX_E_STATE"
  | "LMMX_E_TAMPER" | "LMMX_E_RECIPIENT_BLOCKED" | "LMMX_E_NEEDS_REAUTH" | "LMMX_E_DESK_NOT_READY" | "LMMX_E_INTERNAL";
/** CORE throws Firebase HttpsError(code, message, { lmmx: LmmxErrorCode }). `details.lmmx` is what UIs switch on; `message` is safe to show. */

// ------------------------------------------------------------------------------------------------------------- pure helpers
/** "07.. / 01.. / 7.. / 1.. / 254.. / +254.." -> "+2547XXXXXXXX" or "+2541XXXXXXXX"; null when it is not a Kenyan mobile. */
export function normalizeKePhone(raw: unknown): string | null {
  const d = String(raw ?? "").replace(/[^\d+]/g, "").replace(/^\+/, "");
  let n: string;
  if (/^254[17]\d{8}$/.test(d)) n = d;
  else if (/^0[17]\d{8}$/.test(d)) n = "254" + d.slice(1);
  else if (/^[17]\d{8}$/.test(d)) n = "254" + d;
  else return null;
  return "+" + n;
}
export const maskPhone = (e164: string): string => (e164.length >= 6 ? `${e164.slice(0, 4)}*****${e164.slice(-3)}` : "***");
export const maskId = (id: string): string => (id.length <= 4 ? "****" : `${id.slice(0, 2)}${"*".repeat(Math.max(2, id.length - 4))}${id.slice(-2)}`);
export const maskName = (full: string): string => {
  const p = full.trim().split(/\s+/).filter(Boolean);
  return p.length === 0 ? "" : p.length === 1 ? p[0] : `${p[0]} ${p[p.length - 1].charAt(0).toUpperCase()}.`;
};
export const last3 = (acct: string): string => String(acct).replace(/\s+/g, "").slice(-3);
export const channelLabel = (c: Channel): string => (c === "phone" ? "M-PESA" : c === "till" ? "TILL" : "BANK");
export const kes = (minor: number): string => {
  const v = minor / 100;
  return `KES ${Number.isInteger(v) ? v.toLocaleString("en-KE") : v.toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

/** Valid ID number shapes (the server also validates): national / alien ID 6-9 digits, passport 6-9 letters or digits. */
export function validIdNumber(type: IdType, v: string): boolean {
  const s = v.trim();
  return type === "passport" ? /^[A-Za-z0-9]{6,9}$/.test(s) : /^\d{6,9}$/.test(s);
}

// ---- OTP text. The SMS, the bot and the desk UI all use exactly this shape: "LMM4683" (setup / change) and "LMC7391" (cancel a change).
export const otpText = (code4: string): string => `${LMMX.OTP_PREFIX}${code4}`;
export const cancelText = (code4: string): string => `${LMMX.CANCEL_PREFIX}${code4}`;
/** Recognises a message that is only an LMMX code (case and spaces forgiven). Anything else returns null. */
export function parseLmmxCode(text: unknown): { kind: "otp" | "cancel"; code: string } | null {
  const m = /^\s*(LMM|LMC)\s?-?(\d{4})\s*$/i.exec(String(text ?? ""));
  return m ? { kind: m[1].toUpperCase() === "LMM" ? "otp" : "cancel", code: m[2] } : null;
}
export const botConfirmLink = (code4: string): string => `${LMMX_BOT_LINK}?text=${otpText(code4)}`;

// ---- dates (Africa/Nairobi, no DST)
const EAT = 3 * 3_600_000, DAY = 86_400_000;
export const eatDate = (now: number): string => new Date(now + EAT).toISOString().slice(0, 10);
export const clampDueDay = (d: number): number => Math.min(LMMX.DUE_DAY_MAX, Math.max(LMMX.DUE_DAY_MIN, Math.trunc(d)));
const pad = (n: number) => String(n).padStart(2, "0");
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY);
/** Next date with this day-of-month that is at least `minDays` after `todayIso`. */
export function nextDueDate(todayIso: string, dueDay: number, minDays = 0): string {
  let y = Number(todayIso.slice(0, 4)), m = Number(todayIso.slice(5, 7));
  for (let i = 0; i < 14; i++) {
    const iso = `${y}-${pad(m)}-${pad(clampDueDay(dueDay))}`;
    if (dayDiff(iso, todayIso) >= minDays) return iso;
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  throw new RangeError("no due date found");
}
export const firstDueDate = (todayIso: string, dueDay: number): string => nextDueDate(todayIso, dueDay, LMMX.FIRST_DUE_MIN_DAYS);
export const daysUntil = (iso: string, todayIso: string): number => dayDiff(iso, todayIso);
export const shortDate = (iso: string): string => {
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${Number(m[3])} ${MON[Number(m[2]) - 1]}` : iso;
};

// ---- the fee engine (CORE recomputes every number; UIs use these for previews and MUST show what CORE returns on a real quote)
/** What Paystack lists for one transfer, by channel and amount sent (identical to PAY lmm/config.ts PAYSTACK_TRANSFER_COST). */
export const PAYSTACK_TRANSFER_COST: Record<Channel, readonly { upToMinor: number; costMinor: number }[]> = {
  phone: [{ upToMinor: 150_000, costMinor: 2_000 }, { upToMinor: 2_000_000, costMinor: 4_000 }, { upToMinor: 15_000_000, costMinor: 6_000 }],
  till: [{ upToMinor: 150_000, costMinor: 4_000 }, { upToMinor: 1_000_000, costMinor: 8_000 }, { upToMinor: 4_000_000, costMinor: 14_000 }, { upToMinor: 99_900_000, costMinor: 18_000 }],
  bank: [{ upToMinor: 1_000_000, costMinor: 8_000 }, { upToMinor: 5_000_000, costMinor: 12_000 }, { upToMinor: 99_999_900, costMinor: 14_000 }],
};
const ceilDiv = (a: number, b: number): number => Math.ceil(a / b);
const wholeShilling = (minor: number): number => Math.ceil(minor / 100) * 100;
export function transferCostMinor(amountMinor: number, channel: Channel): number {
  const t = PAYSTACK_TRANSFER_COST[channel].find((x) => amountMinor <= x.upToMinor);
  if (!t) throw new RangeError("amount is above the transfer limit");
  return t.costMinor;
}
/** F: what one payout of `amountMinor` must reserve from the tenant (cost x 1.2, whole shilling, + KES 5). */
export const transferReserveMinor = (amountMinor: number, channel: Channel): number =>
  wholeShilling(ceilDiv(transferCostMinor(amountMinor, channel) * LMMX.TRANSFER_UPLIFT_BPS, 10_000)) + LMMX.TRANSFER_BUFFER_MINOR;
export function serviceBps(creditMinor: number): number {
  let bps: number = LMMX.SERVICE_BANDS[0].bps;
  for (const b of LMMX.SERVICE_BANDS) if (creditMinor >= b.fromMinor) bps = b.bps;
  return bps;
}
export function isValidCredit(creditMinor: unknown): creditMinor is number {
  return typeof creditMinor === "number" && Number.isSafeInteger(creditMinor) && creditMinor % 100 === 0 && creditMinor >= LMMX.MIN_CREDIT_MINOR && creditMinor <= LMMX.MAX_CREDIT_MINOR;
}
export interface QuoteInput {
  creditMinor: number;                 // x: what reaches the rent
  rentMinor: number;                   // R: the cycle's rent (for a top-up leg: the remaining rent that leg will pay out)
  channel: Channel;
  reserveCollectedMinor?: number;      // transfer reserve already collected for this payout leg (default 0)
  remainingRentMinor?: number;         // rent still owed before this instalment (default = rentMinor); equals creditMinor on the last instalment
}
export interface Quote {
  creditMinor: number; transferReserveMinor: number; serviceFeeMinor: number; collectionAllowanceMinor: number;
  chargeMinor: number;                 // g: what the tenant pays (whole shilling)
  feesMinor: number;                   // g - x
  deskShareMinor: number; platformShareMinor: number;
}
/**
 * T = ceil(x*F/R), but the last instalment of a payout leg takes whatever is left of F, so the leg's total is exactly F and the landlord is paid EXACTLY the credits.
 * S = ceil(x*bps/10000).  g = whole shilling of ceil((x+T+S) / (1 - 1.5%)).  Desk = floor(S*75%).
 */
export function quoteInstalment(i: QuoteInput): Quote {
  if (!Number.isSafeInteger(i.rentMinor) || i.rentMinor <= 0) throw new RangeError("rent must be a positive integer");
  const remaining = i.remainingRentMinor ?? i.rentMinor;
  const last = i.creditMinor >= remaining;
  // The FINAL instalment of a leg may be below the KES 10 minimum (whole shillings, at least KES 1) so a tenant is never stuck with a crumb.
  const okCredit = isValidCredit(i.creditMinor) || (last && Number.isSafeInteger(i.creditMinor) && i.creditMinor % 100 === 0 && i.creditMinor >= 100 && i.creditMinor <= LMMX.MAX_CREDIT_MINOR);
  if (!okCredit) throw new RangeError("credit must be whole shillings between the minimum and maximum instalment");
  const F = transferReserveMinor(i.rentMinor, i.channel);
  const collected = i.reserveCollectedMinor ?? 0;
  const T = last ? Math.max(0, F - collected) : Math.min(ceilDiv(i.creditMinor * F, i.rentMinor), Math.max(0, F - collected));
  const S = ceilDiv(i.creditMinor * serviceBps(i.creditMinor), 10_000);
  const raw = ceilDiv((i.creditMinor + T + S) * 10_000, 10_000 - LMMX.COLLECTION_BPS);
  const g = wholeShilling(raw);
  const desk = Math.floor((S * LMMX.DESK_SHARE_BPS) / 10_000);
  return { creditMinor: i.creditMinor, transferReserveMinor: T, serviceFeeMinor: S, collectionAllowanceMinor: g - i.creditMinor - T - S, chargeMinor: g, feesMinor: g - i.creditMinor, deskShareMinor: desk, platformShareMinor: S - desk };
}
/** The invariant CORE checks on every payment: after Paystack's collection fee, the charge still covers credit + reserve + service. */
export const quoteCoversCosts = (q: Quote): boolean => q.chargeMinor - ceilDiv(q.chargeMinor * LMMX.COLLECTION_BPS, 10_000) >= q.creditMinor + q.transferReserveMinor + q.serviceFeeMinor;

export interface EarningsRow { creditMinor: number; chargeMinor: number; feesMinor: number; feePct: number; deskShareMinor: number }
/** What a desk earns per instalment size, for the earnings table on the tenant screen. */
export function earningsTable(rentMinor: number, channel: Channel, sizes: readonly number[] = [10_000, 50_000, 100_000, 250_000, 500_000]): EarningsRow[] {
  return sizes.filter((x) => x <= rentMinor).concat(rentMinor).filter((v, i, a) => a.indexOf(v) === i).map((x) => {
    const q = quoteInstalment({ creditMinor: x, rentMinor, channel });
    return { creditMinor: x, chargeMinor: q.chargeMinor, feesMinor: q.feesMinor, feePct: Math.round((q.feesMinor * 10_000) / x) / 100, deskShareMinor: q.deskShareMinor };
  });
}
/** Whole-cycle projection if the tenant pays in equal instalments of `creditMinor` (last one takes the remainder). Includes the completion bonus when there are 2+ instalments. */
export function cycleProjection(rentMinor: number, channel: Channel, creditMinor: number): { instalments: number; tenantPaysMinor: number; feesMinor: number; deskMinor: number; deskBonusMinor: number } {
  let left = rentMinor, collected = 0, paid = 0, desk = 0, n = 0;
  while (left > 0) {
    let x = Math.min(creditMinor, left);
    if (left - x > 0 && left - x < LMMX.MIN_CREDIT_MINOR) x = left;   // never leave a crumb below the minimum: fold it into this instalment
    const q = quoteInstalment({ creditMinor: x, rentMinor, channel, reserveCollectedMinor: collected, remainingRentMinor: left });
    collected += q.transferReserveMinor; paid += q.chargeMinor; desk += q.deskShareMinor; left -= x; n += 1;
  }
  return { instalments: n, tenantPaysMinor: paid, feesMinor: paid - rentMinor, deskMinor: desk, deskBonusMinor: n >= 2 ? LMMX.COMPLETION_BONUS_MINOR : 0 };
}

// ------------------------------------------------------------------------------------------------------------- SMS texts (GSM-7 only, 280 max)
const GSM = /[^\x20-\x7E]/g;
export const fitSms = (t: string): string => { const c = t.replace(GSM, "").replace(/\s+/g, " ").trim(); return c.length <= LMMX.SMS_MAX_CHARS ? c : c.slice(0, LMMX.SMS_MAX_CHARS).trimEnd(); };
/** User-supplied words placed in an SMS: letters, digits, space and a few safe marks only; no links; cut to `max`. */
export const smsSafe = (s: string, max = 24): string => s.replace(/https?:\/\/\S+|www\.\S+/gi, "").replace(/[^A-Za-z0-9 .,'&-]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
export const lmmxText = {
  /** M1 to the TENANT when a desk creates the setup. Carries the OTP and the one-tap WhatsApp link. */
  setup: (p: { rentMinor: number; landlordName: string; channel: Channel; acct: string; dueDay: number; deskCode: string; code4: string }) =>
    fitSms(`${LMMX_BRAND}: pay rent ${kes(p.rentMinor)} to ${smsSafe(p.landlordName)} (${channelLabel(p.channel)} ...${last3(p.acct)}) by day ${p.dueDay} monthly. Desk ${p.deskCode}. Code ${otpText(p.code4)} valid 30 min. Tap to confirm: ${botConfirmLink(p.code4)} or give the code to your desk.`),
  /** M2 to the TENANT when setup completes. */
  active: (p: { rentMinor: number; dueDay: number; supportPhone: string }) =>
    fitSms(`${LMMX_BRAND} is ready. Rent ${kes(p.rentMinor)}, due day ${p.dueDay}. Pay any amount from KES 10 anytime; your landlord gets the full rent on the due date. Pay or check: ${LMMX_BOT_LINK} Help: ${p.supportPhone}`),
  /** M3 to the LANDLORD when setup completes. */
  landlord: (p: { tenantFirstName: string; rentMinor: number; dueDay: number; supportPhone: string }) =>
    fitSms(`Samuhia: ${smsSafe(p.tenantFirstName, 16)} will pay you ${kes(p.rentMinor)} rent monthly via ${LMMX_BRAND}, in small amounts, sent in full on day ${p.dueDay}. Not right? Call ${p.supportPhone}. Collect rent free: ${LMMX_LANDLORD_URL}`),
  /** M4 to the TENANT for a change that needs their OTP. */
  change: (p: { deskCode: string; summary: string; code4: string }) =>
    fitSms(`${LMMX_BRAND}: desk ${p.deskCode} asks to change ${smsSafe(p.summary, 80)}. Code ${otpText(p.code4)} valid 30 min. Share it only if you agree. Confirm: ${botConfirmLink(p.code4)}`),
  /** M5 to the TENANT after they confirm a change that waits out the cooling-off. */
  changeConfirmed: (p: { applyDate: string; cancel4: string }) =>
    fitSms(`${LMMX_BRAND}: change confirmed, it starts ${shortDate(p.applyDate)}. To cancel before then send ${cancelText(p.cancel4)} to ${LMMX_BOT_LINK} or tell the PAY app.`),
  /** M6 to the OLD and the NEW landlord contact on a payout-account change. */
  landlordChange: (p: { tenantFirstName: string; applyDate: string; supportPhone: string; kind: "old" | "new"; rentMinor: number; dueDay: number }) =>
    p.kind === "old"
      ? fitSms(`Samuhia: rent from ${smsSafe(p.tenantFirstName, 16)} will go to a different account from ${shortDate(p.applyDate)}. Not right? Call ${p.supportPhone}.`)
      : fitSms(`Samuhia: ${smsSafe(p.tenantFirstName, 16)} will pay you ${kes(p.rentMinor)} rent monthly from ${shortDate(p.applyDate)} via ${LMMX_BRAND}, sent in full on day ${p.dueDay}. Not right? Call ${p.supportPhone}. ${LMMX_LANDLORD_URL}`),
};

// ------------------------------------------------------------------------------------------------------------- shared shapes
export interface RecipientInput {
  channel: Channel; bankCode?: string;            // bankCode only for channel "bank" (from the existing listKenyaBanks callable)
  accountNumber: string; accountName: string;     // the name the landlord is registered under
  contactName: string; contactPhone: string;      // landlord or agency contact; gets the landlord SMS
  reuseToken?: string;                            // from lmmx_desk_checkRecipient; only when the tenant confirmed it is the same landlord
}
export interface TenantProfileInput {
  fullName: string; phone: string; idType: IdType; idNumber: string;
  email?: string; unitNumber?: string; propertyName?: string;
}
export interface MoneyView { minor: number }
export interface PendingChangeView { changeId: string; kind: ChangeKind; status: ChangeStatus; summary: string; coolingOffUntil?: number; applyAfter?: number; initiatedBy: "desk" | "top" | "tenant" }
export interface CycleView {
  cycleId: string; status: CycleStatus; dueDate: string; payByDate: string; rentMinor: number; creditedMinor: number; remainingMinor: number; settledMinor: number; pct: number;
}
export interface InstalmentView { paymentId: string; at: number; creditMinor: number; chargeMinor: number; feesMinor: number; deskShareMinor?: number; status: "success" | "failed" | "refunded" }
export interface RecipientView { channel: Channel; accountNumber: string; resolvedNameMasked: string; nameMatch: NameMatch; status: RecipientStatus }
export interface DeskTenantRow {
  tenantId: string; nameMasked: string; phoneMasked: string; status: TenantStatus; rentMinor: number; dueDay: number; deskCode: string;
  creditedMinor: number; remainingMinor: number; createdAt: number; awaitingSince?: number;
}

// ------------------------------------------------------------------------------------------------------------- DESK callables (Firebase Auth = desk agent; CORE reads desk_agents/{uid})
export interface DeskCheckRecipientIn { channel: Channel; bankCode?: string; accountNumber: string; enteredName: string }
/** Only the account number and booleans. Never another recipient's name, contact, tenants, desks or counts. */
export interface DeskCheckRecipientOut { exists: boolean; accountNumber: string; nameMatchesEntered: boolean; reusable: boolean; reuseToken?: string }
export interface DeskCreateTenantIn { profile: TenantProfileInput; rentMinor: number; dueDay?: number; frequency?: Frequency; recipient: RecipientInput; idempotencyKey: string }
/** COG-0000 needs no tenant code: a tenant it creates comes back "active" at once (no OTP is sent). Everyone else gets "awaiting_confirmation" (or "draft" while a recipient is under review). */
export interface DeskCreateTenantOut { tenantId: string; status: "awaiting_confirmation" | "draft" | "active"; nameMatch: NameMatch; needsReview: boolean; expiresAt: number; resolvedNameMasked: string }
export interface DeskSetupStatusIn { tenantId: string }
/** What the desk screen shows: "Waiting for verification" (awaiting, with a countdown) or an OTP box; active when done. */
export interface DeskSetupStatusOut { tenantId: string; status: TenantStatus; otpExpiresAt?: number; attemptsLeft?: number; locked?: boolean; resendsLeft?: number; needsReview?: boolean }
export interface DeskConfirmSetupIn { tenantId: string; otp: string }          // otp: "LMM4683" or "4683"
export interface DeskConfirmSetupOut { tenantId: string; status: "active" }
export interface DeskResendOtpIn { tenantId: string }
export interface DeskResendOtpOut { otpExpiresAt: number; resendsLeft: number }
export interface DeskListTenantsIn { q?: string; status?: TenantStatus; cursor?: string; limit?: number }   // top desk sees every desk's tenants; a desk only its own
export interface DeskListTenantsOut { tenants: DeskTenantRow[]; nextCursor?: string }
export interface DeskGetTenantIn { tenantId: string }
export interface DeskGetTenantOut {
  tenantId: string; status: TenantStatus; deskCode: string; nameMasked: string; phoneMasked: string; idMasked: string; unitNumber?: string; propertyName?: string;
  rentMinor: number; dueDay: number; frequency: Frequency; recipient: RecipientView; cycle?: CycleView; recent: InstalmentView[];
  earningsTable: EarningsRow[]; projection: { frequency: Frequency; instalments: number; tenantPaysMinor: number; deskMinor: number; deskBonusMinor: number };
  pendingChange?: PendingChangeView; frozen?: boolean; createdAt: number;
}
export interface DeskRequestChangeIn { tenantId: string; kind: ChangeKind; rentMinor?: number; recipient?: RecipientInput; idempotencyKey: string }
export interface DeskRequestChangeOut { changeId: string; status: ChangeStatus; requiresTenantOtp: boolean; coolingOffUntil?: number; applyAfter?: number; otpExpiresAt?: number }
export interface DeskConfirmChangeIn { changeId: string; otp: string }
export interface DeskConfirmChangeOut { changeId: string; status: ChangeStatus; applyAfter?: number }
export interface DeskCancelChangeIn { changeId: string }
export interface DeskCancelChangeOut { ok: boolean }
export interface DeskEarningsIn { from: number; to: number }
export interface DeskEarningsOut { instalments: number; deskShareMinor: number; completionBonusMinor: number; landlordBonusMinor: number; byTenant: { tenantId: string; nameMasked: string; deskShareMinor: number }[] }
export interface DeskPreviewIn { rentMinor: number; channel: Channel; creditMinor?: number }
export interface DeskPreviewOut { table: EarningsRow[]; projection: Record<Frequency, { instalments: number; tenantPaysMinor: number; deskMinor: number; deskBonusMinor: number }> }
export interface PipelineRow { leadIdMasked: string; landlordLabel: string; tenants: number; monthlyRentMinor: number; stage: LeadStage; onPms: boolean; conversionNote: string }
export interface DeskPipelineIn { cursor?: string }
export interface DeskPipelineOut { landlords: PipelineRow[]; nextCursor?: string }

// ------------------------------------------------------------------------------------------------------------- TOP DESK callables (COG-0000 only: verified @samuhia.co.ke, sign-in within 15 minutes, a written reason on every change)
export interface TopReviewRow { recipientId: string; channel: Channel; accountNumber: string; reason: "name_mismatch" | "shared_recipient" | "other"; tenants: number; desks: number; createdAt: number }
export interface TopReviewQueueOut { items: TopReviewRow[] }
export interface TopReviewDecisionIn { recipientId: string; decision: "approve" | "reject"; reason: string }
export interface TopFreezeIn { scope: "tenant" | "recipient" | "desk"; id: string; reason: string }
export interface TopUnfreezeIn { scope: "tenant" | "recipient" | "desk"; id: string; reason: string }
export interface TopReassignIn { tenantId: string; toDeskCode: string; reason: string }
export interface TopRevealIn { tenantId: string; fields: ("phone" | "id" | "landlordContact" | "landlordName")[]; reason: string }
export interface TopRevealOut { values: Partial<Record<"phone" | "id" | "landlordContact" | "landlordName", string>> }
/** A change started by COG-0000 applies at once: no tenant OTP, no cooling-off. The tenant and both landlord contacts are told by SMS. */
export interface TopUpdateTenantIn { tenantId: string; rentMinor?: number; recipient?: RecipientInput; dueDay?: number; reason: string }
export interface AuditRow { seq: number; ts: number; action: AuditAction; actor: { type: "desk" | "top" | "tenant" | "system" | "bot"; deskCode?: string }; tenantId?: string; summary: string; hash: string }
export interface TopAuditListIn { tenantId?: string; action?: AuditAction; deskCode?: string; from?: number; to?: number; cursor?: number; limit?: number }
export interface TopAuditListOut { rows: AuditRow[]; nextCursor?: number }
export interface TopAuditVerifyIn { fromSeq?: number; toSeq?: number }
export interface TopAuditVerifyOut { ok: boolean; checked: number; brokenAtSeq?: number }
export interface LeadRow { leadId: string; landlordLabel: string; tenants: number; monthlyRentMinor: number; deskCodes: string[]; stage: LeadStage; nextFollowUpAt?: number; onPms: boolean; updatedAt: number }
export interface TopLeadsListIn { stage?: LeadStage; q?: string; cursor?: string; limit?: number }
export interface TopLeadsListOut { leads: LeadRow[]; nextCursor?: string }
export interface TopLeadGetIn { leadId: string }
export interface TopLeadGetOut extends LeadRow { contactName: string; contactPhone: string; notes: { ts: number; by: string; text: string }[] }
export interface TopLeadUpdateIn { leadId: string; stage?: LeadStage; note?: string; nextFollowUpAt?: number | null }
export interface TopStatsOut { tenants: Record<TenantStatus, number>; creditedThisMonthMinor: number; settledThisMonthMinor: number; payoutsPaused: boolean; standaloneEnabled: boolean; openAlerts: number; reviewQueue: number }

// ------------------------------------------------------------------------------------------------------------- TENANT callables (Firebase Auth = the tenant, phone-verified via sendLoginOtp/verifyLoginOtp)
export interface TenantLinkIn { idType: IdType; idNumber: string }
/** Same generic failure whether the phone or the ID was wrong. `kinds` says which accounts matched the verified phone AND the ID. */
export interface TenantLinkOut { kinds: ("lmm" | "legacy")[] }
export interface TenantSummaryOut {
  status: TenantStatus; firstName: string; rentMinor: number; dueDay: number; frequency: Frequency; cycle?: CycleView; recipient: RecipientView;
  suggestedCreditMinor: number; pendingChange?: PendingChangeView; awaitingSetup?: { otpExpiresAt: number; summary: string }; frozen?: boolean; supportPhone: string;
}
export interface TenantHistoryIn { cursor?: string }
export interface TenantHistoryOut { items: InstalmentView[]; nextCursor?: string }
export interface TenantQuoteIn { creditMinor: number }
export interface TenantQuoteOut { quoteId: string; expiresAt: number; creditMinor: number; transferReserveMinor: number; serviceFeeMinor: number; collectionAllowanceMinor: number; chargeMinor: number; feesMinor: number; payByDate: string; remainingAfterMinor: number }
export interface TenantPayIn { quoteId: string; payerPhone: string }
export interface TenantPayOut { reference: string; displayText: string; chargeMinor: number }
export interface TenantSetDueDayIn { dueDay: number }
export interface TenantSetDueDayOut { dueDay: number; effectiveFromCycleDate: string }
export interface TenantSetPlanIn { frequency: Frequency; suggestedCreditMinor?: number }
export interface TenantConfirmSetupIn { otp: string }
export interface TenantConfirmChangeIn { changeId: string; otp: string }
export interface TenantCancelChangeIn { changeId: string; cancelCode: string }

// ------------------------------------------------------------------------------------------------------------- BOT callables (the WhatsApp bot in DESK/functions)
/** Every bot call carries { ..., ts, nonce, sig }: sig = hex HMAC-SHA256(key LMMX_BOT_KEY from app-secrets-bundle, `${op}|${ts}|${nonce}|${canonicalJson(payload without sig)}`), ts within 5 minutes. canonicalJson = JSON with keys sorted. */
export interface BotAuth { ts: number; nonce: string; sig: string }
/** JSON with object keys sorted at every level, no spaces. Both sides must produce the identical string. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k])).join(",") + "}";
}
/** The exact string the bot signs: `${op}|${ts}|${nonce}|${canonicalJson(payload without ts, nonce, sig)}`. sig = lowercase hex HMAC-SHA256 of it with LMMX_BOT_KEY. */
export function botSigMessage(op: string, ts: number, nonce: string, payload: Record<string, unknown>): string {
  const { ts: _t, nonce: _n, sig: _s, ...rest } = payload as Record<string, unknown>;
  void _t; void _n; void _s;
  return `${op}|${ts}|${nonce}|${canonicalJson(rest)}`;
}
export const BOT_SIG_MAX_AGE_MS = 5 * 60_000;
export type BotKind = "standalone" | "legacy" | "none";
export interface BotLookupIn extends BotAuth { phone: string; idNumber: string }   // phone = the WhatsApp sender in E.164
/** `none` and a phone/ID mismatch return the identical shape (no enumeration). */
export interface BotLookupOut { kind: BotKind; standalone?: { firstName: string; rentMinor: number; remainingMinor: number; dueDate: string; payByDate: string; suggestedCreditMinor: number; frozen?: boolean; awaitingSetup?: boolean } }
export interface BotQuoteIn extends BotAuth { phone: string; idNumber: string; creditMinor: number }
export interface BotQuoteOut extends TenantQuoteOut {}
export interface BotPayIn extends BotAuth { phone: string; idNumber: string; quoteId: string; payerPhone: string }
export interface BotPayOut extends TenantPayOut {}
/** A message that is only LMM#### or LMC#### is sent here, from ANY bot state. The sender's WhatsApp number must equal the tenant's phone on file. */
export interface BotConfirmCodeIn extends BotAuth { phone: string; text: string }
export interface BotConfirmCodeOut { result: "setup_confirmed" | "change_confirmed" | "change_cancelled" | "invalid" | "expired" | "locked" | "not_found"; summary?: string }
export interface BotJoinInfoIn extends BotAuth { _?: never }
export interface BotJoinInfoOut { supportPhones: string[]; text: string }

// ------------------------------------------------------------------------------------------------------------- callable map
export interface LmmxCallableMap {
  lmmx_desk_checkRecipient: { in: DeskCheckRecipientIn; out: DeskCheckRecipientOut };
  lmmx_desk_createTenant: { in: DeskCreateTenantIn; out: DeskCreateTenantOut };
  lmmx_desk_setupStatus: { in: DeskSetupStatusIn; out: DeskSetupStatusOut };
  lmmx_desk_confirmSetup: { in: DeskConfirmSetupIn; out: DeskConfirmSetupOut };
  lmmx_desk_resendOtp: { in: DeskResendOtpIn; out: DeskResendOtpOut };
  lmmx_desk_listTenants: { in: DeskListTenantsIn; out: DeskListTenantsOut };
  lmmx_desk_getTenant: { in: DeskGetTenantIn; out: DeskGetTenantOut };
  lmmx_desk_requestChange: { in: DeskRequestChangeIn; out: DeskRequestChangeOut };
  lmmx_desk_confirmChange: { in: DeskConfirmChangeIn; out: DeskConfirmChangeOut };
  lmmx_desk_cancelChange: { in: DeskCancelChangeIn; out: DeskCancelChangeOut };
  lmmx_desk_earnings: { in: DeskEarningsIn; out: DeskEarningsOut };
  lmmx_desk_preview: { in: DeskPreviewIn; out: DeskPreviewOut };
  lmmx_desk_pipeline: { in: DeskPipelineIn; out: DeskPipelineOut };
  lmmx_top_reviewQueue: { in: Record<string, never>; out: TopReviewQueueOut };
  lmmx_top_reviewDecision: { in: TopReviewDecisionIn; out: { ok: boolean } };
  lmmx_top_freeze: { in: TopFreezeIn; out: { ok: boolean } };
  lmmx_top_unfreeze: { in: TopUnfreezeIn; out: { ok: boolean } };
  lmmx_top_reassign: { in: TopReassignIn; out: { ok: boolean } };
  lmmx_top_reveal: { in: TopRevealIn; out: TopRevealOut };
  lmmx_top_updateTenant: { in: TopUpdateTenantIn; out: { ok: boolean } };
  lmmx_top_auditList: { in: TopAuditListIn; out: TopAuditListOut };
  lmmx_top_auditVerify: { in: TopAuditVerifyIn; out: TopAuditVerifyOut };
  lmmx_top_leadsList: { in: TopLeadsListIn; out: TopLeadsListOut };
  lmmx_top_leadGet: { in: TopLeadGetIn; out: TopLeadGetOut };
  lmmx_top_leadUpdate: { in: TopLeadUpdateIn; out: { ok: boolean } };
  lmmx_top_stats: { in: Record<string, never>; out: TopStatsOut };
  lmmx_tenant_link: { in: TenantLinkIn; out: TenantLinkOut };
  lmmx_tenant_summary: { in: Record<string, never>; out: TenantSummaryOut };
  lmmx_tenant_history: { in: TenantHistoryIn; out: TenantHistoryOut };
  lmmx_tenant_quote: { in: TenantQuoteIn; out: TenantQuoteOut };
  lmmx_tenant_pay: { in: TenantPayIn; out: TenantPayOut };
  lmmx_tenant_setDueDay: { in: TenantSetDueDayIn; out: TenantSetDueDayOut };
  lmmx_tenant_setPlan: { in: TenantSetPlanIn; out: { ok: boolean } };
  lmmx_tenant_confirmSetup: { in: TenantConfirmSetupIn; out: { status: "active" } };
  lmmx_tenant_confirmChange: { in: TenantConfirmChangeIn; out: DeskConfirmChangeOut };
  lmmx_tenant_cancelChange: { in: TenantCancelChangeIn; out: { ok: boolean } };
  lmmx_bot_lookup: { in: BotLookupIn; out: BotLookupOut };
  lmmx_bot_quote: { in: BotQuoteIn; out: BotQuoteOut };
  lmmx_bot_pay: { in: BotPayIn; out: BotPayOut };
  lmmx_bot_confirmCode: { in: BotConfirmCodeIn; out: BotConfirmCodeOut };
  lmmx_bot_joinInfo: { in: BotJoinInfoIn; out: BotJoinInfoOut };
}
export type LmmxCallableName = keyof LmmxCallableMap;
export const LMMX_DESK_CALLABLES = ["lmmx_desk_checkRecipient", "lmmx_desk_createTenant", "lmmx_desk_setupStatus", "lmmx_desk_confirmSetup", "lmmx_desk_resendOtp", "lmmx_desk_listTenants", "lmmx_desk_getTenant", "lmmx_desk_requestChange", "lmmx_desk_confirmChange", "lmmx_desk_cancelChange", "lmmx_desk_earnings", "lmmx_desk_preview", "lmmx_desk_pipeline"] as const;
export const LMMX_TOP_CALLABLES = ["lmmx_top_reviewQueue", "lmmx_top_reviewDecision", "lmmx_top_freeze", "lmmx_top_unfreeze", "lmmx_top_reassign", "lmmx_top_reveal", "lmmx_top_updateTenant", "lmmx_top_auditList", "lmmx_top_auditVerify", "lmmx_top_leadsList", "lmmx_top_leadGet", "lmmx_top_leadUpdate", "lmmx_top_stats"] as const;
export const LMMX_TENANT_CALLABLES = ["lmmx_tenant_link", "lmmx_tenant_summary", "lmmx_tenant_history", "lmmx_tenant_quote", "lmmx_tenant_pay", "lmmx_tenant_setDueDay", "lmmx_tenant_setPlan", "lmmx_tenant_confirmSetup", "lmmx_tenant_confirmChange", "lmmx_tenant_cancelChange"] as const;
export const LMMX_BOT_CALLABLES = ["lmmx_bot_lookup", "lmmx_bot_quote", "lmmx_bot_pay", "lmmx_bot_confirmCode", "lmmx_bot_joinInfo"] as const;
