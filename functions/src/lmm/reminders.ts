// When to text a tenant about a missed payment. Pure. Not spammy: a reminder only after the plan's own quiet period, never closer
// than MIN_DAYS_BETWEEN_SMS to any earlier SMS, and at most 3 per stretch of silence (a payment resets the count).
import { FREQUENCY_DAYS, LMM, type Frequency } from "./config";

export interface ReminderInput {
  frequency: Frequency; status: string; remainingMinor: number; createdAt: number; lastPaymentAt: number; lastSmsAt: number; missedCount: number;
}
const DAY = 86_400_000;
export function missedReminder(p: ReminderInput, now: number): { send: true; days: number } | { send: false } {
  if (p.status !== "active" || p.remainingMinor <= 0 || p.missedCount >= 3) return { send: false };
  const since = Math.max(p.lastPaymentAt, p.createdAt);
  const days = Math.floor((now - since) / DAY);
  const after = LMM.MISSED_AFTER_DAYS[p.frequency];
  if (days < after) return { send: false };
  const gap = Math.max(LMM.MIN_DAYS_BETWEEN_SMS, FREQUENCY_DAYS[p.frequency]);
  if (p.lastSmsAt > 0 && now - p.lastSmsAt < gap * DAY) return { send: false };
  return { send: true, days };
}
/** The highest milestone newly reached (25/50/75/100 %), or null. Everything at or below it counts as sent. */
export function newMilestone(pct: number, sent: readonly number[]): number | null {
  const crossed = LMM.MILESTONES.filter((m) => pct >= m && !sent.includes(m));
  return crossed.length ? crossed[crossed.length - 1] : null;
}
