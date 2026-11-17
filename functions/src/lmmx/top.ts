// COG-0000 operations. Every one is called through requireTop (verified @samuhia.co.ke, recent sign-in, written reason) and audited.
import * as admin from "firebase-admin";
import { COL } from "./config";
import type { AuditRow, LeadRow, TopAuditListIn, TopAuditListOut, TopLeadGetOut, TopLeadsListIn, TopLeadsListOut, TopRevealIn, TopRevealOut, TopStatsOut, TenantStatus } from "./contract";
import { LEAD_STAGES, LMMX_TOP_DESK, maskName } from "./contract";
import type { LeadStage } from "./contract";
import { dec } from "./crypto";
import { fail } from "./errors";
import { audit, col, flags, now, verifyAudit } from "./store";
import { activateTenant, closeTenant, loadTenant, sendSetupOtp, nameOf, phoneOf } from "./tenants";
import type { DeskCtx } from "./authz";
import type { LeadDoc, RecipientDoc, TenantDoc } from "./types";

type Top = DeskCtx & { reason: string };
const actor = (d: Top) => ({ type: "top" as const, deskCode: d.deskCode, uid: d.uid, ip: d.ip });

export async function reviewQueue() {
  const q = await col(COL.recipients).where("status", "==", "needs_review").limit(50).get();
  const items = await Promise.all(q.docs.map(async (d) => {
    const r = d.data() as RecipientDoc;
    const n = await col(COL.tenants).where("activeRecipientId", "==", r.recipientId).count().get();
    return { recipientId: r.recipientId, channel: r.channel, accountNumber: r.accountNumber, reason: (r.reviewReason ?? "other") as "name_mismatch" | "shared_recipient" | "other", tenants: n.data().count, desks: new Set(r.deskCodes).size, createdAt: r.createdAt };
  }));
  return { items };
}

export async function reviewDecision(top: Top, i: { recipientId: string; decision: "approve" | "reject" }): Promise<void> {
  const ref = col(COL.recipients).doc(String(i.recipientId));
  const r = (await ref.get()).data() as RecipientDoc | undefined;
  if (!r || r.status !== "needs_review") return fail("LMMX_E_STATE", "This account is not waiting for review.");
  const waiting = await col(COL.tenants).where("activeRecipientId", "==", r.recipientId).where("status", "==", "draft").limit(50).get();
  if (i.decision === "approve") {
    await ref.update({ status: "verified", verifiedAt: now(), reviewReason: admin.firestore.FieldValue.delete() });
    for (const d of waiting.docs) {
      const t = d.data() as TenantDoc;
      if (!t.needsReview) continue;
      await d.ref.update({ status: "awaiting_confirmation", needsReview: admin.firestore.FieldValue.delete(), setupExpiresAt: now() + 72 * 3_600_000, updatedAt: now() });
      const live = { ...t, status: "awaiting_confirmation" as const }, rv = { ...r, status: "verified" as const };
      // a tenant the top desk registered needs no code; every other desk's tenant gets its code by SMS now
      if (t.deskCode === LMMX_TOP_DESK) await activateTenant(live, rv, "top").catch((e) => console.error("LMMX review activation failed", (e as Error).message));
      else await sendSetupOtp(live, rv).catch((e) => console.error("LMMX review resend failed", (e as Error).message));
    }
  } else {
    await ref.update({ status: "retired" });
    for (const d of waiting.docs) await closeTenant(d.data() as TenantDoc, "landlord account rejected");
  }
  await audit({ action: "recipient_review_decided", actor: actor(top), summary: `${i.decision} ${r.recipientId} | ${top.reason.slice(0, 120)}` });
}

export async function setFreeze(top: Top, scope: "tenant" | "recipient" | "desk", id: string, freeze: boolean): Promise<void> {
  if (!["tenant", "recipient", "desk"].includes(scope) || typeof id !== "string" || !id) return fail("LMMX_E_VALIDATION", "Choose what to freeze.");
  if (scope === "tenant") {
    const t = await loadTenant(id);
    await col(COL.tenants).doc(t.tenantId).update({ frozen: freeze, ...(freeze ? { frozenReason: top.reason.slice(0, 200) } : { frozenReason: admin.firestore.FieldValue.delete() }), updatedAt: now() });
  } else if (scope === "recipient") {
    const ref = col(COL.recipients).doc(id); const r = (await ref.get()).data() as RecipientDoc | undefined;
    if (!r) return fail("LMMX_E_NOT_FOUND", "Landlord account not found.");
    if (freeze) await ref.update({ status: "frozen" });
    else if (r.status === "frozen") await ref.update({ status: "verified" });
  } else {
    const ref = col(COL.locks).doc(`deskfreeze_${id}`);
    if (freeze) await ref.set({ at: now(), by: top.deskCode, reason: top.reason.slice(0, 200) }); else await ref.delete();
  }
  await audit({ action: freeze ? "freeze" : "unfreeze", actor: actor(top), tenantId: scope === "tenant" ? id : undefined, summary: `${freeze ? "froze" : "unfroze"} ${scope} ${id} | ${top.reason.slice(0, 120)}` });
}

export async function reassign(top: Top, tenantId: string, toDeskCode: string): Promise<void> {
  const t = await loadTenant(tenantId);
  const d = await col("desk_agents").where("agentCode", "==", String(toDeskCode)).limit(1).get();
  const a = d.docs[0]?.data() as { agentId?: string; status?: string } | undefined;
  if (!a || a.status !== "active" || !a.agentId) return fail("LMMX_E_NOT_FOUND", "That desk was not found or is not active.");
  await col(COL.tenants).doc(t.tenantId).update({ deskCode: toDeskCode, deskUid: a.agentId, updatedAt: now() });
  await audit({ action: "reassign", actor: actor(top), tenantId, summary: `${t.deskCode} -> ${toDeskCode} | ${top.reason.slice(0, 120)}` });
}

export async function reveal(top: Top, i: TopRevealIn): Promise<TopRevealOut> {
  const t = await loadTenant(i.tenantId);
  const rec = (await col(COL.recipients).doc(t.activeRecipientId).get()).data() as RecipientDoc;
  const values: TopRevealOut["values"] = {};
  for (const f of i.fields ?? []) {
    if (f === "phone") values.phone = phoneOf(t);
    else if (f === "id") values.id = dec(t.idEnc);
    else if (f === "landlordContact") values.landlordContact = dec(rec.contactPhoneEnc);
    else if (f === "landlordName") values.landlordName = dec(rec.resolvedNameEnc);
  }
  await audit({ action: "reveal", actor: actor(top), tenantId: t.tenantId, summary: `revealed ${(i.fields ?? []).join(",")} | ${top.reason.slice(0, 120)}` });
  return { values };
}

export async function auditList(i: TopAuditListIn): Promise<TopAuditListOut> {
  const limit = Math.min(100, Math.max(1, Math.trunc(Number(i?.limit ?? 50))));
  let q: admin.firestore.Query = col(COL.audit);
  if (i?.tenantId) q = q.where("tenantId", "==", i.tenantId);
  else if (i?.action) q = q.where("action", "==", i.action);
  else if (i?.deskCode) q = q.where("actor.deskCode", "==", i.deskCode);
  q = q.orderBy("seq", "desc");
  if (typeof i?.cursor === "number") q = q.startAfter(i.cursor);
  const snap = await q.limit(limit + 1).get();
  let rows = snap.docs.slice(0, limit).map((d) => d.data() as { seq: number; ts: number; action: AuditRow["action"]; actor: { type: AuditRow["actor"]["type"]; deskCode?: string | null }; tenantId?: string | null; summary: string; hash: string });
  rows = rows.filter((r) => (!i?.action || r.action === i.action) && (!i?.tenantId || r.tenantId === i.tenantId) && (!i?.deskCode || r.actor.deskCode === i.deskCode) && (!i?.from || r.ts >= i.from) && (!i?.to || r.ts <= i.to));
  return { rows: rows.map((r) => ({ seq: r.seq, ts: r.ts, action: r.action, actor: { type: r.actor.type, ...(r.actor.deskCode ? { deskCode: r.actor.deskCode } : {}) }, ...(r.tenantId ? { tenantId: r.tenantId } : {}), summary: r.summary, hash: r.hash })), ...(snap.docs.length > limit ? { nextCursor: rows[rows.length - 1]?.seq } : {}) };
}
export const auditVerify = (i: { fromSeq?: number; toSeq?: number }) => verifyAudit(i?.fromSeq ?? 1, i?.toSeq ?? Number.MAX_SAFE_INTEGER);

const leadRow = (l: LeadDoc): LeadRow => ({ leadId: l.leadId, landlordLabel: maskName(dec(l.displayNameEnc)), tenants: l.tenants, monthlyRentMinor: l.monthlyRentMinor, deskCodes: l.deskCodes, stage: l.stage, ...(l.nextFollowUpAt ? { nextFollowUpAt: l.nextFollowUpAt } : {}), onPms: l.onPms, updatedAt: l.updatedAt });
export async function leadsList(i: TopLeadsListIn): Promise<TopLeadsListOut> {
  const limit = Math.min(50, Math.max(1, Math.trunc(Number(i?.limit ?? 25))));
  let q: admin.firestore.Query = col(COL.leads);
  if (i?.stage) { if (!LEAD_STAGES.includes(i.stage)) return fail("LMMX_E_VALIDATION", "Unknown stage."); q = q.where("stage", "==", i.stage); }
  const term = String(i?.q ?? "").trim().toLowerCase();
  if (term) {
    const snap = await q.limit(300).get();
    const rows = snap.docs.map((d) => d.data() as LeadDoc).filter((l) => dec(l.displayNameEnc).toLowerCase().includes(term) || l.leadId.toLowerCase() === term).slice(0, limit);
    return { leads: rows.map(leadRow) };
  }
  q = q.orderBy("updatedAt", "desc");
  if (i?.cursor && /^\d+$/.test(i.cursor)) q = q.startAfter(Number(i.cursor));
  const snap = await q.limit(limit + 1).get();
  const docs = snap.docs.slice(0, limit).map((d) => d.data() as LeadDoc);
  return { leads: docs.map(leadRow), ...(snap.docs.length > limit ? { nextCursor: String(docs[docs.length - 1].updatedAt) } : {}) };
}
export async function leadGet(top: Top, leadId: string): Promise<TopLeadGetOut> {
  const l = (await col(COL.leads).doc(String(leadId)).get()).data() as LeadDoc | undefined;
  if (!l) return fail("LMMX_E_NOT_FOUND", "Lead not found.");
  await audit({ action: "reveal", actor: actor(top), summary: `opened lead ${l.leadId} contact | ${top.reason.slice(0, 120)}` });
  return { ...leadRow(l), landlordLabel: dec(l.displayNameEnc), contactName: dec(l.displayNameEnc), contactPhone: dec(l.contactPhoneEnc), notes: l.notes };
}
export async function leadUpdate(top: Top, i: { leadId: string; stage?: LeadStage; note?: string; nextFollowUpAt?: number | null }): Promise<void> {
  const ref = col(COL.leads).doc(String(i.leadId));
  const l = (await ref.get()).data() as LeadDoc | undefined;
  if (!l) return fail("LMMX_E_NOT_FOUND", "Lead not found.");
  const patch: Record<string, unknown> = { updatedAt: now() };
  if (i.stage !== undefined) { if (!LEAD_STAGES.includes(i.stage)) return fail("LMMX_E_VALIDATION", "Unknown stage."); patch.stage = i.stage; }
  if (i.note && i.note.trim()) patch.notes = admin.firestore.FieldValue.arrayUnion({ ts: now(), by: top.deskCode, text: i.note.trim().slice(0, 500) });
  if (i.nextFollowUpAt === null) patch.nextFollowUpAt = admin.firestore.FieldValue.delete(); else if (typeof i.nextFollowUpAt === "number") patch.nextFollowUpAt = i.nextFollowUpAt;
  await ref.update(patch);
  await audit({ action: "lead_updated", actor: actor(top), summary: `lead ${l.leadId}${i.stage ? ` -> ${i.stage}` : ""}${i.note ? " +note" : ""} | ${top.reason.slice(0, 120)}` });
}

export async function stats(): Promise<TopStatsOut> {
  const statuses: TenantStatus[] = ["draft", "awaiting_confirmation", "active", "paused", "frozen", "closed", "migrated"];
  const counts = await Promise.all(statuses.map(async (s) => [s, (await col(COL.tenants).where("status", "==", s).count().get()).data().count] as const));
  const month = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 7);
  const from = Date.parse(`${month}-01T00:00:00+03:00`);
  const A = admin.firestore.AggregateField;
  const cred = await col(COL.payments).where("status", "==", "credited").where("creditedAt", ">=", from).aggregate({ s: A.sum("creditMinor") }).get();
  const paid = await col(COL.settlements).where("status", "==", "paid").where("paidAt", ">=", from).aggregate({ s: A.sum("amountMinor") }).get();
  const rq = await col(COL.recipients).where("status", "==", "needs_review").count().get();
  const f = await flags();
  return { tenants: Object.fromEntries(counts) as Record<TenantStatus, number>, creditedThisMonthMinor: cred.data().s ?? 0, settledThisMonthMinor: paid.data().s ?? 0, payoutsPaused: f.payoutsPaused, standaloneEnabled: f.enabled, openAlerts: 0, reviewQueue: rq.data().count };
}
void nameOf;
