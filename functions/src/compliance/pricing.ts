// Who pays what. Pure.
import { DESK_PAYSTACK_PCT, DESK_PLATFORM_PCT, FREE_REPORTS_PER_PROPERTY_PER_MONTH, FREE_TIERS, REPORT_PRICE_MINOR } from "./constants";

export type Channel = "pms" | "watch" | "desk" | "auto";

export const isFreeTier = (tier: unknown): boolean => typeof tier === "string" && FREE_TIERS.includes(tier.trim().toLowerCase());

/**
 * KES 0 for the first report of a property in a month when the managing landlord is on Business or higher (PMS, Landlord Watch
 * and the scheduler share one allowance per property per month). Everything else, and every desk order, is KES 200.
 */
export function priceMinor(p: { channel: Channel; tier: unknown; freeUsed: number }): 0 | 20000 {
  if (p.channel === "desk") return REPORT_PRICE_MINOR as 20000;
  return isFreeTier(p.tier) && p.freeUsed < FREE_REPORTS_PER_PROPERTY_PER_MONTH ? 0 : (REPORT_PRICE_MINOR as 20000);
}

/**
 * Desk split on a KES 200 report. The agent keeps 100% - 1.5% (Paystack) - 15% (platform) = 83.5% = KES 167.00.
 * Desk charges use a Paystack percentage split with the fee shared proportionally, so the agent's share of what
 * Paystack settles is  (gross - fee - platform) / (gross - fee), rounded DOWN to 0.01% (an agent is never overpaid).
 */
export function deskReportSplit(grossMinor: number = REPORT_PRICE_MINOR): {
  grossMinor: number; paystackMinor: number; platformMinor: number; agentMinor: number; agentSharePct: number; platformMinorOnSettle: (feeMinor: number) => number;
} {
  const paystackMinor = Math.round((grossMinor * DESK_PAYSTACK_PCT) / 100);
  const platformMinor = Math.round((grossMinor * DESK_PLATFORM_PCT) / 100);
  const agentMinor = grossMinor - paystackMinor - platformMinor;
  const agentSharePct = Math.floor((agentMinor / (grossMinor - paystackMinor)) * 10_000) / 100;
  return { grossMinor, paystackMinor, platformMinor, agentMinor, agentSharePct, platformMinorOnSettle: (fee) => grossMinor - fee - Math.floor(((grossMinor - fee) * Math.round(agentSharePct * 100)) / 10_000) };
}

/** Africa/Nairobi calendar month of a moment: the free allowance resets here. */
export function nairobiMonth(d: Date): string {
  const t = new Date(d.getTime() + 3 * 3_600_000);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}`;
}
export function nairobiDay(d: Date): number {
  return new Date(d.getTime() + 3 * 3_600_000).getUTCDate();
}
export const previousMonth = (month: string): string => {
  const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};
