// Document shapes the desk module reads and writes. DeskEventDoc mirrors the desk kernel's types.ts exactly.
import type { Product, Rank } from "./config";

export type DeskEventType =
  | "sms_purchase" | "subscription_payment" | "report_purchase" | "rent_payment" | "refund";

/**
 * Create-only facts written by PAY AFTER a split charge succeeds.
 * `eventId` = `<type>:<paystackRef>` so a replayed webhook can never double-count.
 */
export interface DeskEventDoc {
  eventId: string; type: DeskEventType; product: Product; entityKey: string;
  agentId: string; paystackRef: string; grossMinor: number; feeMinor: number;
  /** The exact share % that was put into the Paystack split for the agent on this charge. */
  agentSharePct: number; paidAt: number;
  credits?: number; plan?: string; periodMonth?: string; originalRef?: string;
}

/** desk_customers/{entityKey} — owned by desk; PAY reads it and only touches the first-purchase reservation fields. */
export interface DeskCustomerDoc {
  entityKey: string; product: Product; ownerAgentId: string; attributedAt: number;
  firstPurchaseUsed: boolean; firstPurchaseReservedRef?: string; firstPurchaseReservedAt?: number;
  lastPaidAt?: number; selfOwned?: boolean; refunded?: boolean; paidPeriods: string[];
}

/** desk_agents/{uid}. */
export interface DeskAgentDoc {
  agentId: string; agentCode: string; status: string; rank: Rank;
}

/** What the charging code stores on the pending transaction document so the webhook can record the event. */
export interface DeskCommission {
  agentCode: string; agentId: string; sharePct: number; rule: string; entityKey: string;
}

export interface DeskOwner { agentId: string; agentCode: string; rank: Rank; subaccountCode: string }

export interface DeskAuditEntry { action: string; agentId?: string; entityKey?: string; meta?: Record<string, unknown> }
