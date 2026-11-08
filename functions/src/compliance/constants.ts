// Compliance reports (MRI working paper + annual rental income summary), per property.
// Statutory figures: Kenya Revenue Authority, Monthly Rental Income (MRI) regime, Income Tax Act s.6A.
export const MRI_RATE_PCT = 7.5;                         // % of gross residential rent received; no deductions allowed
export const MRI_MIN_ANNUAL_KES = 288_000;               // KES 24,000 a month
export const MRI_MAX_ANNUAL_KES = 15_000_000;
export const MRI_DUE_DAY = 20;                           // the 20th of the month after the rent was received

export const REPORT_PRICE_KES = 200;
export const REPORT_PRICE_MINOR = REPORT_PRICE_KES * 100;
export const FREE_REPORTS_PER_PROPERTY_PER_MONTH = 1;    // Business and above, per property, per calendar month (Africa/Nairobi)
/** Plans that include one free report per property per month. Anything else (free, starter, solo, unknown) pays. */
export const FREE_TIERS: readonly string[] = ["business", "pro", "professional", "enterprise"];

/** Desk add-on: never free. The agent takes the price less Paystack (1.5%) and the platform cut (15%) = 83.5%. */
export const DESK_PAYSTACK_PCT = 1.5;
export const DESK_PLATFORM_PCT = 15;

export const REPORT_KINDS = ["mri_monthly", "annual_summary"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export const REPORT_TITLE: Record<ReportKind, string> = {
  mri_monthly: "Monthly Rental Income (MRI) working paper",
  annual_summary: "Annual rental income summary",
};

export const SIGNED_URL_TTL_MS = 15 * 60_000;
export const REPORT_REUSE_MS = 7 * 24 * 3_600_000;       // a paid report can be fetched again (new link, no charge) for 7 days
export const REPORT_LOCK_MS = 180_000;
export const PAY_COOLDOWN_MS = 60_000;
export const ORDER_TTL_MS = 2 * 3_600_000;               // an order that is never paid for is abandoned
export const LIST_LIMIT = 20;
export const MAX_TENANTS = 1500;
export const MAX_INVOICES = 20_000;
export const MAX_INPUT_BYTES = 900_000;                  // stays under Firestore's 1 MiB document limit

export const REPORT_VERSION = "cr-1.0";
