/**
 * Rent fee split — who pays what on one rent charge. Pure, integer minor units (KES x 100), no imports but money.ts.
 *
 *   tenant surcharge   = min(KES 150, 0.5% of the rent)            -> added on top: the tenant pays rent + surcharge
 *   Paystack estimate  = 1.5% of the rent (capped KES 3,000)       -> what the landlord + tenant together cover
 *   landlord Paystack  = estimate - surcharge                      -> the part of Paystack's fee the landlord covers
 *   convenience fee    = platform cut by the account holder's PLAN (see CONVENIENCE_PCT_BY_TIER), % of the rent
 *                        free 0.75 | solo 0.50 | business 0.40 | pro 0.25 | enterprise 0.15   -> Samuhia's fee
 *   collection cost    = landlord Paystack + convenience fee       (a.k.a. `deductionsMinor`; v2 also stores it as `collectionCostMinor`)
 *   net payout         = rent - collection cost                    -> settled EXACTLY to the account holder's subaccount
 *
 * WHO BEARS THE COST (fee schedule v2). The "account holder" is the PMS user whose subaccount receives the payout.
 *   - A landlord managing their own property bears the cost: it is simply their cost of collecting rent.
 *   - An AGENCY managing a property for a landlord bears it OUT OF ITS COMMISSION. The landlord's entitlement is
 *     rent - commission - agreed costs, with NO transaction or platform fee in it. The payout above is therefore smaller than
 *     the landlord's entitlement, and the gap is the agency's cost. PMS does that accounting from `collectionCostMinor`
 *     (see PMS src/services/accounting). PAY itself does not know whether the account holder is an agency: it only fixes the
 *     numbers and records them, so the books can be rebuilt from the transaction document alone.
 *
 * Rent 50,000 (enterprise, 0.15%): tenant pays 50,150 | Paystack estimate 750 -> landlord covers 600 | convenience 75 | cost 675 | net 49,325.
 * The invoice is always credited the RENT (`rentMinor`), never the surcharge.
 */
import { pctHalfUp } from "./money";

export const RENT_FEE_RULES = {
  tenantPct: 0.5, tenantCapMinor: 15_000,        // KES 150
  paystackPct: 1.5, paystackCapMinor: 300_000,   // KES 3,000
  conveniencePct: 0.15,   // the enterprise (lowest) cut; what rentFees() uses when no tier is passed
} as const;

/** Bump when the schedule changes. Stored on every transaction (`feeVersion`) so history is never re-priced. */
export const RENT_FEE_SCHEDULE_VERSION = 2;

/**
 * Platform cut on rent, % of the rent, by the account holder's plan (users/{uid}.tier, lower-case).
 * The Starter plan is retired (it has no row): a legacy `starter` / `low` account, or any unknown tier, pays the Free rate.
 * Mirrored in PMS src/services/accounting/feeSchedule.ts; functions/test/rent-flat-split.check.js and the PMS test pin both.
 */
export const CONVENIENCE_PCT_BY_TIER: Readonly<Record<string, number>> = {
  free: 0.75,
  solo: 0.5,
  business: 0.4,
  pro: 0.25, professional: 0.25,
  enterprise: 0.15,
};
export const DEFAULT_CONVENIENCE_PCT = 0.75;   // free, retired starter/low, unknown

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
  /** Same number as deductionsMinor, named for what it is: the cost of collecting this payment, borne by the account holder
   *  (an agency takes it out of its commission, never out of the landlord's rent). */
  collectionCostMinor: number;
  netPayoutMinor: number;          // rent - deductions: exactly what the landlord's subaccount receives
}

/** `tier` = the account holder's plan. Pass it on every real charge; omitted (tests, tools) means the enterprise 0.15%. */
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
    landlordPaystackMinor, conveniencePct, convenienceMinor, deductionsMinor, collectionCostMinor: deductionsMinor,
    netPayoutMinor: rentMinor - deductionsMinor,
  };
}
