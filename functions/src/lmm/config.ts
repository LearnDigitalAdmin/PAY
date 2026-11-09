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
  /** The landlord is paid when the plan reaches its target, or on the earliest open invoice's DUE DATE with whatever is in. Only a tenant with no open invoice falls back to this day of the month. */
  SETTLE_DAY: 5,
  /** KES 300. Up to and including this, the transfer is priced at Paystack's cost + MARGIN_MINOR (KES 30 to a wallet). Below it the TENANT bears that fee (see fees.ts). */
  MIN_SETTLEMENT_MINOR: 30_000,
  MAX_SETTLEMENT_MINOR: 90_000_000,     // KES 900,000: the top of the transfer-fee table; nothing larger is ever sent automatically
  WALLET_MAX_TRANSFER_MINOR: 15_000_000, // Paystack's M-PESA wallet limit per transfer
  /** Hard ceiling on what this feature may send out in one Nairobi day, across all landlords. */
  DAILY_OUTFLOW_CAP_MINOR: 200_000_000, // KES 2,000,000
  /**
   * What PAYSTACK charges US per transfer, by recipient type and the amount sent (minor units). Source: Paystack Kenya transfer pricing
   * (support.paystack.com/en/articles/2132866). Re-check against the Paystack dashboard after any price change; excise duty is NOT included.
   * NOTE: the first Till row on Paystack's page is garbled; KES 40 for up to KES 1,500 is assumed (the dearer reading is KES 80, which this
   * table's margin guard would NOT cover - confirm on the dashboard).
   */
  PAYSTACK_TRANSFER_COST: {
    mobile_money: [{ upToMinor: 150_000, costMinor: 2_000 }, { upToMinor: 2_000_000, costMinor: 4_000 }, { upToMinor: 15_000_000, costMinor: 6_000 }],
    mobile_money_business: [{ upToMinor: 150_000, costMinor: 4_000 }, { upToMinor: 1_000_000, costMinor: 8_000 }, { upToMinor: 4_000_000, costMinor: 14_000 }, { upToMinor: 99_900_000, costMinor: 18_000 }],
    kepss: [{ upToMinor: 1_000_000, costMinor: 8_000 }, { upToMinor: 5_000_000, costMinor: 12_000 }, { upToMinor: 99_999_900, costMinor: 14_000 }],
  },
  /** Our smallest mark-up over Paystack's cost on any transfer: KES 10. The fee is never below cost + this. */
  MARGIN_MINOR: 1_000,
  /** Paystack will not send less than KES 10. */
  MIN_SEND_MINOR: 1_000,
  /**
   * What the landlord is charged for a transfer above KES 300 (always >= Paystack's cost + MARGIN_MINOR, whichever is higher).
   *  Band 1, up to KES 10,000: 0.95% of the amount, but never below the floor for its size (KES 36 up to 1,500; KES 60 from 1,501), so it reaches
   *    KES 95 at KES 10,000. Band 2, KES 10,001 to 39,999: rises evenly from KES 120 to KES 183. Band 3, KES 40,000 to 900,000: KES 257 flat.
   */
  FEE_BAND1: { topMinor: 1_000_000, pctBps: 95, floors: [{ upToMinor: 150_000, feeMinor: 3_600 }, { upToMinor: 1_000_000, feeMinor: 6_000 }] },
  FEE_BAND2: { fromMinor: 1_000_000, toMinor: 4_000_000, lowMinor: 12_000, highMinor: 18_300 },
  FEE_BAND3_MINOR: 25_700,
  /** Tenants with less than KES 300 credited are warned this many days before the due date that a transfer fee will come off. */
  WARN_DAYS_BEFORE_DUE: 5,
  /** Reminder rhythm per plan frequency: days without a payment before a "missed" SMS, and the days between reminders. */
  MISSED_AFTER_DAYS: { daily: 2, weekly: 8, biweekly: 15 },
  MIN_DAYS_BETWEEN_SMS: 3,
  MILESTONES: [25, 50, 75, 100],
  /** A charge that was never confirmed is dead after this long. */
  PENDING_PAYMENT_TTL_MS: 24 * 3_600_000,
} as const;

export type PayoutKind = "mobile_money" | "mobile_money_business" | "kepss";
export type Frequency = "daily" | "weekly" | "biweekly";
export const FREQUENCIES: readonly Frequency[] = ["daily", "weekly", "biweekly"];
export const FREQUENCY_DAYS: Record<Frequency, number> = { daily: 1, weekly: 7, biweekly: 14 };
export const isFrequency = (v: unknown): v is Frequency => typeof v === "string" && (FREQUENCIES as readonly string[]).includes(v);
