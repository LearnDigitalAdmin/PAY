// How current are the landlord's synced records? Pure (no imports), so it can be tested on its own:
//   node --experimental-strip-types --test tests/compliance/freshness.test.mts
// Rules (set by the product owner):
//   age <= 3 days            fresh    - report made normally
//   3 days < age <= 7 days   stale    - report made, with a warning in the PDF and an SMS to the landlord
//   age > 7 days, or unknown expired/unknown - the scheduler does NOT make the report; the landlord gets an SMS instead
export const DATA_STALE_AFTER_MS = 3 * 86_400_000;
export const DATA_SKIP_AFTER_MS = 7 * 86_400_000;

export type FreshnessLevel = "fresh" | "stale" | "expired" | "unknown";
export interface DataAsOf { syncedAt: number | null; level: FreshnessLevel; ageDays: number | null }

const DAY_MS = 86_400_000;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Firestore Timestamp, Date, epoch milliseconds or ISO string -> epoch milliseconds. Anything else -> null. */
export function toMillis(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
  if (v instanceof Date) { const t = v.getTime(); return Number.isFinite(t) ? t : null; }
  if (typeof v === "string") { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
  if (typeof v === "object") {
    const o = v as { toMillis?: () => number; seconds?: number; _seconds?: number; nanoseconds?: number; _nanoseconds?: number };
    if (typeof o.toMillis === "function") { const t = o.toMillis(); return Number.isFinite(t) ? t : null; }
    const s = o.seconds ?? o._seconds;
    if (typeof s === "number" && Number.isFinite(s)) return s * 1000 + Math.floor(Number(o.nanoseconds ?? o._nanoseconds ?? 0) / 1e6);
  }
  return null;
}

export function classifyFreshness(syncedAt: number | null, nowMs: number): DataAsOf {
  if (syncedAt === null || !Number.isFinite(syncedAt)) return { syncedAt: null, level: "unknown", ageDays: null };
  const age = Math.max(0, nowMs - syncedAt);                   // a clock a little ahead of ours is not "negative age"
  const level: FreshnessLevel = age > DATA_SKIP_AFTER_MS ? "expired" : age > DATA_STALE_AFTER_MS ? "stale" : "fresh";
  return { syncedAt, level, ageDays: Math.floor(age / DAY_MS) };
}

export type AutoAction = "generate" | "generate_warn" | "wait" | "skip";
/**
 * What the scheduler does for one property whose rent is due to be reported.
 * Over a week old (or never synced): wait for the landlord to sync until the forced day, then skip for good.
 */
export function autoAction(level: FreshnessLevel, day: number, forceDay: number): AutoAction {
  if (level === "fresh") return "generate";
  if (level === "stale") return "generate_warn";
  return day < forceDay ? "wait" : "skip";
}

/** Nairobi calendar date (UTC+3, no DST) as YYYY-MM-DD. */
export const nairobiDate = (ms: number): string => new Date(ms + 3 * 3_600_000).toISOString().slice(0, 10);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Wording for the PDF (banner + check row). null when the records are fresh. */
export function freshnessMessage(d: DataAsOf): { title: string; text: string; severe: boolean } | null {
  if (d.level === "fresh") return null;
  if (d.level === "unknown" || d.syncedAt === null || d.ageDays === null) {
    return { title: "Records may be out of date.", severe: true,
      text: "We could not confirm when this landlord's records were last synced to the cloud. Open Plot Yangu online to sync, then check every figure against your own records before you file." };
  }
  const when = `${nairobiDate(d.syncedAt)} (${plural(d.ageDays, "day")} ago)`;
  if (d.level === "stale") {
    return { title: "Records are a few days old.", severe: false,
      text: `This report was made from records last synced on ${when}. Rent or payments recorded since then are not in it. Sync the app and check the figures before you file.` };
  }
  return { title: "Records are out of date.", severe: true,
    text: `This report was made from records last synced on ${when}. It may be missing recent rent and payments. Sync the app and make the report again before you file.` };
}

/** True when records this old (or never synced) may not be reported on or paid for: over 7 days, or no sign of a sync. */
export const isBlocked = (d: DataAsOf): boolean => d.level === "expired" || d.level === "unknown";

/** Why a report cannot be ordered or paid for. Shown to the landlord or the desk agent. */
export function staleBlockMessage(d: DataAsOf): string {
  if (d.syncedAt === null || d.ageDays === null) {
    return "This landlord's records have not synced to the cloud, so a report cannot be made or paid for yet. Open Plot Yangu online so it syncs, then try again.";
  }
  return `This landlord's records were last synced on ${nairobiDate(d.syncedAt)} (${plural(d.ageDays, "day")} ago), which is too old for a report. Open Plot Yangu online so it syncs, then try again.`;
}

/** One-line version for the compliance checks table. */
export function freshnessDetail(d: DataAsOf): string {
  if (d.level === "fresh" && d.syncedAt !== null && d.ageDays !== null) return `Records last synced on ${nairobiDate(d.syncedAt)} (${plural(d.ageDays, "day")} ago).`;
  return freshnessMessage(d)?.text ?? "";
}

export const monthLabel = (m: string): string => `${MONTHS[Number(m.slice(5, 7)) - 1] ?? m} ${m.slice(0, 4)}`;

/** SMS to the landlord. "warned": the report was made from stale records. "skipped": it was not made. */
export function staleNoticeText(p: { outcome: "warned" | "skipped"; level: FreshnessLevel; ageDays: number | null; property: string; month: string }): string {
  const prop = p.property.trim().slice(0, 24) || "your property";
  const age = p.ageDays === null ? "" : ` ${plural(p.ageDays, "day")} ago`;
  if (p.outcome === "warned") {
    return `Plot Yangu: your ${monthLabel(p.month)} MRI report for ${prop} is ready, but your records were last synced${age || " at an unknown time"}. Open the app online to sync, then check the figures before you file by the 20th.`;
  }
  const why = p.level === "unknown" ? "your records have not synced to the cloud" : `your records were last synced${age}`;
  return `Plot Yangu: we did not make your ${monthLabel(p.month)} MRI report for ${prop} because ${why}. Open the app online to sync, then order it under Compliance reports (your free report is kept). Due by the 20th.`;
}
