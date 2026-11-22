// Perks business rules. Pure functions: this is the single place the points maths lives (the demo's logic, ported).
import { PerksError, type ItemType, type NotificationType, type PerksSettings } from "./types";

export const MAX_AMOUNT = 1_000_000;

export function toE164(raw: unknown): string {
  const p = String(raw ?? "").replace(/[\s-]/g, "");
  const out = /^\+254[17]\d{8}$/.test(p) ? p : /^254[17]\d{8}$/.test(p) ? "+" + p : /^0[17]\d{8}$/.test(p) ? "+254" + p.slice(1) : "";
  if (!out) throw new PerksError("invalid-argument", "Enter a valid Kenyan mobile number, for example 0712 345 678.");
  return out;
}
export const customerId = (e164: string) => e164.replace(/^\+/, "");
export const normCode = (raw: unknown) => String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

export function cleanMoney(v: unknown, allowZero = false, what = "Amount"): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < (allowZero ? 0 : 1) || n > MAX_AMOUNT) throw new PerksError("invalid-argument", `${what} must be a whole number of KES between ${allowZero ? 0 : 1} and ${MAX_AMOUNT}.`);
  return n;
}
export function cleanPoints(v: unknown): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 1_000_000) throw new PerksError("invalid-argument", "Points must be a whole number.");
  return n;
}

export interface SaleItem { itemName: string; itemType: ItemType; price: number }
export function cleanItems(raw: unknown): SaleItem[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 30) throw new PerksError("invalid-argument", "Add between 1 and 30 items.");
  return raw.map((r, i) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const itemName = String(o.itemName ?? "").trim();
    if (itemName.length < 1 || itemName.length > 80) throw new PerksError("invalid-argument", `Item ${i + 1}: name is required.`);
    if (o.itemType !== "SERVICE" && o.itemType !== "PRODUCT") throw new PerksError("invalid-argument", `Item ${i + 1}: type must be SERVICE or PRODUCT.`);
    return { itemName, itemType: o.itemType as ItemType, price: cleanMoney(o.price, false, `Item ${i + 1} price`) };
  });
}

/** floor(eligible / 100 * rate), computed on integers so there is no float drift. */
export const pointsFor = (eligible: number, rate: number) => Math.floor((eligible * rate) / 100);
export const rateFor = (t: ItemType, s: PerksSettings) => (t === "SERVICE" ? s.servicesPointsRate : s.productsPointsRate);
export const redemptionValueKes = (points: number, s: PerksSettings) => Math.round((points * s.pointsValue * 100) / s.pointsValueUnit) / 100;
/** Strictly greater than the minimum: KES 50 does not qualify, KES 51 does. */
export const qualifiesReferral = (eligible: number, s: PerksSettings) => eligible > s.referralMinimumPurchase;

export const ALLOWED_PLACEHOLDERS = ["phone", "amount", "service", "pointsEarned", "pointsBalance", "balanceValue", "pointsRedeemed", "discount", "referralCode", "referrerReward", "inviteeReward", "voucherCode", "voucherValue"];
export const DEFAULT_TEMPLATES: Record<NotificationType, string> = {
  sale: "Samuhia Cyber: KES {{amount}} received. You earned {{pointsEarned}} pts. Balance {{pointsBalance}} pts (KES {{balanceValue}}).",
  redeem: "Samuhia Cyber: you redeemed {{pointsRedeemed}} pts for KES {{discount}} off. Balance {{pointsBalance}} pts.",
  referralReferrer: "Samuhia Perks: your referral qualified! You earned {{referrerReward}} pts. Balance {{pointsBalance}} pts.",
  referralInvitee: "Samuhia Perks: welcome bonus! You earned {{inviteeReward}} pts. Balance {{pointsBalance}} pts.",
  voucher: "Samuhia Perks: you won voucher {{voucherCode}} worth {{voucherValue}}. Show it at Samuhia Cyber.",
  welcome: "Welcome to Samuhia Perks! Your referral code is {{referralCode}}. Earn points on every visit.",
};
export const TEMPLATE_IDS = Object.keys(DEFAULT_TEMPLATES) as NotificationType[];

export function validateTemplateBody(body: unknown): string {
  const b = String(body ?? "").trim();
  if (b.length < 5 || b.length > 480) throw new PerksError("invalid-argument", "Template must be 5 to 480 characters.");
  if (/https?:\/\/|www\./i.test(b)) throw new PerksError("invalid-argument", "Adverts and links belong in Campaigns, not templates.");
  for (const m of b.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) if (!ALLOWED_PLACEHOLDERS.includes(m[1])) throw new PerksError("invalid-argument", `Unknown placeholder {{${m[1]}}}.`);
  return b;
}

export interface CampaignLike { advert: string; destinationUrl: string; active: boolean; startDate?: string | null; endDate?: string | null }
export function campaignLive(c: CampaignLike | null | undefined, now: number): c is CampaignLike {
  if (!c || !c.active) return false;
  const day = new Date(now + 3 * 3600_000).toISOString().slice(0, 10); // Africa/Nairobi is UTC+3
  return (!c.startDate || c.startDate <= day) && (!c.endDate || c.endDate >= day);
}

/** The sender ID is transactional and cannot receive replies, so opting out is a toggle in the Perks app, not a STOP keyword. */
export const OPT_OUT_TEXT = "Opt out: perks.samuhia.co.ke";
/** TRANSACTION TEMPLATE + CAMPAIGN ADVERT + LINK + opt-out pointer, advert only with explicit marketing consent. */
export function composeSms(body: string, vars: Record<string, string | number>, campaign: CampaignLike | null, marketingConsent: boolean): string {
  const base = body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k: string) => String(vars[k] ?? ""));
  return marketingConsent && campaign ? `${base} ${campaign.advert} ${campaign.destinationUrl} ${OPT_OUT_TEXT}` : base;
}
