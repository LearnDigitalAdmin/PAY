/**
 * Rent fee split — who pays what on one rent charge. Pure, integer minor units (KES x 100), no imports but money.ts.
 *
 *   tenant surcharge   = min(KES 150, 0.5% of the rent)            -> added on top: the tenant pays rent + surcharge
 *   Paystack estimate  = 1.5% of the rent (capped KES 3,000)       -> what the landlord + tenant together cover
 *   landlord Paystack  = estimate - surcharge                      -> the part of Paystack's fee the landlord covers
 *   convenience fee    = platform cut by the landlord's PLAN (see CONVENIENCE_PCT_BY_TIER), % of the rent
 *                        enterprise 0.2 | pro 0.4 | business 0.65 | everyone else 0.95   -> Samuhia's fee, paid by the landlord
 *   landlord deduction = landlord Paystack + convenience fee
 *   net payout         = rent - landlord deduction                 -> settled EXACTLY to the landlord's subaccount
 *
 * Rent 50,000 (enterprise, 0.2%): tenant pays 50,150 | Paystack estimate 750 -> landlord covers 600 | convenience 100 | deduction 700 | net 49,300.
 * The invoice is always credited the RENT (`rentMinor`), never the surcharge.
 */
import { pctHalfUp } from "./money";

export const RENT_FEE_RULES = {
  tenantPct: 0.5, tenantCapMinor: 15_000,        // KES 150
  paystackPct: 1.5, paystackCapMinor: 300_000,   // KES 3,000
  conveniencePct: 0.2,   // the enterprise (lowest) cut; what rentFees() uses when no tier is passed
} as const;

/** Platform cut on rent, % of the rent, by the landlord's plan (users/{uid}.tier, lower-case). Anything else pays the default. */
export const CONVENIENCE_PCT_BY_TIER: Readonly<Record<string, number>> = {
  enterprise: 0.2,
  pro: 0.4, professional: 0.4,
  business: 0.65,
};
export const DEFAULT_CONVENIENCE_PCT = 0.95;   // free, starter, solo, unknown

export function conveniencePctForTier(tier: unknown): number {
  const key = typeof tier === "string" ? tier.trim().toLowerCase() : "";
  return Object.prototype.hasOwnProperty.call(CONVENIENCE_PCT_BY_TIER, key) ? CONVENIENCE_PCT_BY_TIER[key] : DEFAULT_CONVENIENCE_PCT;
}

export interface RentFees {
  rentMinor: number;
  tenantFeeMinor: number;          // paid by the tenant, on top of the rent
  chargeMinor: number;             // what the tenant is actually charged (STK amount) = rent + tenantFee
  paystackEstimateMinor: number;   // estimated Paystack cost, on the rent
  landlordPaystackMinor: number;   // estimate - tenantFee (never negative)
  conveniencePct: number;           // the plan's platform cut that was applied
  convenienceMinor: number;         // conveniencePct of the rent
  deductionsMinor: number;         // landlordPaystack + convenience
  netPayoutMinor: number;          // rent - deductions: exactly what the landlord's subaccount receives
}

/** `tier` = the landlord's plan. Pass it on every real charge; omitted (tests, tools) means the enterprise 0.2%. */
export function rentFees(rentMinor: number, tier?: unknown): RentFees {
  if (!Number.isSafeInteger(rentMinor) || rentMinor <= 0) throw new RangeError("rent must be a positive integer minor unit");
  const R = RENT_FEE_RULES;
  const tenantFeeMinor = Math.min(pctHalfUp(rentMinor, R.tenantPct), R.tenantCapMinor);
  const paystackEstimateMinor = Math.min(pctHalfUp(rentMinor, R.paystackPct), R.paystackCapMinor);
  const landlordPaystackMinor = Math.max(0, paystackEstimateMinor - tenantFeeMinor);
  const conveniencePct = tier === undefined ? R.conveniencePct : conveniencePctForTier(tier);
  const convenienceMinor = pctHalfUp(rentMinor, conveniencePct);
  const deductionsMinor = landlordPaystackMinor + convenienceMinor;
  return {
    rentMinor, tenantFeeMinor, chargeMinor: rentMinor + tenantFeeMinor, paystackEstimateMinor,
    landlordPaystackMinor, conveniencePct, convenienceMinor, deductionsMinor, netPayoutMinor: rentMinor - deductionsMinor,
  };
}
