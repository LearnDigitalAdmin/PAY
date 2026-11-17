import axios from "axios";
import * as admin from "firebase-admin";
import { dearLine } from "../lmm/dear";
import { missedReminder } from "../lmm/reminders";
import { lmmText } from "../lmm/sms";
import { PAYSTACK_API_BASE, PAYSTACK_SECRET_KEY } from "../desk/paystack";
import { COL, X } from "./config";
import { LMMX, LMMX_BOT_LINK, LMMX_BRAND, daysUntil, eatDate, fitSms, kes, nextDueDate, shortDate } from "./contract";
import { alert, audit, col, db, flags, now } from "./store";
import { applyDueChanges, expireChanges } from "./changes";
import { closeTenant, nameOf, phoneOf, sms } from "./tenants";
import { holidays, loadCycles, newCycle, remainingOf } from "./cycles";
import { reconcileLocked, sendSettlement, settleCycle } from "./settle";
import { finishMigrations, runPmsMatching } from "./pms";
import type { CycleDoc, SettlementDoc, TenantDoc } from "./types";

async function eachTenant(statuses: string[], fn: (t: TenantDoc) => Promise<void>): Promise<void> {
  let last: admin.firestore.QueryDocumentSnapshot | undefined;
  for (;;) {
    let q = col(COL.tenants).where("status", "in", statuses).orderBy(admin.firestore.FieldPath.documentId()).limit(200);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) return;
    for (const d of snap.docs) { try { await fn(d.data() as TenantDoc); } catch (e) { console.error("LMMX sweep tenant failed", d.id, (e as Error).message); } }
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < 200) return;
  }
}

export async function dailySweep(): Promise<void> {
  const today = eatDate(now());
  // 1) setups never confirmed
  await eachTenant(["awaiting_confirmation", "draft"], async (t) => { if ((t.setupExpiresAt ?? Infinity) < now()) await closeTenant(t, "not confirmed in time"); });
  await expireChanges();
  await applyDueChanges();
  // 2) cycles, reminders
  const hol = await holidays();
  await eachTenant(["active", "paused"], async (t) => {
    const all = await loadCycles(t.tenantId, ["open", "funded", "partial_settled", "settled"]);
    const last = all[all.length - 1];
    if (t.status === "active" && t.rentSource === "lmm" && last && last.dueDate < today && !all.some((c) => remainingOf(c) > 0 && c.status !== "settled")) {
      const due = nextDueDate(last.dueDate, t.dueDay, 1);
      try { await col(COL.cycles).doc(newCycle(t, due, t.rent.amountMinor, hol).cycleId).create(newCycle(t, due, t.rent.amountMinor, hol)); } catch (e) { if ((e as { code?: number }).code !== 6) throw e; }
    }
    for (const c of all) if (remainingOf(c) > 0 && c.status !== "settled") await remind(t, c, today);
  });
  // 3) payouts that are due
  const cyc = await col(COL.cycles).where("status", "in", ["open", "funded", "partial_settled"]).limit(1000).get();
  for (const d of cyc.docs) { try { await settleCycle((d.data() as CycleDoc).cycleId); } catch (e) { console.error("LMMX settle sweep failed", d.id, (e as Error).message); } }
  // 4) landlords and tenants in Plot Yangu
  try { await runPmsMatching(); await finishMigrations(); } catch (e) { console.error("LMMX pms matching failed", (e as Error).message); }
  // 5) housekeeping
  for (const name of [COL.nonces, COL.rate]) {
    const old = await col(name).where("exp", "<", now()).limit(300).get();
    const b = db().batch(); old.docs.forEach((x) => b.delete(x.ref)); if (!old.empty) await b.commit();
  }
}

export interface PlannedReminder { kind: "warn" | "payby" | "due" | "overdue" | "missed"; key: string; text: string }
/** The reminders a tenant should get for this cycle today. Pure (no sending), so it is easy to test. Mirrors the legacy rhythm:
 *  a 5-day warning, a pay-by-date nudge, a due-day note, overdue nudges every 3 days, and (earlier in the cycle) a missed-instalment
 *  reminder after the plan's own quiet period, never closer than 3 days to any earlier SMS and at most 3 per stretch of silence. */
export function planReminders(t: TenantDoc, c: CycleDoc, today: string, nowMs: number): PlannedReminder[] {
  const left = remainingOf(c), n = daysUntil(c.dueDate, today);
  if (left <= 0 || c.status === "settled") return [];
  const name = nameOf(t), who = dearLine(name), out: PlannedReminder[] = [];
  if (n > 0 && n <= LMMX.WARN_DAYS_BEFORE_DUE && c.status !== "funded") {
    out.push({ kind: "warn", key: `lmmx_warn_${c.cycleId}`, text: fitSms(`${who} your ${LMMX_BRAND} rent is due in ${n} day${n === 1 ? "" : "s"} (${shortDate(c.dueDate)}). Balance ${kes(left)}. Pay by ${shortDate(c.payByDate)} so your landlord gets it all on time.`) });
  }
  if (n > 0 && today === c.payByDate) out.push({ kind: "payby", key: `lmmx_payby_${c.cycleId}`, text: fitSms(`${who} today is the last day to pay your ${LMMX_BRAND} rent in time. Balance ${kes(left)}. Pay now: ${LMMX_BOT_LINK}`) });
  if (n === 0) out.push({ kind: "due", key: `lmmx_due_${c.cycleId}`, text: fitSms(`${who} your ${LMMX_BRAND} rent is due today. Balance ${kes(left)}. Your landlord is paid what is in today; pay the rest as soon as you can.`) });
  if (n < 0) out.push({ kind: "overdue", key: `lmmx_over_${c.cycleId}_${Math.floor(-n / 3)}`, text: fitSms(`${who} your ${LMMX_BRAND} rent balance of ${kes(left)} is overdue. Pay any amount now: ${LMMX_BOT_LINK}`) });
  if (t.status === "active" && n > LMMX.WARN_DAYS_BEFORE_DUE) {
    const m = missedReminder({ frequency: t.frequency, status: "active", remainingMinor: left, createdAt: t.createdAt, lastPaymentAt: t.lastPaymentAt ?? 0, lastSmsAt: t.lastSmsAt ?? 0, missedCount: t.missedCount ?? 0 }, nowMs);
    if (m.send) out.push({ kind: "missed", key: `lmmx_missed_${t.tenantId}_${Math.floor(nowMs / 86_400_000)}`, text: lmmText.missed({ name, days: m.days, balanceMinor: left }) });
  }
  return out;
}

async function remind(t: TenantDoc, c: CycleDoc, today: string): Promise<void> {
  for (const r of planReminders(t, c, today, now())) {
    const sent = await sms(r.key, phoneOf(t), r.text);
    if (sent) {
      await col(COL.tenants).doc(t.tenantId).update({ lastSmsAt: now(), ...(r.kind === "missed" ? { missedCount: (t.missedCount ?? 0) + 1 } : {}) });
      t.lastSmsAt = now(); if (r.kind === "missed") t.missedCount = (t.missedCount ?? 0) + 1;
    }
  }
}

/** Every 15 minutes: retry payouts that are locked, confirm ones that were sent, pay funded cycles whose money has arrived. */
export async function settlementWorker(): Promise<void> {
  const locked = await col(COL.settlements).where("status", "==", "locked").limit(200).get();
  for (const d of locked.docs) {
    const s = d.data() as SettlementDoc;
    try { if (s.transferCode) { if (now() - s.createdAt > 10 * 60_000) await reconcileLocked(s.id); } else await sendSettlement(s.id); } catch (e) { console.error("LMMX worker", s.id, (e as Error).message); }
  }
  const funded = await col(COL.cycles).where("status", "==", "funded").limit(300).get();
  for (const d of funded.docs) { try { await settleCycle((d.data() as CycleDoc).cycleId); } catch (e) { console.error("LMMX funded settle", d.id, (e as Error).message); } }
}

/** Nightly: the numbers on every live cycle must add up, and Paystack must hold at least what we owe landlords. A mismatch pauses payouts. */
export async function reconcileDaily(): Promise<{ checked: number; bad: number }> {
  let bad = 0, owed = 0, checked = 0;
  const cyc = await col(COL.cycles).where("status", "in", ["open", "funded", "partial_settled"]).limit(2000).get();
  for (const d of cyc.docs) {
    const c = d.data() as CycleDoc; checked++;
    const held = c.creditedMinor - c.settledMinor;
    if (c.creditedMinor < 0 || c.settledMinor < 0 || c.inflightMinor < 0 || c.creditedMinor > c.rentMinor || c.settledMinor > c.creditedMinor || c.inflightMinor > held) {
      bad++; await alert("UNEXPECTED", `LMMX recon: cycle ${c.cycleId} numbers do not add up (credited ${c.creditedMinor}, settled ${c.settledMinor}, inflight ${c.inflightMinor})`);
    }
    owed += Math.max(0, held);
  }
  try {
    const r = await axios.get(`${PAYSTACK_API_BASE}/balance`, { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY.value()}` }, timeout: 20_000 });
    const kesBal = (r.data?.data as { currency: string; balance: number }[] | undefined)?.find((b) => b.currency === "KES")?.balance;
    if (typeof kesBal === "number" && kesBal < owed) await alert("LOW_BALANCE", `LMMX Paystack balance ${kesBal / 100} is below the ${owed / 100} owed to landlords`);
  } catch { /* balance check is best effort */ }
  if (bad > 0) {
    await col(COL.config).doc("standalone").set({ payoutsPaused: true, pausedAt: now(), pausedBy: "reconcile" }, { merge: true });
    await audit({ action: "tamper_detected", actor: { type: "system" }, summary: `reconcile found ${bad} bad cycles; payouts paused` });
  }
  void flags; void X;
  return { checked, bad };
}

export async function auditAnchor(): Promise<void> {
  const head = (await col(COL.auditMeta).doc("head").get()).data();
  if (!head) return;
  await col(COL.anchors).doc(eatDate(now()).replace(/-/g, "")).set({ headSeq: head.seq, headHash: head.hash, at: now() });
  console.log(`LMMX audit anchor ${eatDate(now())} seq=${head.seq} hash=${head.hash}`);
}
