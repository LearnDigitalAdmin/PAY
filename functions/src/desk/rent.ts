// Plot Yangu's take on rent. ONE constant table, read at charge time from the landlord's CURRENT tier.
import { rentPlan, rentTake, roundPct2 } from "./money";
import type { DeskConfig } from "./config";

/** Owner-confirmed rent take by tier, % of rent (capped at cfg.rentTakeCapMinor per transaction). Unknown tiers use SOLO. */
export const RENT_TAKE_RATE_BY_TIER = { ENTERPRISE: 0.7, PRO: 1.2, BUSINESS: 1.6, SOLO: 2.0 } as const;

export function rentRateForTier(tier: unknown): number {
  const key = typeof tier === "string" ? tier.trim().toUpperCase() : "";
  return Object.prototype.hasOwnProperty.call(RENT_TAKE_RATE_BY_TIER, key)
    ? RENT_TAKE_RATE_BY_TIER[key as keyof typeof RENT_TAKE_RATE_BY_TIER]
    : RENT_TAKE_RATE_BY_TIER.SOLO;
}

export interface RentSplit {
  ratePct: number; takeMinor: number; takePct: number;
  landlordSharePct: number; agentSharePct: number; platformSharePct: number; threeWay: boolean;
}

/**
 * Two-way (landlord / Samuhia) for a landlord's own charge or a non-owner desk; three-way (landlord 100 - take%,
 * desk 30% of take%, Samuhia the rest) only when the initiating desk IS the landlord's owner.
 */
export function planRentSplit(p: { rentMinor: number; tier: unknown; ownerDesk: boolean }, cfg: DeskConfig): RentSplit {
  const ratePct = rentRateForTier(p.tier);
  const takeMinor = rentTake(p.rentMinor, ratePct, cfg);
  if (p.ownerDesk) {
    const r = rentPlan({ rentMinor: p.rentMinor, takeMinor }, cfg);
    return { ratePct, takeMinor: r.takeMinor, takePct: roundPct2((r.takeMinor / p.rentMinor) * 100), landlordSharePct: r.landlordSharePct, agentSharePct: r.agentSharePct, platformSharePct: r.platformSharePct, threeWay: true };
  }
  const takePct = (takeMinor / p.rentMinor) * 100;
  const landlordSharePct = roundPct2(100 - takePct);
  if (landlordSharePct <= 0) throw new RangeError("invalid rent split");
  return { ratePct, takeMinor, takePct: roundPct2(takePct), landlordSharePct, agentSharePct: 0, platformSharePct: roundPct2(100 - landlordSharePct), threeWay: false };
}
