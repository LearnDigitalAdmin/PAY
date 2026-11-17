import type { CallableRequest } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import { firstName } from "../lmm/dear";
import { LMM_SEAL_KEY } from "../lmm/seal";
import { sendOnce } from "../lmm/sms";
import { toMsisdn } from "../phone/safaricom";
import { COL, X } from "./config";
import {
  LMMX, LMMX_TOP_DESK, canonicalJson, kes as kesTxt, earningsTable, eatDate, firstDueDate, isValidCredit, lmmxText, maskId, maskName, maskPhone, normalizeKePhone, validIdNumber,
} from "./contract";
import type { DeskCreateTenantIn, DeskCreateTenantOut, DeskGetTenantOut, DeskListTenantsIn, DeskListTenantsOut, Frequency, TenantLinkOut, TenantSummaryOut, TenantStatus } from "./contract";
import { H, dec, enc, hmacHex, normName, randId, sha256, safeEq } from "./crypto";
import { fail } from "./errors";
import { audit, col, db, FV, now, rateOk, alert } from "./store";
import { issueOtp, otpState, verifyOtp } from "./otp";
import type { OtpVia } from "./otp";
import { createOrReuseRecipient, contactOf, recipientView } from "./recipients";
import { cycleView, holidays, loadCycles, newCycle, projections, remainingOf, suggestedCredit, targetCycle } from "./cycles";
import { upsertLead } from "./leads";
import type { DeskCtx, TenantCtx } from "./authz";
import type { ChangeDoc, PaymentDoc, PayRecordDoc, RecipientDoc, TenantDoc } from "./types";

export const normId = (v: string): string => v.toUpperCase().replace(/[^A-Z0-9]/g, "");
export const sms = (key: string, phoneE164: string, text: string): Promise<boolean> => sendOnce(key, toMsisdn(phoneE164), text);
/** What the tenant's code approves: exactly who is paid, how much, and when. Any change to these makes an old code useless. */
export const termsHashOf = (t: Pick<TenantDoc, "tenantId" | "dueDay" | "rent">, r: Pick<RecipientDoc, "recipientId" | "acctKey">, rentMinor = t.rent.amountMinor, dueDay = t.dueDay): string =>
  sha256(canonicalJson({ tenantId: t.tenantId, recipientId: r.recipientId, acctKey: r.acctKey, rentMinor, dueDay }));
export const termsSigOf = (termsHash: string): string => hmacHex(LMM_SEAL_KEY.value(), `terms|${termsHash}`);

const nameTokens = (full: string): string[] => {
  const out = new Set<string>();
  for (const w of normName(full).split(" ")) for (let n = 3; n <= Math.min(12, w.length); n++) out.add(w.slice(0, n));
  return [...out].slice(0, 40);
};
export const nameOf = (t: TenantDoc): string => dec(t.nameEnc);
export const phoneOf = (t: TenantDoc): string => dec(t.phoneEnc);
export const rowOf = (t: TenantDoc) => ({
  tenantId: t.tenantId, nameMasked: maskName(nameOf(t)), phoneMasked: maskPhone(phoneOf(t)), status: (t.frozen ? "frozen" : t.status) as TenantStatus, rentMinor: t.rent.amountMinor, dueDay: t.dueDay, deskCode: t.deskCode,
  creditedMinor: t.cur?.creditedMinor ?? 0, remainingMinor: t.cur?.remainingMinor ?? t.rent.amountMinor, createdAt: t.createdAt, ...(t.status === "awaiting_confirmation" ? { awaitingSince: t.createdAt } : {}),
});
export async function loadTenant(id: unknown): Promise<TenantDoc> {
  if (typeof id !== "string" || !/^LMT[0-9A-Z]{10}$/.test(id)) return fail("LMMX_E_NOT_FOUND", "Tenant not found.");
  const t = (await col(COL.tenants).doc(id).get()).data() as TenantDoc | undefined;
  return t ?? fail("LMMX_E_NOT_FOUND", "Tenant not found.");
}
/** A desk sees only its own tenants; COG-0000 sees all. The answer for "someone else's" is the same as for "does not exist". */
export async function ownedTenant(desk: DeskCtx, id: unknown): Promise<TenantDoc> {
  const t = await loadTenant(id);
  if (!desk.isTop && t.deskCode !== desk.deskCode) return fail("LMMX_E_NOT_FOUND", "Tenant not found.");
  return t;
}
export async function loadRecipient(id: string): Promise<RecipientDoc> {
  return ((await col(COL.recipients).doc(id).get()).data() as RecipientDoc | undefined) ?? fail("LMMX_E_NOT_FOUND", "Landlord account not found.");
}

// ------------------------------------------------------------------------------------------------------------- create
async function deskPayable(desk: DeskCtx): Promise<void> {
  if (desk.isTop) return;
  const acct = (await col("agents").doc(desk.uid).get()).data()?.paymentInfo as { accountId?: unknown } | undefined;
  if (typeof acct?.accountId !== "string" || !acct.accountId.startsWith("ACCT_")) fail("LMMX_E_DESK_NOT_READY", "Set up your payout account first, so you can be paid.");
}

export async function createTenant(desk: DeskCtx, i: DeskCreateTenantIn): Promise<DeskCreateTenantOut> {
  const p = i?.profile;
  if (!p || typeof i.idempotencyKey !== "string" || i.idempotencyKey.length < 8 || i.idempotencyKey.length > 64) return fail("LMMX_E_VALIDATION", "Something is missing. Please check the form.");
  const fullName = String(p.fullName ?? "").trim();
  const phone = normalizeKePhone(p.phone);
  if (fullName.length < 2 || fullName.length > 80 || !phone) return fail("LMMX_E_VALIDATION", "Enter the tenant's full name and a valid Kenyan phone.");
  if (!["national_id", "alien_id", "passport"].includes(p.idType) || !validIdNumber(p.idType, String(p.idNumber ?? ""))) return fail("LMMX_E_VALIDATION", "Enter a valid ID number.");
  const rent = i.rentMinor;
  if (!Number.isSafeInteger(rent) || rent % 100 !== 0 || rent < LMMX.RENT_MIN_MINOR || rent > LMMX.RENT_MAX_MINOR) return fail("LMMX_E_AMOUNT", "Rent must be whole shillings between KES 1,000 and KES 150,000.");
  const dueDay = i.dueDay === undefined ? LMMX.DUE_DAY_DEFAULT : Math.trunc(Number(i.dueDay));
  if (!(dueDay >= LMMX.DUE_DAY_MIN && dueDay <= LMMX.DUE_DAY_MAX)) return fail("LMMX_E_VALIDATION", "Due day must be from 1 to 28.");
  const frequency: Frequency = (["daily", "weekly", "biweekly"] as const).includes(i.frequency as Frequency) ? (i.frequency as Frequency) : "weekly";
  if (desk.phone && desk.phone === phone && !desk.isTop) return fail("LMMX_E_RECIPIENT_BLOCKED", "A desk cannot register itself as a tenant.");
  await deskPayable(desk);

  const idemRef = col(COL.locks).doc(`idem_${sha256(`${desk.uid}|${i.idempotencyKey}`).slice(0, 40)}`);
  const prior = (await idemRef.get()).data() as { tenantId?: string } | undefined;
  if (prior?.tenantId) {
    const t = await loadTenant(prior.tenantId);
    const r = await loadRecipient(t.activeRecipientId);
    return { tenantId: t.tenantId, status: t.status === "draft" ? "draft" : t.status === "active" ? "active" : "awaiting_confirmation", nameMatch: r.nameMatch, needsReview: !!t.needsReview, expiresAt: t.setupExpiresAt ?? 0, resolvedNameMasked: r.resolvedNameMasked };
  }
  if (!desk.isTop && !(await rateOk(`new|${desk.uid}`, LMMX.DESK_NEW_TENANTS_PER_DAY, 86_400_000))) return fail("LMMX_E_RATE", "You have reached today's limit for new tenants.");

  const phoneHash = H("phone", phone), idHash = H("id", normId(String(p.idNumber)));
  const rec = await createOrReuseRecipient(desk, phone, i.recipient);
  const needsReview = rec.status === "needs_review";
  if (rec.status !== "verified" && !needsReview) return fail("LMMX_E_RECIPIENT_BLOCKED", "This landlord account cannot be used.");
  const tenantId = randId("LMT");
  const t: TenantDoc = {
    tenantId, status: needsReview ? "draft" : "awaiting_confirmation", deskCode: desk.deskCode, deskUid: desk.uid, createdAt: now(), updatedAt: now(), rentSource: "lmm",
    nameEnc: enc(fullName), nameTokens: nameTokens(fullName), phoneEnc: enc(phone), phoneHash, idType: p.idType, idEnc: enc(normId(String(p.idNumber))), idHash,
    ...(p.email ? { email: String(p.email).slice(0, 120) } : {}), ...(p.unitNumber ? { unitNumber: String(p.unitNumber).slice(0, 40) } : {}), ...(p.propertyName ? { propertyName: String(p.propertyName).slice(0, 80) } : {}),
    rent: { amountMinor: rent }, dueDay, frequency, suggestedCreditMinor: suggestedCredit(rent, frequency), activeRecipientId: rec.recipientId, setupExpiresAt: now() + LMMX.SETUP_EXPIRY_MS,
    ...(needsReview ? { needsReview: true } : {}), cur: { creditedMinor: 0, remainingMinor: rent, dueDate: "" },
  };
  // one active tenant per phone and per ID, enforced by create-only lock documents in the same transaction as the tenant
  const lockP = col(COL.locks).doc(`phone_${phoneHash.slice(0, 40)}`), lockI = col(COL.locks).doc(`id_${idHash.slice(0, 40)}`);
  await db().runTransaction(async (tx) => {
    for (const l of [lockP, lockI]) {
      const d = (await tx.get(l)).data() as { tenantId?: string } | undefined;
      if (d?.tenantId) {
        const other = (await tx.get(col(COL.tenants).doc(d.tenantId))).data() as TenantDoc | undefined;
        if (other && other.status !== "closed" && other.status !== "migrated") fail("LMMX_E_DUPLICATE", "This tenant is already registered.");
      }
    }
    tx.set(lockP, { tenantId, at: now() }); tx.set(lockI, { tenantId, at: now() }); tx.set(idemRef, { tenantId, at: now() });
    tx.create(col(COL.tenants).doc(tenantId), JSON.parse(JSON.stringify(t)));
  });
  await audit({ action: "tenant_created", actor: { type: desk.isTop ? "top" : "desk", deskCode: desk.deskCode, uid: desk.uid, ip: desk.ip }, tenantId, summary: `tenant created, rent ${rent / 100}, recipient ${rec.recipientId}${needsReview ? " (needs review)" : ""}` });
  if (needsReview) return { tenantId, status: "draft", nameMatch: rec.nameMatch, needsReview: true, expiresAt: t.setupExpiresAt!, resolvedNameMasked: rec.resolvedNameMasked };
  // The top desk needs no tenant code: it is activated now, the same way a confirmed setup is. (The landlord account checks and the first-payout safety window still apply.)
  if (desk.isTop) {
    await activateTenant(t, rec, "top", desk);
    return { tenantId, status: "active", nameMatch: rec.nameMatch, needsReview: false, expiresAt: 0, resolvedNameMasked: rec.resolvedNameMasked };
  }
  try { await sendSetupOtp(t, rec); } catch (e) { await closeTenant(t, "setup sms failed"); throw e; }
  return { tenantId, status: "awaiting_confirmation", nameMatch: rec.nameMatch, needsReview: false, expiresAt: t.setupExpiresAt!, resolvedNameMasked: rec.resolvedNameMasked };
}

export async function sendSetupOtp(t: TenantDoc, r: RecipientDoc): Promise<{ expiresAt: number; resendsLeft: number }> {
  const hash = termsHashOf(t, r);
  const res = await issueOtp({
    tenantId: t.tenantId, purpose: "setup", payloadHash: hash, phoneE164: phoneOf(t),
    compose: (c4) => lmmxText.setup({ rentMinor: t.rent.amountMinor, landlordName: dec(r.resolvedNameEnc), channel: r.channel, acct: r.accountNumber, dueDay: t.dueDay, deskCode: t.deskCode, code4: c4 }),
  });
  await audit({ action: "setup_otp_sent", actor: { type: "system" }, tenantId: t.tenantId, summary: "setup code sent to the tenant" });
  return res;
}

export async function closeTenant(t: TenantDoc, why: string): Promise<void> {
  await col(COL.tenants).doc(t.tenantId).update({ status: "closed", updatedAt: now() });
  for (const l of [`phone_${t.phoneHash.slice(0, 40)}`, `id_${t.idHash.slice(0, 40)}`]) {
    const ref = col(COL.locks).doc(l); const d = (await ref.get()).data() as { tenantId?: string } | undefined; if (d?.tenantId === t.tenantId) await ref.delete();
  }
  await audit({ action: "setup_expired", actor: { type: "system" }, tenantId: t.tenantId, summary: `closed: ${why}` });
}

export async function setupStatus(desk: DeskCtx, tenantId: unknown) {
  const t = await ownedTenant(desk, tenantId);
  if (t.status === "awaiting_confirmation" && (t.setupExpiresAt ?? 0) < now()) { await closeTenant(t, "not confirmed in time"); return { tenantId: t.tenantId, status: "closed" as TenantStatus }; }
  const o = t.status === "awaiting_confirmation" ? await otpState(t.tenantId, "setup") : {};
  return { tenantId: t.tenantId, status: (t.frozen ? "frozen" : t.status) as TenantStatus, ...(o.expiresAt ? { otpExpiresAt: o.expiresAt } : {}), ...(o.attemptsLeft !== undefined ? { attemptsLeft: o.attemptsLeft } : {}),
    ...(o.locked ? { locked: true } : {}), ...(o.resendsLeft !== undefined ? { resendsLeft: o.resendsLeft } : {}), ...(t.needsReview ? { needsReview: true } : {}) };
}
export async function resendSetupOtp(desk: DeskCtx, tenantId: unknown) {
  const t = await ownedTenant(desk, tenantId);
  if (t.status !== "awaiting_confirmation" || t.needsReview) return fail("LMMX_E_STATE", "This setup is not waiting for a code.");
  if ((t.setupExpiresAt ?? 0) < now()) { await closeTenant(t, "not confirmed in time"); return fail("LMMX_E_OTP_EXPIRED", "This setup expired. Please register the tenant again."); }
  const r = await loadRecipient(t.activeRecipientId);
  const res = await sendSetupOtp(t, r);
  return { otpExpiresAt: res.expiresAt, resendsLeft: res.resendsLeft };
}

// ------------------------------------------------------------------------------------------------------------- confirm / activate
/** Confirms the setup with the tenant's code, from the desk, the bot or the tenant, then activates everything in one transaction. */
export async function confirmSetup(p: { tenantId: string; otp: string; via: OtpVia; desk?: DeskCtx }): Promise<void> {
  const t = await loadTenant(p.tenantId);
  if (t.status !== "awaiting_confirmation") return fail("LMMX_E_STATE", t.status === "active" ? "This tenant is already set up." : "This setup is not waiting for a code.");
  if (t.needsReview) return fail("LMMX_E_REVIEW_REQUIRED", "The top desk must approve this landlord account first.");
  if ((t.setupExpiresAt ?? 0) < now()) { await closeTenant(t, "not confirmed in time"); return fail("LMMX_E_OTP_EXPIRED", "This setup expired. Please register the tenant again."); }
  const r = await loadRecipient(t.activeRecipientId);
  if (r.status !== "verified") return fail("LMMX_E_REVIEW_REQUIRED", "The top desk must approve this landlord account first.");
  const hash = termsHashOf(t, r);
  await verifyOtp({ tenantId: t.tenantId, purpose: "setup", input: p.otp, expectedPayloadHash: hash, via: p.via, actorDesk: p.desk?.deskCode });
  await activateTenant(t, r, p.via, p.desk);
}

/** Everything that happens when a setup is confirmed: status active, sealed pay record, first cycle, consent, lead, and the two welcome SMS.
 *  The tenant's code is checked BEFORE this (confirmSetup). COG-0000 skips the code entirely and calls this with via "top". */
export async function activateTenant(t: TenantDoc, r: RecipientDoc, via: OtpVia | "top", desk?: DeskCtx): Promise<void> {
  const hash = termsHashOf(t, r);
  const hol = await holidays();
  const due = firstDueDate(eatDate(now()), t.dueDay);
  const cycle = newCycle(t, due, t.rent.amountMinor, hol);
  const rec: PayRecordDoc = {
    tenantId: t.tenantId, recipientId: r.recipientId, channel: r.channel, accountNumber: r.accountNumber, rentMinor: t.rent.amountMinor, dueDay: t.dueDay, frequency: t.frequency, setupCompletedAt: now(),
    setupDeskCode: t.deskCode, setupOtpVia: via, termsHash: hash, termsSig: termsSigOf(hash), version: 1,
  };
  await db().runTransaction(async (tx) => {
    const tref = col(COL.tenants).doc(t.tenantId), rref = col(COL.recipients).doc(r.recipientId);
    const [ts, rs] = await Promise.all([tx.get(tref), tx.get(rref)]);
    if ((ts.data() as TenantDoc).status !== "awaiting_confirmation" || (rs.data() as RecipientDoc).status !== "verified") fail("LMMX_E_STATE", "This setup changed. Please start again.");
    tx.update(tref, { status: "active", consentAt: now(), updatedAt: now(), setupExpiresAt: FV.delete(), landlordNoticeAt: now(), cur: { creditedMinor: 0, remainingMinor: cycle.rentMinor, dueDate: due } });
    tx.update(rref, { activeTenantCount: FV.increment(1), deskCodes: FV.arrayUnion(t.deskCode) });
    tx.set(col(COL.payRecords).doc(t.tenantId), rec);
    tx.create(col(COL.cycles).doc(cycle.cycleId), cycle);
  });
  await audit({ action: "setup_confirmed", actor: { type: via === "desk" ? "desk" : via === "bot" ? "bot" : via === "top" ? "top" : "tenant", deskCode: desk?.deskCode, uid: desk?.uid }, tenantId: t.tenantId, summary: `setup confirmed via ${via}${via === "top" ? " (no code needed)" : ""}; first due ${due}` });
  await upsertLead(r, t).catch((e) => console.error("LMMX lead upsert failed", (e as Error).message));
  const c = contactOf(r);
  await sms(`lmmx_active_${t.tenantId}`, phoneOf(t), lmmxText.active({ rentMinor: t.rent.amountMinor, dueDay: t.dueDay, supportPhone: X.SUPPORT_PHONE }));
  await sms(`lmmx_landlord_${t.tenantId}`, c.phone, lmmxText.landlord({ tenantFirstName: firstName(nameOf(t)) || "A tenant", rentMinor: t.rent.amountMinor, dueDay: t.dueDay, supportPhone: X.SUPPORT_PHONE }));
}

// ------------------------------------------------------------------------------------------------------------- list / get
export async function listTenants(desk: DeskCtx, i: DeskListTenantsIn): Promise<DeskListTenantsOut> {
  const limit = Math.min(50, Math.max(1, Math.trunc(Number(i?.limit ?? 25))));
  let q: admin.firestore.Query = col(COL.tenants);
  if (!desk.isTop) q = q.where("deskCode", "==", desk.deskCode);
  if (i?.status) q = q.where("status", "==", i.status);
  const term = String(i?.q ?? "").trim();
  if (term) {
    const phone = normalizeKePhone(term), digits = term.replace(/\D/g, "");
    if (/^LMT[0-9A-Z]{10}$/i.test(term)) { const t = (await col(COL.tenants).doc(term.toUpperCase()).get()).data() as TenantDoc | undefined; return { tenants: t && (desk.isTop || t.deskCode === desk.deskCode) ? [rowOf(t)] : [] }; }
    if (phone) q = q.where("phoneHash", "==", H("phone", phone));
    else if (/^[A-Za-z0-9]{6,9}$/.test(term) && /\d/.test(term) && digits.length >= 6) q = q.where("idHash", "==", H("id", normId(term)));
    else q = q.where("nameTokens", "array-contains", normName(term).split(" ")[0].slice(0, 12));
    const snap = await q.limit(100).get();
    const rows = snap.docs.map((d) => d.data() as TenantDoc).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit).map(rowOf);
    return { tenants: rows };
  }
  q = q.orderBy("createdAt", "desc");
  if (i?.cursor && /^\d+$/.test(i.cursor)) q = q.startAfter(Number(i.cursor));
  const snap = await q.limit(limit + 1).get();
  const docs = snap.docs.slice(0, limit).map((d) => d.data() as TenantDoc);
  return { tenants: docs.map(rowOf), ...(snap.docs.length > limit ? { nextCursor: String(docs[docs.length - 1].createdAt) } : {}) };
}

export const instalmentView = (p: PaymentDoc, withDesk: boolean) => ({
  paymentId: p.paymentId, at: p.creditedAt ?? p.createdAt, creditMinor: p.creditMinor, chargeMinor: p.chargeMinor, feesMinor: p.feesMinor, status: (p.status === "credited" ? "success" : "failed") as "success" | "failed",
  ...(withDesk ? { deskShareMinor: p.deskShareMinor } : {}),
});
export async function recentPayments(tenantId: string, withDesk: boolean, n = 10) {
  const q = await col(COL.payments).where("tenantId", "==", tenantId).where("status", "==", "credited").orderBy("createdAt", "desc").limit(n).get();
  return q.docs.map((d) => instalmentView(d.data() as PaymentDoc, withDesk));
}
export async function pendingChangeView(tenantId: string) {
  const q = await col(COL.changes).where("tenantId", "==", tenantId).where("status", "in", ["awaiting_tenant_otp", "cooling_off", "deferred"]).get();
  const c = q.docs.map((d) => d.data() as ChangeDoc).sort((a, b) => b.createdAt - a.createdAt)[0];
  return c ? { changeId: c.changeId, kind: c.kind, status: c.status, summary: c.summary, initiatedBy: c.initiatedBy, ...(c.coolingOffUntil ? { coolingOffUntil: c.coolingOffUntil } : {}), ...(c.applyAfter ? { applyAfter: c.applyAfter } : {}) } : undefined;
}

export async function getTenantView(desk: DeskCtx, id: unknown): Promise<DeskGetTenantOut> {
  const t = await ownedTenant(desk, id);
  const r = await loadRecipient(t.activeRecipientId);
  const open = await loadCycles(t.tenantId);
  const cur = open.find((c) => remainingOf(c) > 0) ?? open[0];
  const pend = await pendingChangeView(t.tenantId);
  return {
    tenantId: t.tenantId, status: (t.frozen ? "frozen" : t.status) as TenantStatus, deskCode: t.deskCode, nameMasked: maskName(nameOf(t)), phoneMasked: maskPhone(phoneOf(t)), idMasked: maskId(dec(t.idEnc)),
    ...(t.unitNumber ? { unitNumber: t.unitNumber } : {}), ...(t.propertyName ? { propertyName: t.propertyName } : {}), rentMinor: t.rent.amountMinor, dueDay: t.dueDay, frequency: t.frequency,
    recipient: recipientView(r), ...(cur ? { cycle: cycleView(cur) } : {}), recent: await recentPayments(t.tenantId, t.deskCode !== LMMX_TOP_DESK),
    earningsTable: earningsTable(t.rent.amountMinor, r.channel),
    projection: { frequency: t.frequency, ...projections(t.rent.amountMinor, r.channel)[t.frequency] },
    ...(pend ? { pendingChange: pend } : {}), ...(t.frozen ? { frozen: true } : {}), createdAt: t.createdAt,
  };
}

// ------------------------------------------------------------------------------------------------------------- tenant side
/** The signed-in, phone-verified person says their ID. Matches only when the verified phone AND the ID are on the same standalone tenant. */
export async function tenantLink(req: CallableRequest<unknown>, phone: string, input: { idType: string; idNumber: string }, ip: string): Promise<TenantLinkOut> {
  const uid = req.auth!.uid;
  if (!(await rateOk(`link|${uid}`, X.RATE.linkPer10Min, 600_000)) || !(await rateOk(`linkp|${phone}`, X.RATE.linkPer10Min, 600_000)) || !(await rateOk(`linki|${ip}`, 20, 600_000))) return fail("LMMX_E_RATE", "Too many tries. Please wait a few minutes.");
  const generic = (): never => fail("LMMX_E_NOT_FOUND", "We could not match those details.");
  if (!["national_id", "alien_id", "passport"].includes(input.idType) || !validIdNumber(input.idType as "national_id", String(input.idNumber ?? ""))) return generic();
  const kinds: ("lmm" | "legacy")[] = [];
  const q = await col(COL.tenants).where("phoneHash", "==", H("phone", phone)).limit(5).get();
  const mine = q.docs.map((d) => d.data() as TenantDoc).find((t) => t.status !== "closed" && t.status !== "migrated" && safeEq(t.idHash, H("id", normId(String(input.idNumber)))));
  if (mine) {
    if (mine.authUid && mine.authUid !== uid) return generic();
    if (mine.authUid !== uid) await col(COL.tenants).doc(mine.tenantId).update({ authUid: uid, updatedAt: now() });
    const prof = col("tenants").doc(uid);
    if (!(await prof.get()).exists) await prof.create({ id: uid, role: "tenant", phone, name: nameOf(mine), createdAt: now(), source: "lmmx" });
    kinds.push("lmm");
    await audit({ action: "tenant_link", actor: { type: "tenant", uid, ip }, tenantId: mine.tenantId, summary: "tenant linked their sign-in" });
  }
  if (!kinds.includes("lmm") && (await col("tenants").doc(uid).get()).exists) kinds.push("legacy");
  if (!kinds.length) return generic();
  return { kinds };
}

export async function tenantSummary(c: TenantCtx): Promise<TenantSummaryOut> {
  const t = c.tenant, r = await loadRecipient(t.activeRecipientId);
  const open = await loadCycles(t.tenantId);
  const cur = open.find((x) => remainingOf(x) > 0) ?? open[0];
  const pend = await pendingChangeView(t.tenantId);
  const o = t.status === "awaiting_confirmation" ? await otpState(t.tenantId, "setup") : {};
  return {
    ...(t.status === "awaiting_confirmation" && o.expiresAt ? { awaitingSetup: { otpExpiresAt: o.expiresAt, summary: `Rent ${kesTxt(t.rent.amountMinor)} to ${r.resolvedNameMasked} (${r.channel} ...${r.accountNumber.slice(-3)}), due day ${t.dueDay}` } } : {}),
    status: (t.frozen ? "frozen" : t.status) as TenantStatus, firstName: firstName(nameOf(t)), rentMinor: t.rent.amountMinor, dueDay: t.dueDay, frequency: t.frequency,
    ...(cur ? { cycle: cycleView(cur) } : {}), recipient: recipientView(r), suggestedCreditMinor: isValidCredit(t.suggestedCreditMinor) ? t.suggestedCreditMinor : suggestedCredit(t.rent.amountMinor, t.frequency),
    ...(pend ? { pendingChange: pend } : {}), ...(t.frozen ? { frozen: true } : {}), supportPhone: X.SUPPORT_PHONE,
  };
}
void targetCycle; void alert; void admin;
