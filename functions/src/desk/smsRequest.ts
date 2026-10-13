// MyRegister asks PAY to plan the desk part of a school's SMS top-up (Register charges on its own project, so it cannot
// run the desk logic itself). Pure request handling lives here; the private HTTPS function wrapping it is in
// ../deskSmsEndpoint.ts. Nothing here trusts a price or a share from the caller: PAY derives the gross from tier x tokens.
import { planDeskSmsCharge, releaseFirstPurchaseReservation } from "./sms";

/** KES per token for MyRegister volume tiers. MUST mirror KES_RATE_PER_TOKEN in index.ts and in Register's chargeSmsTopUp. */
export const SCHOOL_KES_RATE_PER_TOKEN: Readonly<Record<string, number>> = { small: 0.7, medium: 0.5, large: 0.4 };

const ENTITY_KEY = /^school:[A-Za-z0-9_-]{1,40}$/;
const REFERENCE = /^SMS_[A-Za-z0-9_-]{3,128}$/;
const MAX_TOKENS = 1_000_000;

export interface SmsRequestDeps {
  plan: typeof planDeskSmsCharge;
  release: typeof releaseFirstPurchaseReservation;
}
export interface SmsRequestResult { status: number; body: Record<string, unknown> }

const bad = (message: string): SmsRequestResult => ({ status: 400, body: { error: message } });

/**
 * action "plan"    -> { applied:false, reason } | { applied:true, splitCode, commission }   (HTTP 200 either way)
 * action "release" -> { released:boolean }   frees the first-purchase reservation when Register's charge never started
 * Only `school:` entities are accepted: Plot Yangu top-ups are planned inside PAY itself.
 */
export async function handleDeskSmsRequest(
  raw: unknown, deps: SmsRequestDeps = { plan: planDeskSmsCharge, release: releaseFirstPurchaseReservation },
): Promise<SmsRequestResult> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad("Body must be a JSON object");
  const b = raw as Record<string, unknown>;
  if (typeof b.entityKey !== "string" || !ENTITY_KEY.test(b.entityKey)) return bad("entityKey must look like school:<code>");
  if (typeof b.reference !== "string" || !REFERENCE.test(b.reference)) return bad("reference must look like SMS_<id>");

  if (b.action === "release") {
    return { status: 200, body: { released: await deps.release(b.entityKey, b.reference) } };
  }
  if (b.action !== "plan") return bad("action must be plan or release");

  const rate = typeof b.tier === "string" ? SCHOOL_KES_RATE_PER_TOKEN[b.tier] : undefined;
  if (rate === undefined) return bad("tier must be small, medium or large");
  if (typeof b.tokens !== "number" || !Number.isInteger(b.tokens) || b.tokens < 1 || b.tokens > MAX_TOKENS) return bad("tokens must be a whole number of at least 1");

  const plan = await deps.plan({
    entityKey: b.entityKey, reference: b.reference, grossMinor: Math.round(b.tokens * rate * 100), credits: b.tokens,
  });
  if (!plan.applied) return { status: 200, body: { applied: false, reason: plan.reason } };
  return { status: 200, body: { applied: true, splitCode: plan.splitCode, commission: plan.commission } };
}
