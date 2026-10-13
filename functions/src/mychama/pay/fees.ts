// TRACK B — MyChama fee engine. Pure functions, NO imports (so scripts/mychama/test-fees.mjs
// can load this file directly and compare it with the Python engine's output).
//
// Line-for-line port of Chama `functions/shared/money.py` + `functions/shared/constants.py`
// (PAYSTACK_FEE_*, CONTRIBUTION_MARKUP_RATE, LOAN_MARKUP_RATE, PLANS[*].onlineCollection).
// If a number changes in Chama it MUST change here in the same change set.
//
// Rounding: Python's round() is round-half-to-EVEN, JavaScript's Math.round() is
// half-UP. Chama's Python (the code that actually creates the charge) is the source
// of truth, so `round2` below reproduces Python's behaviour exactly. (Chama's
// frontend src/lib/money.ts uses Math.round, so a quote can differ by KES 0.01 in the
// vanishingly rare case where gross*100 lands on an exact .5 — the charge is always
// the Python/this-file figure.)

export const PAYSTACK_FEE_RATE = 0.015;
export const PAYSTACK_FEE_CAP = 3000;
export const CONTRIBUTION_MARKUP_RATE = 0.005;

/** Loan-repayment markup per plan. null/absent = no markup (free plan). */
export const LOAN_MARKUP_RATE: Readonly<Record<string, number | null>> = {
  free: null,
  starter: 0.015,
  basic: 0.011,
  growth: 0.007,
  max: 0.007,
};

/** PLANS[plan].onlineCollection from Chama constants. Unknown plan => treated as "free". */
export const PLAN_ONLINE_COLLECTION: Readonly<Record<string, boolean>> = {
  free: false,
  starter: true,
  basic: true,
  growth: true,
  max: true,
};

/** Chama SECURITY.MAX_INTENTS_PER_HOUR / PAYMENT_INTENT_TTL_SECONDS. */
export const MAX_INTENTS_PER_HOUR = 10;
export const PAYMENT_INTENT_TTL_SECONDS = 30 * 60;

/**
 * Sanity bounds for a self-pay charge (Track B decision — adjust here if Safaricom/Paystack
 * limits change): the NET must be >= 1 KES with at most 2 decimals, and the GROSS charge
 * must not exceed the M-Pesa single-transaction limit.
 */
export const MIN_NET_KES = 1;
export const MAX_GROSS_KES = 250000;

export interface FeeBreakdown {
  net: number;
  gross: number;
  paystackFee: number;
  ourFee: number;
}

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** Python-compatible round(): half to even. Inputs here are always >= 0. */
export function pyRound(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** Python `round((n or 0) * 100) / 100`. */
export function round2(n: number): number {
  return pyRound((n || 0) * 100) / 100;
}

/**
 * Money IN (contributions, loan repayments, MGR collections). Finds the charge that leaves
 * exactly `net` in the chama account after Paystack's fee AND the MyChama markup are both
 * taken from the charge. `net` is returned exactly as given (like the Python engine).
 */
export function grossUpForFees(net: number, ourRate: number): FeeBreakdown {
  let gross = net / (1 - PAYSTACK_FEE_RATE - ourRate);
  let pFee = gross * PAYSTACK_FEE_RATE;

  if (pFee > PAYSTACK_FEE_CAP) {
    gross = (net + PAYSTACK_FEE_CAP) / (1 - ourRate);
    pFee = PAYSTACK_FEE_CAP;
  }

  const ourFee = gross * ourRate;
  return { net, gross: round2(gross), paystackFee: round2(pFee), ourFee: round2(ourFee) };
}

/**
 * The flat amount (in whole kobo/cents) MyChama's main Paystack account keeps on a split charge: everything the
 * member pays beyond what the chama is owed. The chama's subaccount gets the rest, so it receives exactly `net`,
 * never more and never less. Whole-subunit arithmetic keeps float rounding from moving a cent to the chama; any
 * rounding left over, and any gap between our Paystack-fee estimate and the real fee, stays with the main account.
 * Mirrors Chama functions/shared/money.py::main_account_charge_subunits.
 */
export const mainAccountChargeSubunits = (gross: number, net: number): number =>
  pyRound(gross * 100) - pyRound(net * 100);

export const contributionFees = (net: number): FeeBreakdown => grossUpForFees(net, CONTRIBUTION_MARKUP_RATE);

export function loanRepaymentFees(net: number, plan: string): FeeBreakdown {
  const rate = has(LOAN_MARKUP_RATE, plan) ? LOAN_MARKUP_RATE[plan] : null;
  return grossUpForFees(net, rate || 0);
}

/** MGR collections use the same markup as contributions. */
export const mgrContributionFees = (net: number): FeeBreakdown => grossUpForFees(net, CONTRIBUTION_MARKUP_RATE);

export function onlineCollectionAllowed(plan: string): boolean {
  return has(PLAN_ONLINE_COLLECTION, plan) ? PLAN_ONLINE_COLLECTION[plan] : PLAN_ONLINE_COLLECTION.free;
}
