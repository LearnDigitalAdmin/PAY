import type { Lang, N } from "./types";

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** "KES 125,000" (thousands separators, up to 2 decimals, trimmed). Locale-independent on purpose. */
export function formatKes(amount: number): string {
  const n = round2(amount);
  const sign = n < 0 ? "-" : "";
  return `${sign}KES ${Math.abs(n).toLocaleString("en-KE", { maximumFractionDigits: 2 })}`;
}

export const money = (v: number): N => ({ v: round2(v), d: formatKes(v) });
export const count = (v: number): N => ({ v, d: String(v) });
/** One decimal in `v`, whole percent in `d`. */
export const pct = (v: number): N => ({ v: Math.round(v * 10) / 10, d: `${Math.round(v)}%` });

export const MASKED_MONEY: N = { v: null, d: "KES ••,•••" };
export const MASKED_COUNT: N = { v: null, d: "••" };
export const MASKED_PCT: N = { v: null, d: "••%" };

/** Mask a number according to how it is displayed. */
export function maskN(n: N): N {
  if (n.d.startsWith("KES") || n.d.startsWith("-KES")) return MASKED_MONEY;
  if (n.d.endsWith("%")) return MASKED_PCT;
  return MASKED_COUNT;
}

/** "John Kamau" -> "J••• K•••" */
export function maskName(name: string): string {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "••••";
  return words.map((w) => `${Array.from(w)[0]}•••`).join(" ");
}

/** "+254712345678" -> "07•• ••• 678" */
export function maskPhone(e164: string | null | undefined): string {
  const digits = String(e164 ?? "").replace(/\D/g, "");
  if (digits.length < 9) return "••••";
  const national = digits.slice(-9);
  return `0${national.slice(0, 1)}•• ••• ${national.slice(-3)}`;
}

// ---------------- Africa/Nairobi dates (UTC+3, no DST) ----------------
const EAT_MS = 3 * 3_600_000;
export const nairobiDate = (now: Date = new Date()): string => new Date(now.getTime() + EAT_MS).toISOString().slice(0, 10);
export const currentMonth = (now: Date = new Date()): string => nairobiDate(now).slice(0, 7);
export const isMonth = (s: unknown): s is string => typeof s === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

/** "2026-10-04T08:00:00Z" or "2026-10-04" -> "2026-10-04" (Nairobi day for full timestamps). */
export function toDay(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const t = Date.parse(value);
  return Number.isFinite(t) ? nairobiDate(new Date(t)) : null;
}

const MONTHS_SW = ["Januari", "Februari", "Machi", "Aprili", "Mei", "Juni", "Julai", "Agosti", "Septemba", "Oktoba", "Novemba", "Desemba"];
const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function monthLabel(month: string, lang: Lang): string {
  const [y, m] = month.split("-").map(Number);
  return `${(lang === "sw" ? MONTHS_SW : MONTHS_EN)[m - 1]} ${y}`;
}
export function dayLabel(day: string, lang: Lang): string {
  const [y, m, d] = day.split("-").map(Number);
  return `${d} ${(lang === "sw" ? MONTHS_SW : MONTHS_EN)[m - 1]} ${y}`;
}

export const STR = {
  en: {
    collectedLine: "Collected (rent and bills)",
    commissionLine: (rate: number) => `Agent commission (${rate}% of base rent)`,
  },
  sw: {
    collectedLine: "Zilizokusanywa (kodi na bili)",
    commissionLine: (rate: number) => `Kamisheni ya wakala (${rate}% ya kodi)`,
  },
} as const;
