// LMMX: standalone Lipa Mdogo Mdogo. Every callable below is region africa-south1 and is named in contract.ts (LmmxCallableMap).
import { onCall } from "firebase-functions/v2/https";
import type { CallableRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { BUNDLE_SECRETS } from "../secretsBundle";
import { COL, X } from "./config";
import {
  LMMX, LMMX_REGION, LMMX_TOP_DESK, earningsTable, maskName, maskPhone, normalizeKePhone, parseLmmxCode, validIdNumber,
} from "./contract";
import type { BotConfirmCodeOut, BotLookupOut, LmmxCallableName, LmmxCallableMap, PipelineRow, DeskEarningsOut, DeskPreviewOut } from "./contract";
import { dec, H } from "./crypto";
import { LmmxError, fail, toHttps } from "./errors";
import { audit, col, now, rateOk } from "./store";
import { callerIp, requireDesk, requireEnabled, requireTenant, requireTop, verifiedPhone, verifyBot } from "./authz";
import { checkRecipient } from "./recipients";
import { botTenant, creditPayment, historyPage, makeQuote, startPayment } from "./payments";
import { confirmChange, cancelChangeByCode, cancelChangeByDesk, requestChange, setDueDay, setPlan, topUpdate } from "./changes";
import { confirmSetup, createTenant, getTenantView, listTenants, loadRecipient, normId, ownedTenant, pendingChangeView, resendSetupOtp, setupStatus, tenantLink, tenantSummary } from "./tenants";
import { projections, remainingOf, loadCycles } from "./cycles";
import * as top from "./top";
import { onTransferEvent } from "./settle";
import { auditAnchor, dailySweep, reconcileDaily, settlementWorker } from "./sweep";
import type { ChangeDoc, LeadDoc, TenantDoc } from "./types";

const OPTS = { region: LMMX_REGION, cors: true, secrets: BUNDLE_SECRETS, memory: "256MiB" as const, timeoutSeconds: 60, maxInstances: 10 };
type In<K extends LmmxCallableName> = LmmxCallableMap[K]["in"];
type Out<K extends LmmxCallableName> = LmmxCallableMap[K]["out"];
/** Wraps a handler: every error becomes a safe HttpsError carrying details.lmmx. */
const fn = <K extends LmmxCallableName>(_name: K, h: (req: CallableRequest<In<K>>) => Promise<Out<K>>, extra: { timeoutSeconds?: number } = {}) =>
  onCall({ ...OPTS, ...extra }, async (req) => { try { return await h(req as CallableRequest<In<K>>); } catch (e) { throw toHttps(e); } });
/** COG-0000 plus a written reason; checked BEFORE the rest of the input, so a stranger learns nothing about the shape of the request. */
const topWithReason = (r: CallableRequest<unknown>) => requireTop(r, String((r.data as { reason?: unknown } | undefined)?.reason ?? ""));
const bad = <T>(v: T | undefined): T => v ?? fail("LMMX_E_VALIDATION", "Something is missing. Please check and try again.");

// ============================================================================================================ DESK
export const lmmx_desk_checkRecipient = fn("lmmx_desk_checkRecipient", async (r) => { await requireEnabled(); return checkRecipient(await requireDesk(r), bad(r.data)); });
export const lmmx_desk_createTenant = fn("lmmx_desk_createTenant", async (r) => { await requireEnabled(); return createTenant(await requireDesk(r), bad(r.data)); }, { timeoutSeconds: 120 });
export const lmmx_desk_setupStatus = fn("lmmx_desk_setupStatus", async (r) => setupStatus(await requireDesk(r), r.data?.tenantId));
export const lmmx_desk_confirmSetup = fn("lmmx_desk_confirmSetup", async (r) => {
  const desk = await requireDesk(r); await requireEnabled();
  const t = await ownedTenant(desk, r.data?.tenantId);
  await confirmSetup({ tenantId: t.tenantId, otp: String(r.data?.otp ?? ""), via: "desk", desk });
  return { tenantId: t.tenantId, status: "active" as const };
}, { timeoutSeconds: 120 });
export const lmmx_desk_resendOtp = fn("lmmx_desk_resendOtp", async (r) => { await requireEnabled(); return resendSetupOtp(await requireDesk(r), r.data?.tenantId); });
export const lmmx_desk_listTenants = fn("lmmx_desk_listTenants", async (r) => listTenants(await requireDesk(r), r.data ?? {}));
export const lmmx_desk_getTenant = fn("lmmx_desk_getTenant", async (r) => getTenantView(await requireDesk(r), r.data?.tenantId));
export const lmmx_desk_requestChange = fn("lmmx_desk_requestChange", async (r) => {
  await requireEnabled();
  const desk = await requireDesk(r), d = bad(r.data);
  if (desk.isTop) {
    // COG-0000 needs no tenant code and no cooling-off: the change is applied now (recent sign-in and an audited reason are still required).
    const t = await requireTop(r, "Top desk change from the desk screen");
    await topUpdate(t, { tenantId: d.tenantId, ...(d.kind === "rent" ? { rentMinor: d.rentMinor } : { recipient: d.recipient }), reason: t.reason });
    return { changeId: `TOP${Date.now().toString(36).toUpperCase()}`, status: "applied" as const, requiresTenantOtp: false };
  }
  return requestChange(desk, d);
}, { timeoutSeconds: 120 });
export const lmmx_desk_confirmChange = fn("lmmx_desk_confirmChange", async (r) => { const desk = await requireDesk(r); return confirmChange({ changeId: String(r.data?.changeId ?? ""), otp: String(r.data?.otp ?? ""), via: "desk", desk }); });
export const lmmx_desk_cancelChange = fn("lmmx_desk_cancelChange", async (r) => { await cancelChangeByDesk(await requireDesk(r), r.data?.changeId); return { ok: true }; });
export const lmmx_desk_earnings = fn("lmmx_desk_earnings", async (r): Promise<DeskEarningsOut> => {
  const desk = await requireDesk(r);
  const from = Number(r.data?.from ?? 0), to = Number(r.data?.to ?? now());
  const q = await col(COL.earnings).where("deskCode", "==", desk.deskCode).where("createdAt", ">=", from).where("createdAt", "<=", to).limit(5000).get();
  const by = new Map<string, number>(); let total = 0;
  for (const d of q.docs) { const e = d.data() as { tenantId: string; deskShareMinor: number }; total += e.deskShareMinor; by.set(e.tenantId, (by.get(e.tenantId) ?? 0) + e.deskShareMinor); }
  const led = await col("desk_ledger").where("agentId", "==", desk.uid).where("kind", "==", "bonus").where("createdAt", ">=", from).where("createdAt", "<=", to).limit(2000).get();
  let completion = 0, landlord = 0;
  for (const d of led.docs) { const e = d.data() as { note?: string; amountMinor: number }; if (String(e.note ?? "").startsWith("Lipa Mdogo Mdogo completion")) completion += e.amountMinor; else if (String(e.note ?? "").startsWith("Lipa Mdogo Mdogo")) landlord += e.amountMinor; }
  const byTenant: DeskEarningsOut["byTenant"] = [];
  for (const [tid, v] of [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50)) { const t = (await col(COL.tenants).doc(tid).get()).data() as TenantDoc | undefined; if (t) byTenant.push({ tenantId: tid, nameMasked: maskName(dec(t.nameEnc)), deskShareMinor: v }); }
  return { instalments: q.size, deskShareMinor: total, completionBonusMinor: completion, landlordBonusMinor: landlord, byTenant };
});
export const lmmx_desk_preview = fn("lmmx_desk_preview", async (r): Promise<DeskPreviewOut> => {
  await requireDesk(r);
  const rent = r.data?.rentMinor, ch = r.data?.channel;
  if (typeof rent !== "number" || rent % 100 !== 0 || rent < LMMX.RENT_MIN_MINOR || rent > LMMX.RENT_MAX_MINOR || !["phone", "till", "bank"].includes(ch)) return fail("LMMX_E_VALIDATION", "Enter the rent and the payment type.");
  return { table: earningsTable(rent, ch), projection: projections(rent, ch) };
});
export const lmmx_desk_pipeline = fn("lmmx_desk_pipeline", async (r) => {
  const desk = await requireDesk(r);
  const q = desk.isTop ? await col(COL.leads).limit(100).get() : await col(COL.leads).where("deskCodes", "array-contains", desk.deskCode).limit(100).get();
  const landlords: PipelineRow[] = q.docs.map((d) => d.data() as LeadDoc).sort((a, b) => b.updatedAt - a.updatedAt).map((l) => ({
    leadIdMasked: `${l.leadId.slice(0, 6)}***`, landlordLabel: maskName(dec(l.displayNameEnc)), tenants: l.tenants, monthlyRentMinor: l.monthlyRentMinor, stage: l.stage, onPms: l.onPms,
    conversionNote: l.onPms ? "On Plot Yangu. You earn the usual subscription share." : "If this landlord joins Plot Yangu you earn a bonus (their first paid month, at least KES 300) plus the usual subscription share.",
  }));
  return { landlords };
});

// ============================================================================================================ TOP DESK
export const lmmx_top_reviewQueue = fn("lmmx_top_reviewQueue", async (r) => { await requireTop(r); return top.reviewQueue(); });
export const lmmx_top_reviewDecision = fn("lmmx_top_reviewDecision", async (r) => { const t = await topWithReason(r); await top.reviewDecision(t, r.data); return { ok: true }; }, { timeoutSeconds: 120 });
export const lmmx_top_freeze = fn("lmmx_top_freeze", async (r) => { const t = await topWithReason(r); await top.setFreeze(t, r.data.scope, r.data.id, true); return { ok: true }; });
export const lmmx_top_unfreeze = fn("lmmx_top_unfreeze", async (r) => { const t = await topWithReason(r); await top.setFreeze(t, r.data.scope, r.data.id, false); return { ok: true }; });
export const lmmx_top_reassign = fn("lmmx_top_reassign", async (r) => { const t = await topWithReason(r); await top.reassign(t, r.data.tenantId, r.data.toDeskCode); return { ok: true }; });
export const lmmx_top_reveal = fn("lmmx_top_reveal", async (r) => { const t = await topWithReason(r); return top.reveal(t, r.data); });
export const lmmx_top_updateTenant = fn("lmmx_top_updateTenant", async (r) => { const t = await topWithReason(r); await topUpdate(t, r.data); return { ok: true }; }, { timeoutSeconds: 120 });
export const lmmx_top_auditList = fn("lmmx_top_auditList", async (r) => { await requireTop(r); return top.auditList(r.data ?? {}); });
export const lmmx_top_auditVerify = fn("lmmx_top_auditVerify", async (r) => { await requireTop(r); return top.auditVerify(r.data ?? {}); }, { timeoutSeconds: 120 });
export const lmmx_top_leadsList = fn("lmmx_top_leadsList", async (r) => { await requireTop(r); return top.leadsList(r.data ?? {}); });
export const lmmx_top_leadGet = fn("lmmx_top_leadGet", async (r) => { const t = await requireTop(r, "opened lead contact"); return top.leadGet(t, bad(r.data).leadId); });
export const lmmx_top_leadUpdate = fn("lmmx_top_leadUpdate", async (r) => { const t = await requireTop(r, (r.data as { reason?: string } | undefined)?.reason ?? "CRM update"); await top.leadUpdate(t, bad(r.data)); return { ok: true }; });
export const lmmx_top_stats = fn("lmmx_top_stats", async (r) => { await requireTop(r); return top.stats(); });

// ============================================================================================================ TENANT
export const lmmx_tenant_link = fn("lmmx_tenant_link", async (r) => {
  if (!r.auth) return fail("LMMX_E_AUTH", "Please sign in.");
  await requireEnabled();
  const phone = verifiedPhone(r);
  if (!phone) return fail("LMMX_E_AUTH", "Please sign in with your phone number.");
  return tenantLink(r, phone, bad(r.data), callerIp(r));
});
export const lmmx_tenant_summary = fn("lmmx_tenant_summary", async (r) => tenantSummary(await requireTenant(r, ["awaiting_confirmation", "active", "paused", "frozen"])));
export const lmmx_tenant_history = fn("lmmx_tenant_history", async (r) => { const c = await requireTenant(r, ["active", "paused", "frozen"]); return historyPage(c.tenantId, r.data?.cursor); });
export const lmmx_tenant_quote = fn("lmmx_tenant_quote", async (r) => { const c = await requireTenant(r, ["active"]); return makeQuote(c.tenant, Number(bad(r.data).creditMinor)); });
export const lmmx_tenant_pay = fn("lmmx_tenant_pay", async (r) => { const c = await requireTenant(r, ["active"]); return startPayment(c.tenant, bad(r.data).quoteId, r.data.payerPhone); }, { timeoutSeconds: 90 });
export const lmmx_tenant_setDueDay = fn("lmmx_tenant_setDueDay", async (r) => { const c = await requireTenant(r, ["active", "paused"]); return setDueDay(c.tenant, bad(r.data).dueDay); });
export const lmmx_tenant_setPlan = fn("lmmx_tenant_setPlan", async (r) => { const c = await requireTenant(r, ["active", "paused"]); await setPlan(c.tenant, bad(r.data).frequency, r.data.suggestedCreditMinor); return { ok: true }; });
export const lmmx_tenant_confirmSetup = fn("lmmx_tenant_confirmSetup", async (r) => {
  const c = await requireTenant(r, ["awaiting_confirmation"]); await requireEnabled();
  await confirmSetup({ tenantId: c.tenantId, otp: String(bad(r.data).otp), via: "tenant" });
  return { status: "active" as const };
}, { timeoutSeconds: 120 });
export const lmmx_tenant_confirmChange = fn("lmmx_tenant_confirmChange", async (r) => { const c = await requireTenant(r, ["active", "paused"]); return confirmChange({ changeId: String(bad(r.data).changeId), otp: String(r.data.otp ?? ""), via: "tenant", tenantId: c.tenantId }); });
export const lmmx_tenant_cancelChange = fn("lmmx_tenant_cancelChange", async (r) => { const c = await requireTenant(r, ["active", "paused"]); await cancelChangeByCode({ changeId: String(bad(r.data).changeId), code: String(r.data.cancelCode ?? ""), via: "tenant", tenantId: c.tenantId }); return { ok: true }; });

// ============================================================================================================ BOT (signed requests, no Firebase Auth)
const botPhone = (v: unknown): string => normalizeKePhone(v) ?? fail("LMMX_E_VALIDATION", "Invalid phone.");
/** DIAGNOSTIC (temporary): never logs the phone, ID or any name. Only masked phone, ID shape, counts, booleans and error codes. */
const lkLog = (step: string, info: Record<string, unknown>): void => console.log(`LMMX LOOKUP ${step} ${JSON.stringify(info)}`);
const errInfo = (e: unknown): { code?: unknown; message: string } => ({ code: (e as { code?: unknown })?.code, message: String((e as Error)?.message ?? e).replace(/https?:\/\/\S+/g, "<url>").slice(0, 300) });
async function lookupDiagnose(phone: string, id: string): Promise<{ legacy: boolean }> {
  const idHash = H("id", normId(id));
  const out: Record<string, unknown> = { phone: maskPhone(phone), idLen: id.length, idDigitsOnly: /^\d+$/.test(id), idLeadingZero: id.startsWith("0") };
  try {
    const byPhone = await col(COL.tenants).where("phoneHash", "==", H("phone", phone)).limit(5).get();
    const rows = byPhone.docs.map((d) => d.data() as TenantDoc);
    out.standalone_byPhone = { count: rows.length, statuses: rows.map((t) => t.status), idHashMatchesOne: rows.some((t) => t.idHash === idHash) };
  } catch (e) { out.standalone_byPhone = { error: errInfo(e) }; }
  try {
    const byId = await col(COL.tenants).where("idHash", "==", idHash).limit(5).get();
    out.standalone_byIdOnly = { count: byId.size, statuses: byId.docs.map((d) => (d.data() as TenantDoc).status) };
  } catch (e) { out.standalone_byIdOnly = { error: errInfo(e) }; }
  let legacy = false;
  const variants: [string, string | number][] = [["string", id], ["leadingZero", `0${id}`], ...(Number.isFinite(Number(id)) && /^\d+$/.test(id) ? [["number", Number(id)] as [string, number]] : [])];
  const legacyRes: Record<string, unknown> = {};
  for (const [label, val] of variants) {
    try {
      const q = await col("users").firestore.collectionGroup("tenants").where("localId", "==", val).limit(1).get();
      legacyRes[label] = { found: !q.empty };
      if (label === "string" && !q.empty) legacy = true;
    } catch (e) { legacyRes[label] = { error: errInfo(e) }; }
  }
  out.legacy_localId = legacyRes;
  lkLog("none-diagnosis", out);
  return { legacy };
}
export const lmmx_bot_lookup = fn("lmmx_bot_lookup", async (r): Promise<BotLookupOut> => {
  const d = bad(r.data) as unknown as Record<string, unknown>; await verifyBot("lmmx_bot_lookup", d);
  const phone = botPhone(d.phone), id = String(d.idNumber ?? "");
  if (!(await rateOk(`botl|${phone}`, X.RATE.botPer10Min, 600_000))) return fail("LMMX_E_RATE", "Too many tries. Please wait a few minutes.");
  if (!/^[A-Za-z0-9]{6,9}$/.test(id)) { lkLog("rejected-id-shape", { phone: maskPhone(phone), idLen: id.length }); return { kind: "none" }; }
  lkLog("start", { phone: maskPhone(phone), idLen: id.length });
  const t = await botTenant(phone, id);
  if (t) {
    lkLog("result", { kind: "standalone", status: t.status, frozen: !!t.frozen });
    if (t.status === "awaiting_confirmation") return { kind: "standalone", standalone: { firstName: "", rentMinor: t.rent.amountMinor, remainingMinor: t.rent.amountMinor, dueDate: "", payByDate: "", suggestedCreditMinor: t.suggestedCreditMinor, awaitingSetup: true } };
    const cyc = await loadCycles(t.tenantId); const cur = cyc.find((c) => remainingOf(c) > 0) ?? cyc[0];
    const s = await tenantSummary({ uid: "", tenantId: t.tenantId, tenant: t, phone, ip: "" });
    return { kind: "standalone", standalone: { firstName: s.firstName, rentMinor: t.rent.amountMinor, remainingMinor: cur ? remainingOf(cur) : t.rent.amountMinor, dueDate: cur?.dueDate ?? "", payByDate: cur?.payByDate ?? "", suggestedCreditMinor: s.suggestedCreditMinor, ...(t.frozen ? { frozen: true } : {}) } };
  }
  // PMS stores a tenant's National ID (`localId`) as a NUMBER on most accounts and as a string on some, so ask for both forms.
  const idForms: (string | number)[] = [id, ...(/^\d+$/.test(id) ? [Number(id)] : [])];
  const legacy = await col("users").firestore.collectionGroup("tenants").where("localId", "in", idForms).limit(1).get().catch((e) => { lkLog("legacy-query-ERROR", { error: errInfo(e) }); return null; });
  if (legacy && !legacy.empty) { lkLog("result", { kind: "legacy", storedLocalIdType: typeof legacy.docs[0].data().localId }); return { kind: "legacy" }; }
  await lookupDiagnose(phone, id).catch((e) => lkLog("diagnose-failed", { error: errInfo(e) }));
  lkLog("result", { kind: "none" });
  return { kind: "none" };
});
const botTenantOrFail = async (d: Record<string, unknown>): Promise<TenantDoc> => (await botTenant(botPhone(d.phone), String(d.idNumber ?? ""))) ?? fail("LMMX_E_NOT_FOUND", "We could not find your account.");
export const lmmx_bot_quote = fn("lmmx_bot_quote", async (r) => { const d = bad(r.data) as unknown as Record<string, unknown>; await verifyBot("lmmx_bot_quote", d); return makeQuote(await botTenantOrFail(d), Number(d.creditMinor)); });
export const lmmx_bot_pay = fn("lmmx_bot_pay", async (r) => { const d = bad(r.data) as unknown as Record<string, unknown>; await verifyBot("lmmx_bot_pay", d); return startPayment(await botTenantOrFail(d), d.quoteId, d.payerPhone); }, { timeoutSeconds: 90 });
export const lmmx_bot_joinInfo = fn("lmmx_bot_joinInfo", async (r) => {
  await verifyBot("lmmx_bot_joinInfo", (r.data ?? {}) as unknown as Record<string, unknown>);
  return { supportPhones: [X.SUPPORT_PHONE], text: "To join Lipa Mdogo Mdogo, visit a Samuhia desk agent near you with your ID and your landlord's payment details, or call us." };
});
export const lmmx_bot_confirmCode = fn("lmmx_bot_confirmCode", async (r): Promise<BotConfirmCodeOut> => {
  const d = bad(r.data) as unknown as Record<string, unknown>; await verifyBot("lmmx_bot_confirmCode", d);
  const phone = botPhone(d.phone); const parsed = parseLmmxCode(d.text);
  if (!parsed) return { result: "invalid" };
  if (!(await rateOk(`botc|${phone}`, 12, 600_000))) return { result: "locked" };
  const q = await col(COL.tenants).where("phoneHash", "==", H("phone", phone)).limit(5).get();
  const t = q.docs.map((x) => x.data() as TenantDoc).find((x) => x.status !== "closed" && x.status !== "migrated");
  if (!t) return { result: "not_found" };
  const map = (e: unknown): BotConfirmCodeOut => {
    if (e instanceof LmmxError) return { result: e.lmmx === "LMMX_E_OTP_EXPIRED" ? "expired" : e.lmmx === "LMMX_E_OTP_LOCKED" || e.lmmx === "LMMX_E_RATE" ? "locked" : e.lmmx === "LMMX_E_OTP_INVALID" ? "invalid" : "not_found" };
    throw e;
  };
  try {
    if (parsed.kind === "otp") {
      if (t.status === "awaiting_confirmation") { await confirmSetup({ tenantId: t.tenantId, otp: parsed.code, via: "bot" }); return { result: "setup_confirmed", summary: `Rent KES ${t.rent.amountMinor / 100}, due day ${t.dueDay}` }; }
      const ch = (await pendingChangeView(t.tenantId));
      if (ch && ch.status === "awaiting_tenant_otp") { await confirmChange({ changeId: ch.changeId, otp: parsed.code, via: "bot", tenantId: t.tenantId }); return { result: "change_confirmed", summary: ch.summary }; }
      return { result: "not_found" };
    }
    const ch = await pendingChangeView(t.tenantId);
    if (!ch) return { result: "not_found" };
    await cancelChangeByCode({ changeId: ch.changeId, code: parsed.code, via: "bot", tenantId: t.tenantId });
    return { result: "change_cancelled", summary: ch.summary };
  } catch (e) { return map(e); }
}, { timeoutSeconds: 120 });

// ============================================================================================================ WEBHOOK HOOKS (called from paystackCallback)
export const handleLmmxCharge = (reference: string, data: { amount?: unknown }) => creditPayment(reference, Number(data?.amount));
export const handleLmmxTransfer = (event: string, data: unknown) => onTransferEvent(event, (data ?? {}) as never);

// ============================================================================================================ SCHEDULES
export const lmmx_dailySweep = onSchedule({ schedule: "0 10 * * *", timeZone: "Africa/Nairobi", region: "us-central1", timeoutSeconds: 540, memory: "512MiB", secrets: BUNDLE_SECRETS }, async () => { await dailySweep(); });
export const lmmx_settlementWorker = onSchedule({ schedule: "every 30 minutes", timeZone: "Africa/Nairobi", region: "us-central1", timeoutSeconds: 300, memory: "512MiB", secrets: BUNDLE_SECRETS }, async () => { await settlementWorker(); });
export const lmmx_reconcileDaily = onSchedule({ schedule: "0 23 * * *", timeZone: "Africa/Nairobi", region: "us-central1", timeoutSeconds: 300, memory: "512MiB", secrets: BUNDLE_SECRETS }, async () => { await reconcileDaily(); });
export const lmmx_auditAnchor = onSchedule({ schedule: "55 23 * * *", timeZone: "Africa/Nairobi", region: "us-central1", timeoutSeconds: 120, memory: "256MiB", secrets: BUNDLE_SECRETS }, async () => { await auditAnchor(); });
void loadRecipient; void normId; void validIdNumber; void audit; void LMMX_TOP_DESK; void ({} as ChangeDoc);
