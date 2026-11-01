// Lipa Mos Mos (pay rent a little at a time). EVERY number that decides where money goes or how much lives here, in code.
// Nothing in this file is read from Firestore: someone editing the database must not be able to loosen a limit or redirect an alert.
export const LMM = {
  /** Who is told when anything looks wrong (HostPinnacle MSISDN for 0791286165). */
  ALERT_MOBILE: "254791286165",
  /** Tenant surcharge on top of what is credited to their rent: 2.5% (Paystack 1.5% + 1% service), 5% for payments under KES 100. */
  SURCHARGE_BPS: 250,
  SMALL_SURCHARGE_BPS: 500,
  SMALL_BELOW_MINOR: 10_000,            // KES 100
  MIN_CREDIT_MINOR: 1_000,              // KES 10 (whole shillings only)
  MAX_CREDIT_MINOR: 15_000_000,         // KES 150,000 per instalment
  /** The landlord is paid when the plan reaches its target, or on this day of the month with whatever is in. */
  SETTLE_DAY: 5,
  MIN_SETTLEMENT_MINOR: 30_000,         // KES 300: below this the KES 95 transfer fee would eat the payout; it waits for the next run
  MAX_SETTLEMENT_MINOR: 90_000_000,     // KES 900,000: the top of the transfer-fee table; nothing larger is ever sent automatically
  WALLET_MAX_TRANSFER_MINOR: 15_000_000, // Paystack's M-PESA wallet limit per transfer
  /** Hard ceiling on what this feature may send out in one Nairobi day, across all landlords. */
  DAILY_OUTFLOW_CAP_MINOR: 200_000_000, // KES 2,000,000
  /** Landlord/agency transfer fee, by the amount being transferred (minor units). Up to 10,000 -> 95 | below 40,000 -> 183 | up to 900,000 -> 257. */
  FEE_TIERS: [
    { upToMinor: 1_000_000, feeMinor: 9_500 },
    { upToMinor: 3_999_999, feeMinor: 18_300 },
    { upToMinor: 90_000_000, feeMinor: 25_700 },
  ],
  /** Reminder rhythm per plan frequency: days without a payment before a "missed" SMS, and the days between reminders. */
  MISSED_AFTER_DAYS: { daily: 2, weekly: 8, biweekly: 15 },
  MIN_DAYS_BETWEEN_SMS: 3,
  MILESTONES: [25, 50, 75, 100],
  /** A charge that was never confirmed is dead after this long. */
  PENDING_PAYMENT_TTL_MS: 24 * 3_600_000,
} as const;

export type Frequency = "daily" | "weekly" | "biweekly";
export const FREQUENCIES: readonly Frequency[] = ["daily", "weekly", "biweekly"];
export const FREQUENCY_DAYS: Record<Frequency, number> = { daily: 1, weekly: 7, biweekly: 14 };
export const isFrequency = (v: unknown): v is Frequency => typeof v === "string" && (FREQUENCIES as readonly string[]).includes(v);
