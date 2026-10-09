// Pure date/number helpers for the sync module (Africa/Nairobi = UTC+3, no DST).
const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;

export const round2 = (n: number): number => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;

/** epoch ms -> "YYYY-MM-DD" in EAT. */
export function eatDateIso(ms: number): string {
  return new Date(ms + EAT_OFFSET_MS).toISOString().slice(0, 10);
}
/** epoch ms -> "YYYY-MM" in EAT. */
export function eatMonthKey(ms: number): string {
  return eatDateIso(ms).slice(0, 7);
}

/**
 * Best-effort normalisation of the date shapes found in mychama1 documents
 * ("YYYY-MM-DD", ISO datetimes, epoch ms, Firestore Timestamps) to "YYYY-MM-DD".
 * Returns null when it can't be read — never guesses.
 */
export function toIsoDate(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "string") {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(v.trim());
    return m ? m[1] : null;
  }
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return eatDateIso(v);
  const ts = v as { toMillis?: () => number } | null;
  if (ts && typeof ts.toMillis === "function") return eatDateIso(ts.toMillis());
  return null;
}
