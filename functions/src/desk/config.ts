// Desk configuration — TypeScript port of the desk kernel's config.ts (CYBER functions-desk/src/config.ts).
// DEFAULT_DESK_CONFIG must stay identical to the kernel's so PAY and desk always compute the same shares.
// Runtime-editable in `desk_config/global` (admin dash only). Money in minor units, rates in percent.
import { DESK, deskDb } from "./db";

// "internal" is Samuhia staff: never an owner of customers for payouts (their share is 0 and owner.ts ignores them).
export type Rank = "clerk" | "senior" | "lead" | "admin" | "internal";
export type Product = "chama" | "school" | "pms";

export interface DeskConfig {
  creditCostMinor: number;               // what Samuhia pays per SMS credit: KES 0.20 = 20
  platformCutPct: number;                // CYBER_ charge cut, taken after Paystack fees
  expectedPaystackFeePct: number;        // only used to derive SMS margin shares (1.5)
  smsShareOfMarginPct: number;           // 45
  firstPurchaseThresholdMinor: number;   // 20000 = KES 200
  subShareByRank: Record<Rank, number>;  // % of net after fees
  reportShareByRank: Record<Rank, number>;
  rentDeskSharePct: number;              // 40 (% of Plot Yangu's take)
  rentTakeCapMinor: number;              // 25000 = KES 250 per transaction
  milestone: { blockSize: number; bonusMinor: number; lifetimeCapMinor: number; minPaidMonths: number };
  paystackAccounts: Record<Product, "main" | "separate">;
  projects: { chama: string; school: string };
  topDesk: { dailyPayoutCapMinor: number };
  delegate: Record<Product, string>;
  support: { rateMinorPerConfirmed: number; maxConfirmedPerDay: number; monthlyCapMinor: number };
  prices: {
    importMinor: number;
    manualTiers: { upToRecords: number; priceMinor: number }[];
    manualCapMinor: number;
    manualServiceFeeMinor: number;
    commsMinor: number;
  };
}

export const DEFAULT_DESK_CONFIG: DeskConfig = {
  creditCostMinor: 20,
  platformCutPct: 2.5,
  expectedPaystackFeePct: 1.5,
  smsShareOfMarginPct: 45,
  firstPurchaseThresholdMinor: 20000,
  subShareByRank: { clerk: 25, senior: 30, lead: 30, admin: 30, internal: 0 },
  reportShareByRank: { clerk: 25, senior: 30, lead: 30, admin: 30, internal: 0 },
  rentDeskSharePct: 40,
  rentTakeCapMinor: 25000,
  milestone: { blockSize: 10, bonusMinor: 200000, lifetimeCapMinor: 1000000, minPaidMonths: 2 },
  paystackAccounts: { chama: "main", school: "main", pms: "main" },
  projects: { chama: "", school: "" },
  topDesk: { dailyPayoutCapMinor: 5_000_000 },
  delegate: { chama: "", school: "", pms: "" },
  support: { rateMinorPerConfirmed: 0, maxConfirmedPerDay: 5, monthlyCapMinor: 0 },
  prices: {
    importMinor: 20000,
    manualTiers: [
      { upToRecords: 10, priceMinor: 20000 },
      { upToRecords: 25, priceMinor: 40000 },
      { upToRecords: 50, priceMinor: 60000 },
      { upToRecords: 100, priceMinor: 80000 },
      { upToRecords: 1_000_000, priceMinor: 100000 },
    ],
    manualCapMinor: 100000,
    manualServiceFeeMinor: 20000,
    commsMinor: 10000,
  },
};

/** Deep-merge stored overrides over defaults. Pure. */
export function mergeConfig(stored: Partial<DeskConfig> | undefined): DeskConfig {
  const s = stored ?? {};
  return {
    ...DEFAULT_DESK_CONFIG,
    ...s,
    subShareByRank: { ...DEFAULT_DESK_CONFIG.subShareByRank, ...s.subShareByRank },
    reportShareByRank: { ...DEFAULT_DESK_CONFIG.reportShareByRank, ...s.reportShareByRank },
    milestone: { ...DEFAULT_DESK_CONFIG.milestone, ...s.milestone },
    paystackAccounts: { ...DEFAULT_DESK_CONFIG.paystackAccounts, ...s.paystackAccounts },
    projects: { ...DEFAULT_DESK_CONFIG.projects, ...s.projects },
    topDesk: { ...DEFAULT_DESK_CONFIG.topDesk, ...s.topDesk },
    delegate: { ...DEFAULT_DESK_CONFIG.delegate, ...s.delegate },
    support: { ...DEFAULT_DESK_CONFIG.support, ...s.support },
    prices: { ...DEFAULT_DESK_CONFIG.prices, ...s.prices },
  };
}

type ReadDoc = () => Promise<Partial<DeskConfig> | undefined>;
let cache: { at: number; cfg: DeskConfig } | null = null;

/** Cached 60 s. */
export async function loadDeskConfig(read: ReadDoc, now = Date.now()): Promise<DeskConfig> {
  if (cache && now - cache.at < 60_000) return cache.cfg;
  const cfg = mergeConfig(await read());
  cache = { at: now, cfg };
  return cfg;
}
export function clearDeskConfigCache(): void { cache = null; }

/** The live desk configuration (`desk_config/global` over the defaults), cached for 60 seconds. */
export function getDeskConfig(): Promise<DeskConfig> {
  return loadDeskConfig(async () => {
    const snap = await deskDb().collection(DESK.config).doc("global").get();
    return snap.exists ? (snap.data() as Partial<DeskConfig>) : undefined;
  });
}
