import type { Channel, ChangeKind, ChangeStatus, CycleStatus, Frequency, IdType, NameMatch, RecipientStatus, TenantStatus, LeadStage } from "./contract";

export interface TenantDoc {
  tenantId: string; status: TenantStatus; deskCode: string; deskUid: string; createdAt: number; updatedAt: number;
  rentSource: "lmm" | "pms"; pmsLink?: { landlordId: string; switchedAt: number; fromDue?: string };
  nameEnc: string; nameTokens: string[]; phoneEnc: string; phoneHash: string; idType: IdType; idEnc: string; idHash: string;
  email?: string; unitNumber?: string; propertyName?: string;
  consentAt?: number; landlordNoticeAt?: number; rent: { amountMinor: number; effectiveFromDue?: string }; dueDay: number; dueDayChangedCycleId?: string;
  frequency: Frequency; suggestedCreditMinor: number; activeRecipientId: string; pendingRecipientId?: string;
  authUid?: string; frozen?: boolean; frozenReason?: string; setupExpiresAt?: number; needsReview?: boolean; lastPaymentAt?: number; lastCycleDue?: string; lastSmsAt?: number; missedCount?: number;
  cur?: { creditedMinor: number; remainingMinor: number; dueDate: string };
}
export interface RecipientDoc {
  recipientId: string; channel: Channel; bankCode: string; paystackType: "mobile_money" | "mobile_money_business" | "kepss"; paystackBankCode: string;
  accountNumber: string; acctKey: string; fp: string; recipientCode: string; seal: string;
  resolvedNameEnc: string; enteredNameEnc: string; nameKey: string; resolvedNameMasked: string; nameMatch: NameMatch;
  contactNameEnc: string; contactKey: string; contactPhoneEnc: string; contactPhoneHash: string;
  status: RecipientStatus; reviewReason?: "name_mismatch" | "shared_recipient" | "other"; verifiedAt?: number; createdAt: number; createdByDesk: string;
  activeTenantCount: number; deskCodes: string[]; noticeSentAt?: number;
}
export interface CycleDoc {
  cycleId: string; tenantId: string; dueDate: string; payByDate: string; rentMinor: number; status: CycleStatus;
  creditedMinor: number; settledMinor: number; inflightMinor: number; instalments: number; firstCreditAt?: number; lastCreditAt?: number; lastAvailableOn?: string;
  legRentMinor: number; legReserveCollectedMinor: number; settlementCount: number; createdAt: number; completionBonusPaid?: boolean; warned?: boolean; payByWarned?: boolean; milestonesSent?: number[];
}
export interface PaymentDoc {
  reference: string; paymentId: string; tenantId: string; cycleId: string; quoteId: string; phone: string; status: "initiating" | "pending" | "credited" | "failed" | "rejected";
  creditMinor: number; reserveMinor: number; serviceMinor: number; chargeMinor: number; feesMinor: number; deskShareMinor: number; deskUid?: string; deskCode?: string; splitCode?: string;
  createdAt: number; creditedAt?: number; availableOn?: string; paystackFeeMinor?: number; payerHash: string;
}
export interface SettlementDoc {
  id: string; tenantId: string; cycleId: string; recipientId: string; recipientCode: string; amountMinor: number; reason: "full" | "due_date" | "topup";
  status: "locked" | "paid" | "failed" | "blocked"; reference: string; attempt: number; transferCode?: string; seal: string; createdAt: number; paidAt?: number; refs: string[]; transferCostMinor: number;
}
export interface ChangeDoc {
  changeId: string; tenantId: string; kind: ChangeKind; status: ChangeStatus; initiatedBy: "desk" | "top" | "tenant"; deskCode: string; deskUid: string;
  payloadEnc: string; payloadHash: string; summary: string; createdAt: number; coolingOffUntil?: number; applyAfter?: number; appliedAt?: number; cancelHash?: string; newRecipientId?: string; confirmedAt?: number;
}
export interface OtpDoc {
  tenantId: string; purpose: "setup" | "change" | "cancel"; changeId?: string; payloadHash: string; hash: string; expiresAt: number; attempts: number; totalWrong: number;
  lockedUntil: number; usedAt: number | null; sends: number[]; createdAt: number;
}
export interface LeadDoc {
  leadId: string; contactKey: string; displayNameEnc: string; contactPhoneEnc: string; tenants: number; monthlyRentMinor: number; deskCodes: string[]; stage: LeadStage;
  notes: { ts: number; by: string; text: string }[]; nextFollowUpAt?: number; pmsLandlordId?: string; attributedDeskCode?: string; attributedDeskUid?: string; onPms: boolean; updatedAt: number; createdAt: number; pmsLandlordCode?: string; landlordBonusPaid?: boolean;
}
export interface PayRecordDoc {
  tenantId: string; recipientId: string; channel: Channel; accountNumber: string; rentMinor: number; dueDay: number; frequency: Frequency; setupCompletedAt: number; setupDeskCode: string;
  setupOtpVia: "desk" | "bot" | "tenant" | "top"; termsHash: string; termsSig: string; version: number;
}
