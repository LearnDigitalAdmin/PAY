import type { ReportKind } from "./constants";
import type { DataAsOf } from "./freshness";

/** Everything the report needs, from either source (the PMS app, or the landlord's synced Firestore data). KES, 2 decimals. */
export interface ReportInput {
  schema: 1;
  kind: ReportKind;
  /** Return month (YYYY-MM): the month the rent was RECEIVED. Annual reports run from January to this month. */
  month: string;
  landlord: { name: string; kraPin?: string | null; phone?: string | null };
  property: { id: string; name: string; address?: string | null; commissionRatePct: number; managed: boolean; residential: boolean };
  tenants: { id: string; unit: string | null; name: string; rent: number; active: boolean }[];
  invoices: { id: string; tenantId: string; month: string; rent: number; total: number; payments: { date: string; amount: number }[] }[];
  /** Deductions on the agent's statement (repairs, water, ...). Base rent and the agent's commission never belong here. */
  statementItems: { month: string; description: string; amount: number }[];
  /** All the landlord's properties (the MRI band is tested on the landlord's total, not on one property). */
  portfolio?: { propertyCount: number; annualRentRoll: number; ytdReceived: number };
  /** Set only when the records were read from the landlord's synced cloud data: when it was last synced. Never taken from the app, and not part of the record fingerprint. */
  dataAsOf?: DataAsOf;
}

export type CheckResult = "pass" | "fail" | "warn" | "info";
export interface Check { id: string; label: string; result: CheckResult; detail: string }

export interface TenantRow {
  unit: string; name: string; contractRent: number; invoicedRent: number; receivedRent: number;
  outstandingRent: number; invoicedBills: number; receivedBills: number; note: string;
}
export interface MonthRow { month: string; grossRent: number; commission: number; finalIncome: number; mriTax: number }
export interface BillLine { description: string; amount: number; source: "agent_commission" | "agent_statement" }

/** All money in MINOR units (cents) so nothing drifts. */
export interface Computed {
  schema: 1; version: string; kind: ReportKind; month: string; year: string;
  property: ReportInput["property"]; landlord: ReportInput["landlord"];
  rows: TenantRow[];
  totals: { contractRent: number; invoicedRent: number; receivedRent: number; outstandingRent: number; invoicedBills: number; receivedBills: number };
  /** Gross rent received in the month (base rent only; bills never included). */
  grossRent: number;
  commission: { ratePct: number; amount: number };
  /** Total rent received less agent commission. */
  finalIncome: number;
  /** Property bills: the agent's commission (a bill) plus the other deductions on the agent's statement. Base rent is never here. */
  bills: { lines: BillLine[]; total: number; excluded: { description: string; amount: number; reason: string }[] };
  mri: {
    ratePct: number; applies: boolean; base: number; tax: number; dueDate: string;
    regime: "mri" | "below_threshold" | "above_threshold";
  };
  threshold: {
    minAnnual: number; maxAnnual: number; basis: number; basisLabel: string;
    propertyRoll: number; propertyYtd: number; portfolioRoll: number | null; portfolioYtd: number | null; scope: "landlord" | "property";
    status: "within" | "below" | "above"; monthlyEquivalent: number;
  };
  monthly: MonthRow[];
  annual: { gross: number; commission: number; finalIncome: number; mriTax: number } | null;
  checks: Check[];
  occupancy: { activeTenants: number; invoiced: number; withoutInvoice: number };
  dataAsOf?: DataAsOf;
}
