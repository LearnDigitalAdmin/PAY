// Changes after setup. Payout account and rent: the TENANT's code, or a change started by COG-0000. A regular desk's payout change then waits out a
// cooling-off (old account stays live), is deferred past a nearby due date, and can be cancelled by the tenant with an LMC code.
import { LMM_SEAL_KEY } from "../lmm/seal";
import { firstName } from "../lmm/dear";
import { COL, X } from "./config";
import { LMMX, LMMX_BRAND, channelLabel, daysUntil, eatDate, fitSms, kes, lmmxText, nextDueDate, isValidCredit, shortDate } from "./contract";
import type { DeskConfirmChangeOut, DeskRequestChangeIn, DeskRequestChangeOut, Frequency, RecipientInput, TopUpdateTenantIn } from "./contract";
import { decJson, encJson, randId, sha256, hmacHex } from "./crypto";
import { fail } from "./errors";
import { audit, col, db, FV, now, rateOk } from "./store";
import { issueOtp, verifyOtp } from "./otp";
import type { OtpVia } from "./otp";
import { createOrReuseRecipient, contactOf } from "./recipients";
import { loadCycles, remainingOf } from "./cycles";
import { loadRecipient, nameOf, ownedTenant, phoneOf, sms, termsHashOf, termsSigOf, loadTenant } from "./tenants";
import type { DeskCtx } from "./authz";
import type { ChangeDoc, CycleDoc, PayRecordDoc, RecipientDoc, TenantDoc } from "./types";

const ACTIVE = ["awaiting_tenant_otp", "cooling_off", "deferred"] as const;
const sumLine = (r: RecipientDoc): string => `landlord account to ${channelLabel(r.channel)} ...${r.accountNumber.slice(-3)}`;

async function pendingOf(tenantId: string): Promise<ChangeDoc | undefined> {
  const q = await col(COL.changes).where("tenantId", "==", tenantId).where("status", "in", [...ACTIVE]).get();
  return q.docs.map((d) => d.data() as ChangeDoc)[0];
}
const checkRent = (rent: unknown): number => {
  if (typeof rent !== "number" || !Number.isSafeInteger(rent) || rent % 100 !== 0 || rent < LMMX.RENT_MIN_MINOR || rent > LMMX.RENT_MAX_MINOR) return fail("LMMX_E_AMOUNT", "Rent must be whole shillings between KES 1,000 and KES 150,000.");
  return rent;
};
async function inflight(tenantId: string): Promise<boolean> { return (await loadCycles(tenantId)).some((c) => c.inflightMinor > 0); }

// ------------------------------------------------------------------------------------------------------------- request (regular desk)
export async function requestChange(desk: DeskCtx, i: DeskRequestChangeIn): Promise<DeskRequestChangeOut> {
  if (desk.isTop) return fail("LMMX_E_VALIDATION", "The top desk changes tenants with the top-desk update (it needs a reason).");
  if (typeof i?.idempotencyKey !== "string" || i.idempotencyKey.length < 8 || i.idempotencyKey.length > 64) return fail("LMMX_E_VALIDATION", "Something is missing. Please try again.");
  const t = await ownedTenant(desk, i.tenantId);
  if (t.frozen) return fail("LMMX_E_FROZEN", "This tenant is on hold.");
  if (t.status !== "active" && t.status !== "paused") return fail("LMMX_E_STATE", "This tenant is not active.");
  if (!(await rateOk(`chg|${desk.uid}`, X.RATE.changePerDay, 86_400_000))) return fail("LMMX_E_RATE", "Too many change requests today.");
  const idem = col(COL.locks).doc(`idem_${sha256(`${desk.uid}|chg|${i.idempotencyKey}`).slice(0, 40)}`);
  const prior = (await idem.get()).data() as { changeId?: string } | undefined;
  if (prior?.changeId) { const c = (await col(COL.changes).doc(prior.changeId).get()).data() as ChangeDoc; return { changeId: c.changeId, status: c.status, requiresTenantOtp: true }; }
  if (await pendingOf(t.tenantId)) return fail("LMMX_E_STATE", "There is already a change waiting for this tenant.");
  const cur = await loadRecipient(t.activeRecipientId);

  let payload: Record<string, unknown>, summary: string, hash: string, newRecipientId: string | undefined;
  if (i.kind === "rent") {
    const rent = checkRent(i.rentMinor);
    if (rent === t.rent.amountMinor) return fail("LMMX_E_VALIDATION", "That is the current rent.");
    payload = { rentMinor: rent }; summary = `rent to ${kes(rent)}`; hash = termsHashOf(t, cur, rent);
  } else if (i.kind === "recipient" && i.recipient) {
    const nr = await createOrReuseRecipient(desk, phoneOf(t), i.recipient as RecipientInput);
    if (nr.status !== "verified") return fail("LMMX_E_REVIEW_REQUIRED", "The top desk must approve this landlord account first.");
    if (nr.recipientId === cur.recipientId) return fail("LMMX_E_VALIDATION", "That is already the landlord's account.");
    payload = { recipientId: nr.recipientId }; summary = sumLine(nr); hash = termsHashOf(t, nr); newRecipientId = nr.recipientId;
  } else return fail("LMMX_E_VALIDATION", "Choose what to change.");

  const changeId = randId("CHG");
  const c: ChangeDoc = { changeId, tenantId: t.tenantId, kind: i.kind, status: "awaiting_tenant_otp", initiatedBy: "desk", deskCode: desk.deskCode, deskUid: desk.uid, payloadEnc: encJson(payload), payloadHash: hash, summary, createdAt: now(), ...(newRecipientId ? { newRecipientId } : {}) };
  await col(COL.changes).doc(changeId).create(JSON.parse(JSON.stringify(c)));
  await idem.set({ changeId, at: now() });
  let res;
  try { res = await issueOtp({ tenantId: t.tenantId, purpose: "change", changeId, payloadHash: hash, phoneE164: phoneOf(t), compose: (c4) => lmmxText.change({ deskCode: desk.deskCode, summary, code4: c4 }) }); }
  catch (e) { await col(COL.changes).doc(changeId).update({ status: "cancelled" }); throw e; }
  await audit({ action: "change_requested", actor: { type: "desk", deskCode: desk.deskCode, uid: desk.uid, ip: desk.ip }, tenantId: t.tenantId, summary: `${i.kind} change requested: ${summary}` });
  return { changeId, status: "awaiting_tenant_otp", requiresTenantOtp: true, otpExpiresAt: res.expiresAt };
}

async function currentHash(c: ChangeDoc, t: TenantDoc): Promise<string> {
  const p = decJson<{ rentMinor?: number; recipientId?: string }>(c.payloadEnc);
  if (c.kind === "rent") return termsHashOf(t, await loadRecipient(t.activeRecipientId), p.rentMinor);
  return termsHashOf(t, await loadRecipient(String(p.recipientId)));
}

// ------------------------------------------------------------------------------------------------------------- confirm (desk, bot or tenant)
export async function confirmChange(p: { changeId: string; otp: string; via: OtpVia; desk?: DeskCtx; tenantId?: string }): Promise<DeskConfirmChangeOut> {
  const c = (await col(COL.changes).doc(String(p.changeId)).get()).data() as ChangeDoc | undefined;
  if (!c || (p.tenantId && c.tenantId !== p.tenantId) || (p.desk && !p.desk.isTop && c.deskCode !== p.desk.deskCode)) return fail("LMMX_E_NOT_FOUND", "Change not found.");
  if (c.status !== "awaiting_tenant_otp") return fail("LMMX_E_STATE", "This change is not waiting for a code.");
  const t = await loadTenant(c.tenantId);
  if (t.frozen) return fail("LMMX_E_FROZEN", "This tenant is on hold.");
  await verifyOtp({ tenantId: t.tenantId, purpose: "change", changeId: c.changeId, input: p.otp, expectedPayloadHash: await currentHash(c, t), via: p.via, actorDesk: p.desk?.deskCode });
  const pl = decJson<{ rentMinor?: number; recipientId?: string }>(c.payloadEnc);
  if (c.kind === "rent") {
    await applyRent(t.tenantId, pl.rentMinor!);
    await col(COL.changes).doc(c.changeId).update({ status: "applied", appliedAt: now(), confirmedAt: now() });
    await audit({ action: "change_applied", actor: { type: p.via === "tenant" ? "tenant" : "desk", deskCode: p.desk?.deskCode }, tenantId: t.tenantId, summary: `rent changed to ${pl.rentMinor! / 100}` });
    return { changeId: c.changeId, status: "applied" };
  }
  // payout account: cooling-off, deferred past a nearby due date
  const open = await loadCycles(t.tenantId);
  const near = open.find((x) => remainingOf(x) >= 0 && x.settledMinor < x.rentMinor && daysUntil(x.dueDate, eatDate(now())) <= LMMX.CHANGE_DEFER_DAYS_BEFORE_DUE && x.creditedMinor > 0);
  const cooling = now() + LMMX.CHANGE_COOLING_OFF_MS;
  const afterDue = near ? Date.parse(`${near.dueDate}T00:00:00Z`) + 36 * 3_600_000 : 0;
  const applyAfter = Math.max(cooling, afterDue);
  const status = afterDue > cooling ? "deferred" : "cooling_off";
  await col(COL.changes).doc(c.changeId).update({ status, coolingOffUntil: cooling, applyAfter, confirmedAt: now() });
  await col(COL.tenants).doc(t.tenantId).update({ pendingRecipientId: pl.recipientId, updatedAt: now() });
  const cancelPayload = sha256(`cancel|${c.payloadHash}`);
  await issueOtp({ tenantId: t.tenantId, purpose: "cancel", changeId: c.changeId, payloadHash: cancelPayload, phoneE164: phoneOf(t), compose: (c4) => lmmxText.changeConfirmed({ applyDate: eatDate(applyAfter), cancel4: c4 }) });
  const oldR = await loadRecipient(t.activeRecipientId), newR = await loadRecipient(String(pl.recipientId));
  const who = firstName(nameOf(t)) || "A tenant";
  await sms(`lmmx_chg_old_${c.changeId}`, contactOf(oldR).phone, lmmxText.landlordChange({ tenantFirstName: who, applyDate: eatDate(applyAfter), supportPhone: X.SUPPORT_PHONE, kind: "old", rentMinor: t.rent.amountMinor, dueDay: t.dueDay }));
  await sms(`lmmx_chg_new_${c.changeId}`, contactOf(newR).phone, lmmxText.landlordChange({ tenantFirstName: who, applyDate: eatDate(applyAfter), supportPhone: X.SUPPORT_PHONE, kind: "new", rentMinor: t.rent.amountMinor, dueDay: t.dueDay }));
  await audit({ action: "change_confirmed", actor: { type: p.via === "tenant" ? "tenant" : p.via === "bot" ? "bot" : "desk", deskCode: p.desk?.deskCode }, tenantId: t.tenantId, summary: `payout change confirmed; applies after ${eatDate(applyAfter)} (${status})` });
  return { changeId: c.changeId, status, applyAfter };
}

export async function cancelChangeByDesk(desk: DeskCtx, changeId: unknown): Promise<void> {
  const c = (await col(COL.changes).doc(String(changeId)).get()).data() as ChangeDoc | undefined;
  if (!c || (!desk.isTop && c.deskCode !== desk.deskCode)) return fail("LMMX_E_NOT_FOUND", "Change not found.");
  if (!(ACTIVE as readonly string[]).includes(c.status)) return fail("LMMX_E_STATE", "This change can no longer be cancelled.");
  await cancelNow(c, desk.deskCode, "desk");
}
export async function cancelChangeByCode(p: { changeId: string; code: string; via: OtpVia; tenantId?: string }): Promise<void> {
  const c = (await col(COL.changes).doc(String(p.changeId)).get()).data() as ChangeDoc | undefined;
  if (!c || (p.tenantId && c.tenantId !== p.tenantId)) return fail("LMMX_E_NOT_FOUND", "Change not found.");
  if (c.status !== "cooling_off" && c.status !== "deferred" && c.status !== "awaiting_tenant_otp") return fail("LMMX_E_STATE", "This change can no longer be cancelled.");
  await verifyOtp({ tenantId: c.tenantId, purpose: "cancel", changeId: c.changeId, input: p.code, expectedPayloadHash: sha256(`cancel|${c.payloadHash}`), via: p.via });
  await cancelNow(c, undefined, p.via === "tenant" ? "tenant" : "bot");
}
async function cancelNow(c: ChangeDoc, deskCode: string | undefined, who: "desk" | "tenant" | "bot"): Promise<void> {
  await col(COL.changes).doc(c.changeId).update({ status: "cancelled" });
  await col(COL.tenants).doc(c.tenantId).update({ pendingRecipientId: FV.delete(), updatedAt: now() });
  await audit({ action: "change_cancelled", actor: { type: who, deskCode }, tenantId: c.tenantId, summary: `${c.kind} change cancelled by ${who}` });
}

// ------------------------------------------------------------------------------------------------------------- apply
async function rewritePayRecord(tx: import("./store").Tx, t: TenantDoc, r: RecipientDoc, rentMinor: number, dueDay: number): Promise<void> {
  const hash = termsHashOf({ tenantId: t.tenantId, dueDay, rent: { amountMinor: rentMinor } }, r, rentMinor, dueDay);
  const ref = col(COL.payRecords).doc(t.tenantId);
  const prev = (await tx.get(ref)).data() as PayRecordDoc | undefined;
  tx.set(ref, { ...(prev ?? {}), tenantId: t.tenantId, recipientId: r.recipientId, channel: r.channel, accountNumber: r.accountNumber, rentMinor, dueDay, frequency: t.frequency, termsHash: hash, termsSig: termsSigOf(hash), version: (prev?.version ?? 0) + 1, setupDeskCode: prev?.setupDeskCode ?? t.deskCode, setupCompletedAt: prev?.setupCompletedAt ?? now(), setupOtpVia: prev?.setupOtpVia ?? "desk" });
}

/** From the next cycle; right away only for a cycle with nothing credited yet. */
export async function applyRent(tenantId: string, rentMinor: number): Promise<void> {
  await db().runTransaction(async (tx) => {
    const tref = col(COL.tenants).doc(tenantId);
    const t = (await tx.get(tref)).data() as TenantDoc;
    const r = (await tx.get(col(COL.recipients).doc(t.activeRecipientId))).data() as RecipientDoc;
    const cyc = await tx.get(col(COL.cycles).where("tenantId", "==", tenantId).where("status", "==", "open"));
    for (const d of cyc.docs) { const c = d.data() as CycleDoc; if (c.creditedMinor === 0 && c.settledMinor === 0 && c.inflightMinor === 0) tx.update(d.ref, { rentMinor, legRentMinor: rentMinor }); }
    tx.update(tref, { rent: { amountMinor: rentMinor }, suggestedCreditMinor: Math.min(rentMinor, isValidCredit(t.suggestedCreditMinor) ? t.suggestedCreditMinor : rentMinor), updatedAt: now() });
    await rewritePayRecord(tx, { ...t }, r, rentMinor, t.dueDay);
  });
}
export async function applyRecipient(tenantId: string, newRecipientId: string, confirmedAt: number): Promise<void> {
  if (await inflight(tenantId)) return fail("LMMX_E_STATE", "A payout is on its way. Try again in a few minutes.");
  await db().runTransaction(async (tx) => {
    const tref = col(COL.tenants).doc(tenantId);
    const t = (await tx.get(tref)).data() as TenantDoc;
    const nref = col(COL.recipients).doc(newRecipientId), oref = col(COL.recipients).doc(t.activeRecipientId);
    const nr = (await tx.get(nref)).data() as RecipientDoc;
    if (!nr || nr.status !== "verified") fail("LMMX_E_RECIPIENT_BLOCKED", "The new landlord account cannot be used.");
    tx.update(oref, { activeTenantCount: FV.increment(-1) });
    tx.update(nref, { activeTenantCount: FV.increment(1), deskCodes: FV.arrayUnion(t.deskCode) });
    tx.update(tref, { activeRecipientId: newRecipientId, pendingRecipientId: FV.delete(), landlordNoticeAt: confirmedAt, updatedAt: now() });
    await rewritePayRecord(tx, t, nr, t.rent.amountMinor, t.dueDay);
  });
}
/** The sweep applies every confirmed payout change whose cooling-off (and deferral) is over. */
export async function applyDueChanges(): Promise<number> {
  let n = 0;
  const q = await col(COL.changes).where("status", "in", ["cooling_off", "deferred"]).get();
  for (const d of q.docs) {
    const c = d.data() as ChangeDoc;
    if ((c.applyAfter ?? Infinity) > now()) continue;
    try {
      const pl = decJson<{ recipientId: string }>(c.payloadEnc);
      await applyRecipient(c.tenantId, pl.recipientId, c.confirmedAt ?? now());
      await d.ref.update({ status: "applied", appliedAt: now() });
      await audit({ action: "change_applied", actor: { type: "system" }, tenantId: c.tenantId, summary: `payout account changed to ${pl.recipientId}` });
      n++;
    } catch (e) { console.warn("LMMX apply change deferred:", c.changeId, (e as Error).message); }
  }
  return n;
}
/** Awaiting-code changes that were never confirmed expire after the code's life. */
export async function expireChanges(): Promise<void> {
  const q = await col(COL.changes).where("status", "==", "awaiting_tenant_otp").get();
  for (const d of q.docs) { const c = d.data() as ChangeDoc; if (now() - c.createdAt > LMMX.OTP_TTL_MS + 60_000) await d.ref.update({ status: "expired" }); }
}

// ------------------------------------------------------------------------------------------------------------- COG-0000: immediate
export async function topUpdate(desk: DeskCtx & { reason: string }, i: TopUpdateTenantIn): Promise<void> {
  const t = await loadTenant(i.tenantId);
  if (i.rentMinor === undefined && !i.recipient && i.dueDay === undefined) return fail("LMMX_E_VALIDATION", "Choose what to change.");
  const notes: string[] = [];
  let oldR: RecipientDoc | undefined, newR: RecipientDoc | undefined;
  if (i.recipient) {
    if (await inflight(t.tenantId)) return fail("LMMX_E_STATE", "A payout is on its way. Try again in a few minutes.");
    newR = await createOrReuseRecipient(desk, phoneOf(t), i.recipient);
    if (newR.status !== "verified") return fail("LMMX_E_REVIEW_REQUIRED", "Approve this landlord account in the review queue first.");
    oldR = await loadRecipient(t.activeRecipientId);
    if (newR.recipientId === oldR.recipientId) return fail("LMMX_E_VALIDATION", "That is already the landlord's account.");
  }
  if (i.rentMinor !== undefined) { const rent = checkRent(i.rentMinor); await applyRent(t.tenantId, rent); notes.push(`rent ${kes(rent)}`); }
  if (i.dueDay !== undefined) {
    const dd = Math.trunc(Number(i.dueDay)); if (!(dd >= LMMX.DUE_DAY_MIN && dd <= LMMX.DUE_DAY_MAX)) return fail("LMMX_E_VALIDATION", "Due day must be from 1 to 28.");
    await applyDueDay(t.tenantId, dd); notes.push(`due day ${dd}`);
  }
  if (newR && oldR) {
    await applyRecipient(t.tenantId, newR.recipientId, now() - LMMX.LANDLORD_NOTICE_MIN_BEFORE_PAYOUT_MS);   // top-desk changes are immediate; the payout still waits for the landlord notice below
    notes.push(sumLine(newR));
    await col(COL.tenants).doc(t.tenantId).update({ landlordNoticeAt: now() });
    const who = firstName(nameOf(t)) || "A tenant";
    await sms(`lmmx_top_old_${t.tenantId}_${newR.recipientId}`, contactOf(oldR).phone, lmmxText.landlordChange({ tenantFirstName: who, applyDate: eatDate(now()), supportPhone: X.SUPPORT_PHONE, kind: "old", rentMinor: t.rent.amountMinor, dueDay: t.dueDay }));
    await sms(`lmmx_top_new_${t.tenantId}_${newR.recipientId}`, contactOf(newR).phone, lmmxText.landlordChange({ tenantFirstName: who, applyDate: eatDate(now()), supportPhone: X.SUPPORT_PHONE, kind: "new", rentMinor: t.rent.amountMinor, dueDay: t.dueDay }));
  }
  await sms(`lmmx_top_t_${t.tenantId}_${now()}`, phoneOf(t), fitSms(`${LMMX_BRAND}: Samuhia support updated your ${notes.join(", ")}. Not expected? Call ${X.SUPPORT_PHONE}.`));
  await audit({ action: "top_update", actor: { type: "top", deskCode: desk.deskCode, uid: desk.uid, ip: desk.ip }, tenantId: t.tenantId, summary: `top update: ${notes.join("; ")} | reason: ${desk.reason.slice(0, 120)}` });
}

// ------------------------------------------------------------------------------------------------------------- tenant self-service
export async function applyDueDay(tenantId: string, dueDay: number): Promise<void> {
  await db().runTransaction(async (tx) => {
    const tref = col(COL.tenants).doc(tenantId);
    const t = (await tx.get(tref)).data() as TenantDoc;
    const r = (await tx.get(col(COL.recipients).doc(t.activeRecipientId))).data() as RecipientDoc;
    tx.update(tref, { dueDay, updatedAt: now() });
    await rewritePayRecord(tx, t, r, t.rent.amountMinor, dueDay);
  });
}
/** The tenant picks the day their landlord is paid: once per cycle, not within 5 days of the current due date, applies from the next cycle. */
export async function setDueDay(t: TenantDoc, dueDay: unknown): Promise<{ dueDay: number; effectiveFromCycleDate: string }> {
  const d = typeof dueDay === "number" ? Math.trunc(dueDay) : NaN;
  if (!(d >= LMMX.DUE_DAY_MIN && d <= LMMX.DUE_DAY_MAX)) return fail("LMMX_E_VALIDATION", "Choose a day from 1 to 28.");
  if (t.frozen || (t.status !== "active" && t.status !== "paused")) return fail("LMMX_E_STATE", "You cannot change this right now.");
  const open = await loadCycles(t.tenantId);
  const cur = open.find((c) => remainingOf(c) > 0) ?? open[0];
  const today = eatDate(now());
  if (cur) {
    if (t.dueDayChangedCycleId === cur.cycleId) return fail("LMMX_E_STATE", "You already changed your day this month.");
    if (daysUntil(cur.dueDate, today) < LMMX.DUE_DAY_LOCK_DAYS_BEFORE_DUE) return fail("LMMX_E_STATE", "It is too close to your due date to change it. Try again after it passes.");
  }
  await applyDueDay(t.tenantId, d);
  await col(COL.tenants).doc(t.tenantId).update({ dueDayChangedCycleId: cur?.cycleId ?? "none" });
  await audit({ action: "due_day_changed", actor: { type: "tenant" }, tenantId: t.tenantId, summary: `due day ${t.dueDay} -> ${d}` });
  return { dueDay: d, effectiveFromCycleDate: nextDueDate(cur?.dueDate ?? today, d, 1) };
}
export async function setPlan(t: TenantDoc, frequency: Frequency, suggested?: number): Promise<void> {
  if (!(["daily", "weekly", "biweekly"] as const).includes(frequency)) return fail("LMMX_E_VALIDATION", "Choose daily, weekly or every two weeks.");
  if (suggested !== undefined && (!isValidCredit(suggested) || suggested > t.rent.amountMinor)) return fail("LMMX_E_AMOUNT", "Enter a whole-shilling amount from KES 10.");
  await col(COL.tenants).doc(t.tenantId).update({ frequency, ...(suggested !== undefined ? { suggestedCreditMinor: suggested } : {}), updatedAt: now() });
  await audit({ action: "plan_changed", actor: { type: "tenant" }, tenantId: t.tenantId, summary: `plan ${frequency}${suggested ? ` ${suggested / 100}` : ""}` });
}
void shortDate; void hmacHex; void LMM_SEAL_KEY;
