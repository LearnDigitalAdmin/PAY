// When a plan's money is due to go to the landlord. Pure. Dates are Nairobi calendar days as "YYYY-MM-DD" (they sort as text).
import { LMM } from "./config";

const EAT = 3 * 3_600_000, DAY = 86_400_000;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Today's date in Nairobi. */
export const eatDate = (now: number): string => new Date(now + EAT).toISOString().slice(0, 10);

/** An invoice due date if it is a real "YYYY-MM-DD" (anything else is ignored, never guessed). */
export function validDate(v: unknown): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? ""));
  if (!m) return null;
  const d = `${m[1]}-${m[2]}-${m[3]}`;
  return Number.isNaN(Date.parse(`${d}T00:00:00Z`)) ? null : d;
}

/** The next 10:00 Nairobi sweep that has not run yet: today before 10:00, otherwise tomorrow. */
export function nextSweepDate(now: number): string {
  const hour = new Date(now + EAT).getUTCHours();
  return eatDate(hour < 10 ? now : now + DAY);
}

/** The first "5th" (the old settlement day) on or after `fromIso`. Used only when a tenant has no open invoice. */
export function fifthOnOrAfter(fromIso: string): string {
  let y = Number(fromIso.slice(0, 4)), m = Number(fromIso.slice(5, 7)) - 1;
  if (Number(fromIso.slice(8, 10)) > LMM.SETTLE_DAY) { m += 1; if (m > 11) { m = 0; y += 1; } }
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(LMM.SETTLE_DAY).padStart(2, "0")}`;
}

/** The day the landlord is next paid with whatever is collected: the earliest open invoice's due date (or the 5th if nothing is invoiced), but never a sweep that already ran. */
export function settlesOn(dueOn: string | null, now: number): string {
  const sweep = nextSweepDate(now);
  const target = dueOn ?? fifthOnOrAfter(sweep);
  return target >= sweep ? target : sweep;
}

/** Does the sweep of `today` pay this plan out? Due date reached (or passed); with no invoice, only on the 5th. */
export const payoutDue = (dueOn: string | null, today: string): boolean => (dueOn ? dueOn <= today : Number(today.slice(8, 10)) === LMM.SETTLE_DAY);

/** Whole days from today (Nairobi) to a due date; negative once it is past. */
export const daysUntil = (iso: string, now: number): number => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${eatDate(now)}T00:00:00Z`)) / DAY);

/** "2026-11-05" -> "5 Nov" (for SMS and screens). */
export function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${Number(m[3])} ${MON[Number(m[2]) - 1]}` : iso;
}
