/**
 * MyChama <-> PAY connector CONTRACT (v1).
 *
 * Pure types + constants + path builders. NO imports, so the byte-identical
 * copy at  src/mychama/contract.ts  (frontend) compiles unchanged.
 * `npm run check:mychama-contract` (repo root) fails if the two copies drift.
 *
 * FROZEN after P0. Tracks A/B/C must NOT edit this file; request changes via
 * the integrator (see docs/mychama/CONNECTOR_CONTRACT.md §10).
 * All money = KES, major units (numbers, 2dp), never strings.
 */

export const MYCHAMA_CONTRACT_VERSION = 1;
export const MYCHAMA_REGION = "africa-south1";

export const MYCHAMA_CALLABLES = {
  sync: "mychamaSync",
  requestCode: "mychamaLinkRequestCode",
  verifyCode: "mychamaLinkVerifyCode",
  payInitiate: "mychamaPayInitiate",
} as const;
/** HTTPS webhook (Paystack -> new MyChama account). Not a callable. */
export const MYCHAMA_WEBHOOK_NAME = "mychamaPaystackCallback";

/** Tunable defaults. Track A/B may READ these; changing them = contract change. */
export const MYCHAMA_LIMITS = {
  SYNC_COOLDOWN_SECONDS: 600,          // auto syncs (reload/login) inside this window return stored data
  SYNC_MANUAL_COOLDOWN_SECONDS: 30,    // manual refresh floor
  SNAPSHOT_STALE_AFTER_SECONDS: 21600, // 6h without a successful sync => status "stale"
  SNAPSHOT_MAX_ITEMS_PER_LIST: 50,     // cap per contributions/loans list inside one chama
  CODE_LENGTH: 6,
  CODE_TTL_SECONDS: 600,
  CODE_MAX_ATTEMPTS: 5,
  CODE_RESEND_COOLDOWN_SECONDS: 60,
  CODE_MAX_SENDS_PER_PHONE_PER_DAY: 5,
  CODE_MAX_SENDS_PER_USER_PER_DAY: 10,
} as const;

// ───────────────────────────── enums ─────────────────────────────

export type PortalRole = "landlord" | "tenant";
export type ConnectorStatus = "ok" | "stale" | "unavailable" | "never_linked" | "needs_reverify";
export type SyncReason = "login" | "reload" | "manual";
export type LinkState = "active" | "needs_reverify" | "revoked";
export type LinkVerifiedVia = "firebase_phone" | "sms_code";
export type MyChamaPurpose = "contribution" | "loan_repayment" | "mgr_contribution";
export type ChamaDataStatus = "ok" | "partial" | "unavailable";
export type ChamaDataSection = "contributions" | "loans" | "mgr";

export type MyChamaErrorCode =
  | "unauthenticated"
  | "not_linked"
  | "link_needs_reverify"
  | "throttled"
  | "chama_unavailable"
  | "online_collection_disabled"
  | "invalid_amount"
  | "invalid_target"
  | "invalid_phone"
  | "rate_limited"
  | "code_invalid"
  | "code_expired"
  | "code_attempts_exceeded"
  | "send_limit_reached"
  | "upstream_failure"
  | "not_implemented"
  | "internal";
/** Every thrown HttpsError carries details = { code: MyChamaErrorCode }. */
export interface MyChamaErrorDetails { code: MyChamaErrorCode; retryAfterSeconds?: number }

// ───────────────────────── plot-project paths ─────────────────────────
// (plot project = this repo's default Firestore). Clients may READ
// chamaSnapshots/{uid} and chamaLinks/{uid}/links/*; everything is
// WRITTEN ONLY by Cloud Functions. See docs/mychama/firestore.rules.fragment.

export const MYCHAMA_PATHS = {
  snapshot: (uid: string) => `chamaSnapshots/${uid}`,
  links: (uid: string) => `chamaLinks/${uid}/links`,
  link: (uid: string, linkId: string) => `chamaLinks/${uid}/links/${linkId}`,
  challenge: (challengeId: string) => `chamaLinkChallenges/${challengeId}`,   // server-only
  syncState: (uid: string) => `chamaSyncState/${uid}`,                        // server-only
} as const;

/** linkId = `${chamaId}__${memberId}` */
export const makeLinkId = (chamaId: string, memberId: string) => `${chamaId}__${memberId}`;

// ───────────────────────────── documents ─────────────────────────────

/** chamaLinks/{uid}/links/{linkId}. Never contains an ID number or a full phone. */
export interface ChamaLinkDoc {
  linkId: string;
  uid: string;
  chamaId: string;
  memberId: string;
  chamaName: string;
  state: LinkState;
  verifiedVia: LinkVerifiedVia;
  /** HMAC key of the phone this link was verified against (see config.phoneKey). If the
   *  member's phone in mychama1 stops matching, Track A sets state="needs_reverify". */
  boundPhoneKey: string;
  boundPhoneMasked: string;            // e.g. "07•• ••• 123"
  linkedAt: number;                    // epoch ms
  updatedAt: number;
}

export interface ContributionItem {
  contributionId: string;
  periodKey: string;                   // YYYY-MM
  dueDate: string | null;              // YYYY-MM-DD
  amount: number;
  paid: number;
  outstanding: number;
  status: string;
}
export interface ContributionsSnap {
  items: ContributionItem[];           // unpaid/partial only, capped (SNAPSHOT_MAX_ITEMS_PER_LIST)
  outstanding: number;
}

export interface LoanItem {
  loanId: string;
  principal: number;
  outstanding: number;
  status: string;
  installmentsRemaining: number;
  nextInstallment: { installmentNo: number; due: number; dueDate: string | null } | null;
}
export interface LoansSnap { items: LoanItem[]; outstanding: number }

export interface MgrWin {
  kind: "won" | "scheduled";
  potId: string;
  potName: string;
  round: number;
  amount: number | null;               // null when the payout amount can't be known yet
  expectedDate: string | null;         // YYYY-MM-DD; null when unknown
  queuePosition: number | null;        // 1-based, scheduled wins only
}
export interface MgrPotSnap {
  potId: string;
  name: string;
  amountPerPeriod: number;
  frequency: string;
  status: string;
  period: number;
  currentPeriodPaid: boolean;
  dueNow: number;                      // 0 when currentPeriodPaid
  nextDueDate: string | null;
  arrearsOpen: number;
  arrearId: string | null;
  wins: MgrWin[];
}
export interface MgrSnap { pots: MgrPotSnap[]; dueNow: number; arrearsOpen: number }

export interface ChamaTotals {
  /** unpaid amounts whose dueDate is before today (EAT) — contributions + loan installments + MGR arrears/period due */
  overdue: number;
  /** unpaid amounts with dueDate inside the current EAT calendar month and NOT overdue */
  dueThisMonth: number;
  /** sum of MGR win amounts with expectedDate in the current EAT month (known amounts only) */
  expectedInflowThisMonth: number;
}

export interface ChamaSnapshotChama {
  chamaId: string;
  chamaName: string;
  memberId: string;
  onlineCollectionEnabled: boolean;    // plan allows it AND settlementSplitCode present
  dataStatus: ChamaDataStatus;
  missing: ChamaDataSection[];         // sections that could not be read this sync
  contributions: ContributionsSnap | null;   // null = unavailable (NOT zero)
  loans: LoansSnap | null;
  mgr: MgrSnap | null;
  totals: ChamaTotals | null;          // null if every section is unavailable
  asOf: number;                        // epoch ms of the sync that produced this entry
}

/** A phone registered in mychama1 for the caller's ID that is NOT yet proven. */
export interface PendingVerification {
  pendingId: string;                   // opaque; pass to mychamaLinkRequestCode
  maskedPhone: string;
  chamaCount: number;
}

/** chamaSnapshots/{uid} — the ONE doc the UI listens to. */
export interface ChamaSnapshotDoc {
  version: typeof MYCHAMA_CONTRACT_VERSION;
  uid: string;
  status: ConnectorStatus;
  lastSyncedAt: number | null;         // last SUCCESSFUL sync
  lastAttemptAt: number | null;
  lastError: { code: MyChamaErrorCode; at: number } | null;
  chamas: ChamaSnapshotChama[];
  pending: PendingVerification[];
}

// ───────────────────────────── callables ─────────────────────────────

export interface SyncRequest { reason: SyncReason; force?: boolean }
export interface SyncResponse {
  status: ConnectorStatus;
  throttled: boolean;
  lastSyncedAt: number | null;
  nextAllowedAt: number | null;
}

export interface RequestCodeRequest { pendingId: string }
export interface RequestCodeResponse {
  challengeId: string;
  maskedPhone: string;
  expiresAt: number;
  resendAfter: number;
}

export interface VerifyCodeRequest { challengeId: string; code: string }
export interface VerifyCodeResponse { linkedChamas: number; remainingAttempts?: number }

export interface PayInitiateRequest {
  chamaId: string;
  purpose: MyChamaPurpose;
  amount: number;                      // NET KES that must reach the chama (fees are grossed up server-side)
  contributionId?: string;
  loanId?: string;
  installmentNo?: number;
  potId?: string;
  potPeriod?: number;
  arrearId?: string;
  phone?: string;                      // M-Pesa/Airtel number to charge; defaults to the member's phone on file
  clientRequestId: string;             // idempotency key
}
export interface PayInitiateResponse {
  reference: string;                   // MCA-{chamaId}-{CNT|LNR|MGR}-{epochMs}-{rand6}
  grossAmount: number;
  paystackFee: number;
  ourFee: number;
  message: string | null;              // Paystack display_text for the STK prompt
}
