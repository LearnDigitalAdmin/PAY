/**
 * Pure money logic — TypeScript port of the desk kernel's money.ts. No Firebase imports. Integer minor units only (KES x 100).
 *
 * Every desk charge is a Paystack PERCENTAGE split with bearer_type "all-proportional": Paystack deducts its real fee in
 * proportion to the shares and settles each party's share automatically. An agent with share S% receives exactly S% of
 * (gross - real fee). These functions choose the share % to put in the split and compute what each party netted.
 * Keep this file in lock-step with the kernel; the vectors in functions/test/desk-money.check.js pin them together.
 */
import type { DeskConfig, Rank } from "./config";

export function assertMinor(n: number, label = "amount"): void {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`${label} must be a non-negative integer minor unit, got ${n}`);
}
/** 97.5 -> 9750 basis points. Shares are kept to 0.01%. */
export const toBps = (pct: number): number => Math.round(pct * 100);
/** Never overpay an agent: round DOWN to 0.01%. The epsilon guards binary-float artefacts (71.03 * 100). */
export const floorPct2 = (pct: number): number => Math.floor(pct * 100 + 1e-9) / 100;
export const roundPct2 = (pct: number): number => Math.round(pct * 100) / 100;

export function pctHalfUp(amount: number, pct: number): number {
  return Math.floor((amount * toBps(pct) + 5000) / 10000);
}

export type SplitRule =
  | "service" | "subscription" | "report" | "sms_standard" | "sms_first_purchase" | "rent" | "no_margin";
export interface SplitPlan { agentSharePct: number; rule: SplitRule }

/** Agent keeps everything except the platform cut, which is taken AFTER Paystack's fee. */
export function servicePlan(cfg: DeskConfig): SplitPlan {
  return { agentSharePct: floorPct2(100 - cfg.platformCutPct), rule: "service" };
}

export function sharePlan(rank: Rank, kind: "subscription" | "report", cfg: DeskConfig): SplitPlan {
  const pct = (kind === "subscription" ? cfg.subShareByRank : cfg.reportShareByRank)[rank];
  return { agentSharePct: floorPct2(pct), rule: kind };
}

/**
 * Agent target net = s * (gross - fee - creditCost), s = 40% (standard) or 100% (first purchase under the threshold).
 * With proportional fee bearing the agent nets a * (gross - fee), so a = s * (1 - cost / (gross - fee)).
 * The fee only turns a margin share into a share of the gross; it uses the configured expected Paystack fee.
 */
export function smsPlan(
  p: { grossMinor: number; credits: number; firstPurchaseEligible: boolean }, cfg: DeskConfig,
): SplitPlan {
  assertMinor(p.grossMinor, "gross"); assertMinor(p.credits, "credits");
  const expectedFee = Math.round((p.grossMinor * cfg.expectedPaystackFeePct) / 100);
  const base = p.grossMinor - expectedFee;
  const cost = p.credits * cfg.creditCostMinor;
  if (base <= cost) return { agentSharePct: 0, rule: "no_margin" };
  const first = p.firstPurchaseEligible && p.grossMinor < cfg.firstPurchaseThresholdMinor;
  const s = first ? 1 : cfg.smsShareOfMarginPct / 100;
  return { agentSharePct: floorPct2(s * (1 - cost / base) * 100), rule: first ? "sms_first_purchase" : "sms_standard" };
}

/** Plot Yangu's take on a rent payment: rate (0.7%-2% by tier) of rent, capped per transaction. */
export function rentTake(rentMinor: number, ratePct: number, cfg: DeskConfig): number {
  assertMinor(rentMinor, "rent");
  return Math.min(pctHalfUp(rentMinor, ratePct), cfg.rentTakeCapMinor);
}
export interface RentPlan { landlordSharePct: number; agentSharePct: number; platformSharePct: number; takeMinor: number }
/** Three-way split: landlord (100 - take%), desk agent (30% of take%), Samuhia (the rest). */
export function rentPlan(p: { rentMinor: number; takeMinor: number }, cfg: DeskConfig): RentPlan {
  if (!Number.isSafeInteger(p.rentMinor) || p.rentMinor <= 0) throw new RangeError("rent must be a positive integer");
  const takeMinor = Math.min(p.takeMinor, cfg.rentTakeCapMinor);
  const takePct = (takeMinor / p.rentMinor) * 100;
  const agentSharePct = floorPct2((takePct * cfg.rentDeskSharePct) / 100);
  const landlordSharePct = roundPct2(100 - takePct);
  const platformSharePct = roundPct2(100 - landlordSharePct - agentSharePct);
  if (platformSharePct < 0 || landlordSharePct <= 0) throw new RangeError("invalid rent split");
  return { landlordSharePct, agentSharePct, platformSharePct, takeMinor };
}

export interface Settled { netMinor: number; agentMinor: number; platformMinor: number }
/** From the webhook's real gross and fee: the agent's automatic payout, rounded down; remainder is Samuhia's. */
export function settledAmounts(p: { grossMinor: number; feeMinor: number; agentSharePct: number }): Settled {
  assertMinor(p.grossMinor, "gross"); assertMinor(p.feeMinor, "fee");
  if (p.feeMinor > p.grossMinor) throw new RangeError("fee exceeds gross");
  const netMinor = p.grossMinor - p.feeMinor;
  const agentMinor = Math.floor((netMinor * toBps(p.agentSharePct)) / 10000);
  return { netMinor, agentMinor, platformMinor: netMinor - agentMinor };
}
