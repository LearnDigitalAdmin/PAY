/**
 * Rent payment notices: Paystack's T+2 settlement date (Kenya business days) and the two SMS texts. Pure, no imports.
 * Nairobi is UTC+3 all year (no DST), so local time is UTC + 3h.
 */
const EAT_MS = 3 * 3_600_000;
const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** A Nairobi wall-clock reading of an instant, as a UTC Date whose UTC fields ARE the Nairobi fields. */
const eat = (d: Date) => new Date(d.getTime() + EAT_MS);

/** Gregorian Easter Sunday (anonymous algorithm) -> [month, day]. */
function easter(y: number): [number, number] {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return [month, day];
}
const addDaysUtc = (y: number, m: number, d: number, n: number) => new Date(Date.UTC(y, m - 1, d + n));
const isoOf = (dt: Date) => iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());

/**
 * Gazetted Kenyan public holidays for a year (ISO dates): the fixed national days, Good Friday and Easter Monday, and a
 * holiday that falls on a Sunday moves to the Monday (Public Holidays Act). Idd-ul-Fitr / Idd-ul-Azha are announced from the
 * moon sighting, so they come from `extra` (Firestore config/kenya_holidays.dates) — 2026's are built in.
 */
export function kenyaHolidays(year: number, extra: readonly string[] = []): Set<string> {
  const out = new Set<string>(extra);
  const [em, ed] = easter(year);
  const fixed: Array<[number, number]> = [[1, 1], [5, 1], [6, 1], [10, 10], [10, 20], [12, 12], [12, 25], [12, 26]];
  const taken = new Set<string>();
  for (const [m, d] of fixed) {
    let t = new Date(Date.UTC(year, m - 1, d));
    if (t.getUTCDay() === 0) t = addDaysUtc(year, m, d + 1, 0);   // Sunday -> Monday
    while (taken.has(isoOf(t))) t = addDaysUtc(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), 1);   // Boxing Day yields to a moved Christmas
    taken.add(isoOf(t)); out.add(isoOf(t));
  }
  out.add(isoOf(addDaysUtc(year, em, ed, -2)));
  out.add(isoOf(addDaysUtc(year, em, ed, 1)));
  if (year === 2026) { out.add("2026-03-20"); out.add("2026-05-27"); }
  return out;
}

const isBusinessDay = (dt: Date, extra: readonly string[]) =>
  dt.getUTCDay() !== 0 && dt.getUTCDay() !== 6 && !kenyaHolidays(dt.getUTCFullYear(), extra).has(isoOf(dt));

/**
 * Expected Paystack settlement: T+2 business days (weekends and Kenyan public holidays excluded). A payment made on a
 * non-business day counts as made on the next business day. Returns the Nairobi calendar date.
 */
export function settlementDate(paidAt: Date, extraHolidays: readonly string[] = [], days = 2): Date {
  const local = eat(paidAt);
  let cur = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
  while (!isBusinessDay(cur, extraHolidays)) cur = addDaysUtc(cur.getUTCFullYear(), cur.getUTCMonth() + 1, cur.getUTCDate(), 1);
  let left = days;
  while (left > 0) {
    cur = addDaysUtc(cur.getUTCFullYear(), cur.getUTCMonth() + 1, cur.getUTCDate(), 1);
    if (isBusinessDay(cur, extraHolidays)) left--;
  }
  return cur;   // UTC fields = the Nairobi date
}

/** DD/MM/YYYY HH:MM in Nairobi time. */
export function fmtDateTime(d: Date): string {
  const l = eat(d);
  return `${pad(l.getUTCDate())}/${pad(l.getUTCMonth() + 1)}/${l.getUTCFullYear()} ${pad(l.getUTCHours())}:${pad(l.getUTCMinutes())}`;
}
/** DD/MM/YYYY of a date whose UTC fields are already the wanted calendar date (see settlementDate). */
export const fmtDate = (d: Date): string => `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;

/** KES 49,300 / KES 49,300.50 */
export function kes(minor: number): string {
  const whole = Math.floor(minor / 100), cents = minor % 100;
  return `KES ${whole.toLocaleString("en-US")}${cents ? "." + pad(cents) : ""}`;
}

export interface RentSmsFacts {
  rentMinor: number; tenantFeeMinor: number; chargeMinor: number; deductionsMinor: number; netPayoutMinor: number;
  arrearsMinor: number; unit: string; paidAt: Date; settlesOn: Date; tenantName?: string; reference: string;
}

/** To the landlord/agent. Sent from Samuhia's SMS pool — never charged to the landlord. */
export function landlordRentSms(f: RentSmsFacts): string {
  return `Confirmed ${kes(f.rentMinor)} paid for unit ${f.unit} at ${fmtDateTime(f.paidAt)}. Arrears: ${kes(f.arrearsMinor)}. ` +
    `Expected settlement: ${kes(f.netPayoutMinor)} on ${fmtDate(f.settlesOn)}. Transaction cost: ${kes(f.deductionsMinor)}.`;
}

/** To the tenant. Charged to the landlord's SMS credits; skipped when they have none. */
export function tenantRentSms(f: RentSmsFacts): string {
  const first = (f.tenantName || "").trim().split(/\s+/)[0];
  return `${first ? `Dear ${first}, we` : "We"} received your rent payment of ${kes(f.rentMinor)} for unit ${f.unit} at ${fmtDateTime(f.paidAt)}. ` +
    `Transaction fee: ${kes(f.tenantFeeMinor)}. Total paid: ${kes(f.chargeMinor)}. ` +
    (f.arrearsMinor > 0 ? `Balance due: ${kes(f.arrearsMinor)}. ` : "Your invoice is fully paid. ") + `Ref ${f.reference.slice(-8)}.`;
}
