import { COL } from "./config";
import { LMMX, cycleProjection, earningsTable, eatDate, firstDueDate, nextDueDate } from "./contract";
import type { CycleView, Frequency } from "./contract";
import { col, now } from "./store";
import type { CycleDoc, TenantDoc } from "./types";

export const cycleIdOf = (tenantId: string, due: string): string => `${tenantId}_${due.slice(0, 4)}${due.slice(5, 7)}`;
const DAY = 86_400_000;

let holCache: { at: number; v: string[] } | null = null;
/** Kenyan public holidays (config/kenya_holidays.dates, YYYY-MM-DD), the same list the rent settlement code reads. Cached 10 minutes. */
export async function holidays(): Promise<string[]> {
  if (holCache && now() - holCache.at < 600_000) return holCache.v;
  const d = (await col("config").doc("kenya_holidays").get()).data();
  const v = Array.isArray(d?.dates) ? (d!.dates as unknown[]).map(String) : [];
  holCache = { at: now(), v };
  return v;
}
const isBiz = (iso: string, hol: readonly string[]): boolean => { const w = new Date(`${iso}T00:00:00Z`).getUTCDay(); return w !== 0 && w !== 6 && !hol.includes(iso); };
/** The date `n` business days before `iso` (weekends and holidays skipped): the pay-by date, so money collected is in Samuhia's balance by the due date. */
export function subBusinessDays(iso: string, n: number, hol: readonly string[]): string {
  let t = Date.parse(`${iso}T00:00:00Z`), left = n;
  while (left > 0) { t -= DAY; if (isBiz(new Date(t).toISOString().slice(0, 10), hol)) left--; }
  return new Date(t).toISOString().slice(0, 10);
}
/** Paystack T+2 forward from a payment: the date its money is in the balance. */
export function addBusinessDays(iso: string, n: number, hol: readonly string[]): string {
  let t = Date.parse(`${iso}T00:00:00Z`);
  while (!isBiz(new Date(t).toISOString().slice(0, 10), hol)) t += DAY;
  let left = n;
  while (left > 0) { t += DAY; if (isBiz(new Date(t).toISOString().slice(0, 10), hol)) left--; }
  return new Date(t).toISOString().slice(0, 10);
}

export function newCycle(t: Pick<TenantDoc, "tenantId">, due: string, rentMinor: number, hol: readonly string[]): CycleDoc {
  return {
    cycleId: cycleIdOf(t.tenantId, due), tenantId: t.tenantId, dueDate: due, payByDate: subBusinessDays(due, LMMX_LAG, hol), rentMinor, status: "open", creditedMinor: 0, settledMinor: 0, inflightMinor: 0,
    instalments: 0, legRentMinor: rentMinor, legReserveCollectedMinor: 0, settlementCount: 0, createdAt: now(),
  };
}
const LMMX_LAG = 2;

export const remainingOf = (c: CycleDoc): number => Math.max(0, c.rentMinor - c.creditedMinor);
export const cycleView = (c: CycleDoc): CycleView => ({
  cycleId: c.cycleId, status: c.status, dueDate: c.dueDate, payByDate: c.payByDate, rentMinor: c.rentMinor, creditedMinor: c.creditedMinor, remainingMinor: remainingOf(c), settledMinor: c.settledMinor,
  pct: c.rentMinor > 0 ? Math.min(100, Math.floor((c.creditedMinor * 100) / c.rentMinor)) : 0,
});

export async function loadCycles(tenantId: string, statuses: string[] = ["open", "funded", "partial_settled"]): Promise<CycleDoc[]> {
  const q = await col(COL.cycles).where("tenantId", "==", tenantId).where("status", "in", statuses).get();
  return q.docs.map((d) => d.data() as CycleDoc).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}
/** The cycle a payment goes to: the oldest with a balance, else (one cycle ahead) the next. `isNew` means it does not exist yet. */
export async function targetCycle(t: TenantDoc): Promise<{ cycle: CycleDoc; isNew: boolean } | null> {
  const open = await loadCycles(t.tenantId);
  const owing = open.find((c) => remainingOf(c) > 0);
  if (owing) return { cycle: owing, isNew: false };
  const hol = await holidays();
  const last = (await loadCycles(t.tenantId, ["open", "funded", "partial_settled", "settled", "closed"])).pop();
  // one cycle ahead at most: if the latest cycle is unsettled-but-funded the tenant has nothing to prepay yet
  if (open.some((c) => c.status === "funded")) return null;
  const due = last ? nextDueDate(last.dueDate, t.dueDay, 1) : firstDueDate(eatDate(now()), t.dueDay);
  return { cycle: newCycle(t, due, t.rent.amountMinor, hol), isNew: true };
}

const perFrequencyCredit = (rentMinor: number, f: Frequency): number => {
  const n = f === "daily" ? 30 : f === "weekly" ? 4 : 2;
  return Math.max(LMMX.MIN_CREDIT_MINOR, Math.ceil(rentMinor / n / 100) * 100);
};
export const suggestedCredit = (rentMinor: number, f: Frequency): number => Math.min(rentMinor, perFrequencyCredit(rentMinor, f));
export function projections(rentMinor: number, channel: Parameters<typeof earningsTable>[1]) {
  const out = {} as Record<Frequency, { instalments: number; tenantPaysMinor: number; deskMinor: number; deskBonusMinor: number }>;
  for (const f of ["daily", "weekly", "biweekly"] as Frequency[]) {
    const p = cycleProjection(rentMinor, channel, suggestedCredit(rentMinor, f));
    out[f] = { instalments: p.instalments, tenantPaysMinor: p.tenantPaysMinor, deskMinor: p.deskMinor, deskBonusMinor: p.deskBonusMinor };
  }
  return out;
}
