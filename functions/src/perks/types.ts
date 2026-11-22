// Perks domain types and constants. Pure: no imports from the rest of PAY/functions.
export class PerksError extends Error {
  constructor(public code: "invalid-argument" | "failed-precondition" | "not-found" | "permission-denied" | "already-exists" | "aborted" | "unimplemented", message: string) { super(message); }
}

/** Firestore collections (default database). Server-only: client rules deny everything on these. */
export const P = {
  settings: "perks_settings", customers: "perks_customers", codes: "perks_codes", tx: "perks_tx", ledger: "perks_ledger",
  referrals: "perks_referrals", redemptions: "perks_redemptions", vouchers: "perks_vouchers", campaigns: "perks_campaigns",
  templates: "perks_templates", smsLog: "perks_smsLog", audit: "perks_audit", consentLog: "perks_consentLog", config: "perks_config",
} as const;

export type ItemType = "SERVICE" | "PRODUCT";
export type VoucherType = "DISCOUNT" | "AIRTIME" | "POINTS";
export type VoucherStatus = "AVAILABLE" | "AWARDED" | "REDEEMED" | "VOID";

export interface PerksSettings {
  servicesPointsRate: number; productsPointsRate: number; pointsValue: number; pointsValueUnit: number; minimumRedemption: number;
  referrerReward: number; inviteeReward: number; referralMinimumPurchase: number; smsCost: number; activeCampaignId: string;
  /** Operator-visible switch. The draw also needs drawProductionApproved, which is NEVER settable through the API. */
  referralDrawEnabled: boolean; drawProductionApproved: boolean;
}
export const DEFAULT_SETTINGS: PerksSettings = {
  servicesPointsRate: 7, productsPointsRate: 4, pointsValue: 20, pointsValueUnit: 100, minimumRedemption: 100,
  referrerReward: 50, inviteeReward: 30, referralMinimumPurchase: 50, smsCost: 0.2, activeCampaignId: "",
  referralDrawEnabled: false, drawProductionApproved: false,
};

export type NotificationType = "sale" | "redeem" | "referralReferrer" | "referralInvitee" | "voucher" | "welcome";
export interface Notification { customerId: string; type: NotificationType; vars: Record<string, string | number>; transactionId?: string }
