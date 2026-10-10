// Formatting + friendly error text for the MyChama connector UI.
import type { MyChamaErrorCode } from './contract';

export const formatKES = (n: number | null | undefined): string =>
  n === null || n === undefined ? '—' : `KES ${new Intl.NumberFormat('en-KE', { maximumFractionDigits: 2 }).format(n)}`;

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(`${iso.slice(0, 10)}T12:00:00+03:00`);     // midday EAT: safe against any rounding
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Nairobi' });
}

export function timeAgo(ms: number | null | undefined, now: number = Date.now()): string {
  if (!ms) return 'never';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

const MESSAGES: Record<MyChamaErrorCode, string> = {
  unauthenticated: 'Please sign in again.',
  not_linked: 'This chama is not linked to your account.',
  link_needs_reverify: 'Please verify your MyChama phone number first.',
  throttled: 'Please wait a moment before trying again.',
  chama_unavailable: 'MyChama is not reachable right now. Please try again shortly.',
  online_collection_disabled: 'Online payments are not enabled for this chama.',
  invalid_amount: 'Please enter a valid amount.',
  invalid_target: 'That item can no longer be paid. Refresh and try again.',
  invalid_phone: 'Please enter a valid Safaricom or Airtel number.',
  rate_limited: 'Too many attempts. Please wait a bit and try again.',
  code_invalid: 'That code is not correct.',
  code_expired: 'That code has expired. Request a new one.',
  code_attempts_exceeded: 'Too many wrong attempts. Request a new code.',
  send_limit_reached: 'Too many codes requested today. Try again tomorrow.',
  upstream_failure: 'Something went wrong on our side. Please try again shortly.',
  not_implemented: 'This feature is not available yet.',
  internal: 'Something went wrong. Please try again.',
};

export const chamaErrorMessage = (code: MyChamaErrorCode | null, fallback = MESSAGES.internal): string =>
  code ? MESSAGES[code] ?? fallback : fallback;

/** `remainingAttempts` rides next to `code` in wrong-code errors (see track-A-notes.md). */
export const remainingAttemptsOf = (err: unknown): number | null => {
  const v = (err as { details?: { remainingAttempts?: unknown } } | null)?.details?.remainingAttempts;
  return typeof v === 'number' ? v : null;
};
