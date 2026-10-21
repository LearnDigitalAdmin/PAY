/**
 * Rent fee split — who pays what on one rent charge. Pure, integer minor units (KES x 100), no imports but money.ts.
 *
 *   tenant surcharge   = min(KES 150, 0.5% of the rent)            -> added on top: the tenant pays rent + surcharge
 *   Paystack estimate  = 1.5% of the rent (capped KES 3,000)       -> what the landlord + tenant together cover
 *   landlord Paystack  = estimate - surcharge                      -> the part of Paystack's fee the landlord covers
 *   convenience fee    = 0.2% of the rent                          -> Samuhia's fee, paid by the landlord
 *   landlord deduction = landlord Paystack + convenience fee
 *   net payout         = rent - landlord deduction                 -> settled EXACTLY to the landlord's subaccount
 *
 * Rent 50,000: tenant pays 50,150 | Paystack estimate 750 -> landlord covers 600 | convenience 100 | deduction 700 | net 49,300.
 * The invoice is always credited the RENT (`rentMinor`), never the surcharge.
 */
import { pctHalfUp } from "./money";

export const RENT_FEE_RULES = {
  tenantPct: 0.5, tenantCapMinor: 15_000,        // KES 150
  paystackPct: 1.5, paystackCapMinor: 300_000,   // KES 3,000
  conveniencePct: 0.2,
} as const;

export interface RentFees {
  rentMinor: number;
  tenantFeeMinor: number;          // paid by the tenant, on top of the rent
  chargeMinor: number;             // what the tenant is actually charged (STK amount) = rent + tenantFee
  paystackEstimateMinor: number;   // estimated Paystack cost, on the rent
  landlordPaystackMinor: number;   // estimate - tenantFee (never negative)
  convenienceMinor: number;        // 0.2% of the rent
  deductionsMinor: number;         // landlordPaystack + convenience
  netPayoutMinor: number;          // rent - deductions: exactly what the landlord's subaccount receives
}

export function rentFees(rentMinor: number): RentFees {
  if (!Number.isSafeInteger(rentMinor) || rentMinor <= 0) throw new RangeError("rent must be a positive integer minor unit");
  const R = RENT_FEE_RULES;
  const tenantFeeMinor = Math.min(pctHalfUp(rentMinor, R.tenantPct), R.tenantCapMinor);
  const paystackEstimateMinor = Math.min(pctHalfUp(rentMinor, R.paystackPct), R.paystackCapMinor);
  const landlordPaystackMinor = Math.max(0, paystackEstimateMinor - tenantFeeMinor);
  const convenienceMinor = pctHalfUp(rentMinor, R.conveniencePct);
  const deductionsMinor = landlordPaystackMinor + convenienceMinor;
  return {
    rentMinor, tenantFeeMinor, chargeMinor: rentMinor + tenantFeeMinor, paystackEstimateMinor,
    landlordPaystackMinor, convenienceMinor, deductionsMinor, netPayoutMinor: rentMinor - deductionsMinor,
  };
}
