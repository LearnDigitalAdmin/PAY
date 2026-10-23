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

// Rates are FRACTIONS (0.0025 === 0.25%). A "markup" is MyChama's cut, charged TOGETHER with Paystack's own fee
// (e.g. 0.5% markup + 1.5% Paystack = 2.0%); the UIs present the two as ONE "Transaction cost" plus a total.

/** Plain contributions carry NO markup … */
export const CONTRIBUTION_MARKUP_RATE = 0;
/** … and their all-in transaction cost is a flat 1.7% (Paystack's 1.5% + 0.2% the main account keeps), capped. */
export const CONTRIBUTION_TRANSACTION_RATE = 0.017;

/** Loan-repayment markup per plan (on top of Paystack's 1.5%). null/absent = no markup (free plan). */
export const LOAN_MARKUP_RATE: Readonly<Record<string, number | null>> = {
  free: null,
  starter: 0.008,
  basic: 0.008,
  growth: 0.0045,
  max: 0.0025,
};

/** MGR collections: dynamic markup per plan, falling as the plan rises (on top of Paystack's 1.5%). */
export const MGR_MARKUP_RATE: Readonly<Record<string, number | null>> = {
  free: null,
  starter: 0.007,
  basic: 0.006,
  growth: 0.004,
  max: 0.002,
};

/** PLANS[plan].smsRate from Chama constants — KES paid PER SMS CREDIT at top-up (cheaper tiers buy more per KES). */
export const PLAN_SMS_RATE: Readonly<Record<string, number>> = {
  free: 0.9,
  starter: 0.9,
  basic: 0.9,
  growth: 0.7,
  max: 0.5,
};

/**
 * Credits an SMS top-up buys: whole KES paid / the plan's per-credit price, rounded DOWN, in integer hundredths so
 * float noise can never grant or withhold a credit. Unknown plan => priced as free. Mirrors Chama
 * functions/shared/money.py::sms_credits_for_amount.
 */
export function smsCreditsForAmount(amountKes: number, plan: string): number {
  const rate = has(PLAN_SMS_RATE, plan) ? PLAN_SMS_RATE[plan] : PLAN_SMS_RATE.free;
  const kesCents = Math.round(Number(amountKes) * 100);
  if (!Number.isFinite(kesCents) || kesCents <= 0) return 0;
  return Math.floor(kesCents / Math.round(rate * 100));
}

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
export function grossUpForFees(net: number, ourRate: number, baseRate: number = PAYSTACK_FEE_RATE): FeeBreakdown {
  let gross = net / (1 - baseRate - ourRate);
  let pFee = gross * baseRate;

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

export const contributionFees = (net: number): FeeBreakdown =>
  grossUpForFees(net, CONTRIBUTION_MARKUP_RATE, CONTRIBUTION_TRANSACTION_RATE);

export function loanRepaymentFees(net: number, plan: string): FeeBreakdown {
  const rate = has(LOAN_MARKUP_RATE, plan) ? LOAN_MARKUP_RATE[plan] : null;
  return grossUpForFees(net, rate || 0);
}

/** MGR collections: Paystack's 1.5% plus the plan's dynamic MGR markup. */
export function mgrContributionFees(net: number, plan: string = "free"): FeeBreakdown {
  const rate = has(MGR_MARKUP_RATE, plan) ? MGR_MARKUP_RATE[plan] : null;
  return grossUpForFees(net, rate || 0);
}

export function onlineCollectionAllowed(plan: string): boolean {
  return has(PLAN_ONLINE_COLLECTION, plan) ? PLAN_ONLINE_COLLECTION[plan] : PLAN_ONLINE_COLLECTION.free;
}
