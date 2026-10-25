// Landlord Watch constants. The shared contract (LANDLORD_WATCH_CONTRACT.md v1.1) is the source of these numbers.
export const OWNER_ID_PATTERN = /^PYP-\d{4,}$/;
export const KE_MOBILE = /^\+254[17]\d{8}$/;

/** One free transcript per property per calendar month (Africa/Nairobi), shared by every channel. */
export const FREE_TRANSCRIPTS_PER_MONTH = 1;
/** Every extra transcript costs exactly this. We absorb the gateway fee: the customer is never charged more. */
export const EXTRA_TRANSCRIPT_PRICE_KES = 99;

/** Agency remittance date: the 15th of the billing month. */
export const REMITTANCE_DAY = 15;
export const TREND_MONTHS = 6;

export const OTP_TTL_MS = 5 * 60_000;
export const OTP_RESEND_COOLDOWN_MS = 60_000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_MAX_SENDS_PER_PHONE_PER_HOUR = 5;

export const LOOKUPS_PER_HOUR = 20;
export const MAX_CONNECTIONS = 25;

const HOUR = 3_600_000;
/** How long an OTP unlock lasts, by channel. CYBER is a third party's device, so it is short. */
export const UNLOCK_TTL_MS = { pms: 12 * HOUR, whatsapp: 12 * HOUR, cyber: 30 * 60_000 } as const;

export const SNAPSHOT_TTL_CURRENT_MS = 10 * 60_000;
export const SNAPSHOT_TTL_PAST_MS = 6 * HOUR;

export const SIGNED_URL_TTL_MS = 15 * 60_000;
/** A generated transcript can be fetched again (new signed URL, no OTP, no charge) for this long. */
export const TRANSCRIPT_REUSE_MS = 24 * HOUR;
/** A transcript request that never completes is abandoned after this long. */
export const TRANSCRIPT_REQUEST_TTL_MS = 2 * HOUR;
export const LIST_LIMIT = 12;
