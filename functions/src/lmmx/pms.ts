// Plot Yangu (PMS) side, read-only: a landlord who joins PMS, their tenants appearing there, and their first paid subscription / invoice.
// Runs from the daily sweep (cheap, no trigger on every users/* write). It never edits PMS data; it only creates desk_customers ownership + desk bonuses.
import { checkSafaricomPhone } from "../phone/safaricom";
import { COL, X } from "./config";
import { LMMX_TOP_DESK, lmmxText, normalizeKePhone } from "./contract";
import { dec } from "./crypto";
import { audit, col, now } from "./store";
import { payableBonus } from "./bonuses";
import { loadCycles } from "./cycles";
import { phoneOf, sms, nameOf } from "./tenants";
import { firstName } from "../lmm/dear";
import type { LeadDoc, RecipientDoc, TenantDoc } from "./types";
import { fitSms, LMMX_BRAND } from "./contract";

const phoneVariants = (e164: string): string[] => { const n = e164.replace("+254", ""); return [`0${n}`, `+254${n}`, `254${n}`]; };

async function landlordFor(l: LeadDoc): Promise<{ id: string; code: string } | null> {
  const phone = normalizeKePhone(dec(l.contactPhoneEnc));
  if (phone) {
    const q = await col("users").where("phone", "in", phoneVariants(phone)).limit(1).get();
    if (!q.empty) return { id: q.docs[0].id, code: String(q.docs[0].data().landlordCode ?? "") };
  }
  const recs = await col(COL.recipients).where("contactKey", "==", l.contactKey).limit(5).get();
  for (const r of recs.docs.map((d) => d.data() as RecipientDoc)) {
    const q = await col("users").where("paymentInfo.accountNumber", "==", r.accountNumber).limit(1).get();
    if (!q.empty) return { id: q.docs[0].id, code: String(q.docs[0].data().landlordCode ?? "") };
  }
  return null;
}

export async function runPmsMatching(): Promise<void> {
  // 1) landlords who joined
  const fresh = await col(COL.leads).where("onPms", "==", false).limit(200).get();
  for (const d of fresh.docs) {
    const l = d.data() as LeadDoc;
    try {
      const u = await landlordFor(l);
      if (!u) continue;
      await d.ref.update({ onPms: true, pmsLandlordId: u.id, pmsLandlordCode: u.code, updatedAt: now() });
      await audit({ action: "landlord_matched", actor: { type: "system" }, summary: `lead ${l.leadId} is on Plot Yangu (${u.code || u.id})` });
      if (u.code && l.attributedDeskUid && l.attributedDeskCode !== LMMX_TOP_DESK) {
        try { await col("desk_customers").doc(`pms:${u.code}`).create({ entityKey: `pms:${u.code}`, product: "pms", ownerAgentId: l.attributedDeskUid, attributedAt: now(), firstPurchaseUsed: false, paidPeriods: [] }); }
        catch (e) { if ((e as { code?: number }).code !== 6) throw e; }
      }
    } catch (e) { console.warn("LMMX landlord match failed", l.leadId, (e as Error).message); }
  }
  // 2) landlord bonus after the landlord's first paid PMS subscription (the existing desk_events fact)
  const onPms = await col(COL.leads).where("onPms", "==", true).limit(300).get();
  for (const d of onPms.docs) {
    const l = d.data() as LeadDoc;
    if (!l.pmsLandlordCode || !l.attributedDeskUid || l.landlordBonusPaid || l.attributedDeskCode === LMMX_TOP_DESK) continue;
    const ev = await col("desk_events").where("entityKey", "==", `pms:${l.pmsLandlordCode}`).where("agentId", "==", l.attributedDeskUid).where("type", "==", "subscription_payment").limit(1).get();
    if (ev.empty) continue;
    const gross = Number((ev.docs[0].data() as { grossMinor?: number }).grossMinor ?? 0);
    const amount = Math.max(X.LANDLORD_BONUS_MIN_MINOR, Math.floor((gross * X.LANDLORD_BONUS_PCT_BPS) / 10_000));
    if (await payableBonus({ deskUid: l.attributedDeskUid, amountMinor: amount, note: `Lipa Mdogo Mdogo landlord joined Plot Yangu ${l.pmsLandlordCode}`, parts: ["lmmx", "landlord", l.pmsLandlordCode] })) {
      await d.ref.update({ landlordBonusPaid: true, stage: "closed_won", updatedAt: now() });
      await audit({ action: "bonus_accrued", actor: { type: "system" }, summary: `landlord bonus ${amount / 100} for ${l.pmsLandlordCode}` });
    }
  }
  // 3) their tenants appearing in PMS: the plan finishes this cycle, then the tenant moves to invoices
  for (const d of onPms.docs) {
    const l = d.data() as LeadDoc;
    if (!l.pmsLandlordId) continue;
    const recs = await col(COL.recipients).where("contactKey", "==", l.contactKey).limit(10).get();
    for (const rd of recs.docs) {
      const ts = await col(COL.tenants).where("activeRecipientId", "==", rd.id).where("status", "==", "active").limit(50).get();
      for (const td of ts.docs) {
        const t = td.data() as TenantDoc;
        if (t.pmsLink) continue;
        const pm = await col("users").doc(l.pmsLandlordId).collection("tenants").where("phone", "in", phoneVariants(phoneOf(t))).limit(1).get();
        if (pm.empty) continue;
        await td.ref.update({ pmsLink: { landlordId: l.pmsLandlordId, switchedAt: now(), pmsTenantId: pm.docs[0].id }, migrating: true, updatedAt: now() });
        await sms(`lmmx_migr_${t.tenantId}`, phoneOf(t), fitSms(`${firstName(nameOf(t)) || "Hello"}, your landlord now uses Plot Yangu. Finish this month's ${LMMX_BRAND} rent as usual; after that you will pay through your Plot Yangu invoice.`));
      }
    }
  }
}

/** Moves migrating tenants to PMS once nothing of theirs is waiting to be paid out; pays the desk's migration bonus after the first PMS invoice is paid. */
export async function finishMigrations(): Promise<void> {
  const q = await col(COL.tenants).where("migrating", "==", true).limit(200).get();
  for (const d of q.docs) {
    const t = d.data() as TenantDoc & { pmsBonusDone?: boolean };
    const cycles = await loadCycles(t.tenantId);
    if (cycles.some((c) => c.inflightMinor > 0 || c.creditedMinor !== c.settledMinor)) continue;
    await d.ref.update({ status: "migrated", rentSource: "pms", migrating: false, pmsBonusPending: true, updatedAt: now() });
    for (const c of cycles) await col(COL.cycles).doc(c.cycleId).update({ status: "closed" });
    await audit({ action: "tenant_link", actor: { type: "system" }, tenantId: t.tenantId, summary: "tenant moved to Plot Yangu invoices" });
  }
  const b = await col(COL.tenants).where("pmsBonusPending", "==", true).limit(200).get();
  for (const d of b.docs) {
    const t = d.data() as TenantDoc;
    if (!t.pmsLink || t.deskCode === LMMX_TOP_DESK) { await d.ref.update({ pmsBonusPending: false }); continue; }
    const inv = await col("users").doc(t.pmsLink.landlordId).collection("invoices").where("tenantId", "==", (t.pmsLink as { pmsTenantId?: string }).pmsTenantId ?? "").where("isPaid", "==", true).limit(1).get();
    if (inv.empty) continue;
    await payableBonus({ deskUid: t.deskUid, amountMinor: X.MIGRATION_BONUS_MINOR, note: `Lipa Mdogo Mdogo tenant moved to Plot Yangu ${t.tenantId}`, parts: ["lmmx", "migration", t.tenantId] });
    await d.ref.update({ pmsBonusPending: false });
    await audit({ action: "bonus_accrued", actor: { type: "system" }, tenantId: t.tenantId, summary: "migration bonus" });
  }
}
void checkSafaricomPhone; void lmmxText;
