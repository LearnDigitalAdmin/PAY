// Wire types of the Landlord Watch contract (v1.1). Keep in sync with LANDLORD_WATCH_CONTRACT.md.
export type MaskLevel = "full" | "tenant" | "open";
export type Lang = "en" | "sw";
export type Channel = "cyber" | "pms" | "whatsapp";

/** A number that can be masked: always render `d`. `v` is null when masked. */
export interface N { v: number | null; d: string }

export interface Connection {
  ownerId: string; propertyName: string; address: string | null; connectedAt: string;
  unlocked: boolean; unlockedUntil: string | null;
}

export type TenantStatus = "paid" | "partial" | "unpaid" | "no_invoice" | "masked";

export interface TenantRow {
  ref: string; name: string; phone: string; unit: string | null; status: TenantStatus;
  rent: N; billed: N; paid: N; balance: N;
  dueDate: string | null; paidOn: string | null; paidOnTime: boolean | null;
}

export interface StatementItem { label: string; kind: "income" | "deduction"; amount: N }
export interface Statement {
  source: "agent" | "estimate";
  status: "draft" | "finalized" | "sent" | "acknowledged" | null;
  notes: string | null;
  items: StatementItem[];
  income: N; deductions: N; netPayable: N;
}

export interface Snapshot {
  schema: 1;
  ownerId: string;
  month: string;
  generatedAt: string;
  mask: { level: MaskLevel; reason: "locked" | "otp" | "auth_phone_match" | "channel_policy"; unlockedUntil: string | null; canUnlock: boolean };
  property: { name: string; address: string | null; maxUnits: N; commissionRatePct: N; managedByAgency: boolean };
  months: string[];
  summary: {
    tenants: { active: N; occupiedUnits: N; vacantUnits: N; occupancyPct: N };
    invoices: { total: N; paid: N; partial: N; unpaid: N; noInvoice: N };
    billed: N; collected: N; pending: N; collectionRatePct: N;
    baseRent: { billed: N; collected: N };
    commission: { ratePct: N; onCollected: N; onExpected: N };
    net: { expected: N; payable: N; stillToCollect: N };
    statement: Statement;
    remittance: { dueDate: string; collectedByDue: N; collectedAfterDue: N; netByDue: N; netAfterDue: N };
  };
  tenants: TenantRow[];
  trend: { month: string; billed: N; collected: N; pending: N; netPayable: N }[];
}

export interface Quota { period: string; freeLimit: 1; freeUsed: number; nextPriceKes: 0 | 99 }

export type TranscriptState =
  | "otp_pending" | "payment_required" | "payment_pending" | "paid" | "generating" | "ready" | "failed" | "expired";

export interface TranscriptRequest {
  requestId: string; ownerId: string; month: string; state: TranscriptState; priceKes: 0 | 99;
  sentTo?: string; expiresInSec?: number; resendInSec?: number;
  url?: string; expiresAt?: string; reference?: string; message?: string;
  error?: { code: string; message: string }; createdAt: string;
}

// ---------------- raw data the calculation engine consumes (already read from Firestore) ----------------
export interface RawProperty {
  name: string; address: string | null; maxUnits: number; commissionRatePct: number; managedByAgency: boolean;
}
export interface RawTenant { id: string; name: string; phone: string | null; unit: string | null; rentAmount: number; isActive: boolean }
export interface RawInvoice {
  id: string; tenantId: string; billingMonth: string; rentAmount: number; totalAmount: number; amountPaid: number;
  dueDate: string | null; paidDate: string | null;
}
export interface RawPayment { invoiceId: string; amount: number; date: string | null }
export interface RawTranscript {
  billingMonth: string; status: string | null; notes: string | null;
  items: { description: string; amount: number; isDeductible: boolean; sortOrder: number }[];
}
