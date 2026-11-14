// ONE scheduled job for every automatic job, so nothing runs twice or in parallel:
//   1. finish reports that were paid for but never generated (the app was closed before status() ran);
//   2. seed this month's work list (Business+ landlords, once per month, paged);
//   3. make the free monthly MRI report for each property of those landlords, as soon as every invoice's rent for the
//      return month is paid, or on the 15th at the latest. It only ever uses the free allowance: it never charges anyone,
//      and a property whose allowance is already used is skipped.
//      The records must be current: synced within 3 days = made normally; 3 to 7 days = made with a warning in the PDF and an
//      SMS; over 7 days (or never synced) = not made, the landlord gets an SMS, and the free allowance is kept. A property
//      that is over 7 days old before the 15th is held back until the 15th in case the landlord syncs in the meantime.
// The work list (complianceAuto) holds only landlords still waiting, so a daily run does not rescan every user.
import * as admin from "firebase-admin";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { BUNDLE_SECRETS } from "../secretsBundle";
import { randomHex } from "../landlordWatch/keys";
import { sendHpSms } from "../hpSms";
import { checkSafaricomPhone } from "../phone/safaricom";
import { MRI_DUE_DAY, FREE_TIERS } from "./constants";
import { createPdfRenderer, defaultDeps } from "./api";
import { loadSyncedAt } from "./data";
import { autoAction, classifyFreshness, staleNoticeText, type DataAsOf } from "./freshness";
import { nairobiDay, nairobiMonth, previousMonth } from "./pricing";
import { reportsCol } from "./payments";
import { generateOrder, type Deps } from "./service";

export const AUTO_FORCE_DAY = 15;          // generate on this day even if some rent is still unpaid
const SEED_PAGE = 300, PENDING_PAGE = 25, MAX_REPORTS_PER_RUN = 12, TIME_BUDGET_MS = 6 * 60_000;
const idFilter = (v: string): string | number => (/^\d+$/.test(v) ? Number(v) : v);
type Notice = "warned" | "skipped";

export interface RunSummary { target: string; swept: number; seeded: number; landlords: number; generated: number; skipped: number; failed: number }

/** Is the rent for the month settled for every invoice, and is every active tenant invoiced? (pure on the snapshot data) */
export function rentSettled(invoices: { rentAmount: number; amountPaid: number }[], activeTenants: number): boolean {
  if (invoices.length === 0 || invoices.length < activeTenants) return false;
  return invoices.every((i) => Number(i.amountPaid) + 0.005 >= Number(i.rentAmount));
}
export const dueForAuto = (day: number, settled: boolean): boolean => day <= MRI_DUE_DAY && (settled || day >= AUTO_FORCE_DAY);

export async function runScheduler(deps: Deps, makeRenderer: () => { render: Deps["pdf"]; close(): Promise<void> }, nowDate = deps.now()): Promise<RunSummary> {
  const db = deps.db;
  const started = Date.now();
  const day = nairobiDay(nowDate), thisMonth = nairobiMonth(nowDate), target = previousMonth(thisMonth);
  const out: RunSummary = { target, swept: 0, seeded: 0, landlords: 0, generated: 0, skipped: 0, failed: 0 };
  const renderer = makeRenderer();
  const outOfTime = () => Date.now() - started > TIME_BUDGET_MS;
  try {
    // 1. paid but not generated (older than 2 minutes, so the app's own status() call gets first go)
    const stuck = await reportsCol(db).where("state", "==", "paid").limit(10).get();
    for (const d of stuck.docs) {
      if (outOfTime()) break;
      if (nowDate.getTime() - Number(d.data().paidAt ?? 0) < 120_000 || d.data().entitled !== true) continue;
      try { await generateOrder(deps, d.id, renderer.render); out.swept++; } catch { out.failed++; }
    }
    if (day > MRI_DUE_DAY) return out;                                 // the return for last month was due on the 20th; no more automatic reports

    // 2. seed the work list for the target month
    const seedRef = db.collection("complianceAuto").doc(`seed_${target}`);
    const seed = (await seedRef.get()).data();
    if (!seed?.complete) {
      let last: string | null = seed?.lastUid ?? null;
      for (let page = 0; page < 5 && !outOfTime(); page++) {
        let q = db.collection("users").where("tier", "in", [...FREE_TIERS]).orderBy(admin.firestore.FieldPath.documentId()).limit(SEED_PAGE);
        if (last) q = q.startAfter(last);
        const snap = await q.get();
        const batch = db.batch();
        for (const u of snap.docs) {
          batch.set(db.collection("complianceAuto").doc(`${target}_${u.id}`), { uid: u.id, month: target, state: "pending", props: {}, createdAt: Date.now() }, { merge: true });
          last = u.id; out.seeded++;
        }
        if (!snap.empty) await batch.commit();
        const complete = snap.size < SEED_PAGE;
        await seedRef.set({ month: target, lastUid: last, complete, updatedAt: Date.now() }, { merge: true });
        if (complete) break;
      }
    }

    // 3. work through the landlords still waiting
    const pending = await db.collection("complianceAuto").where("month", "==", target).where("state", "==", "pending").limit(PENDING_PAGE).get();
    for (const w of pending.docs) {
      if (outOfTime() || out.generated >= MAX_REPORTS_PER_RUN) break;
      out.landlords++;
      await processLandlord(deps, renderer.render, w.ref, w.data(), { target, day, nowMs: nowDate.getTime(), period: thisMonth }, out, outOfTime);
    }
    return out;
  } finally {
    await renderer.close();
  }
}

async function processLandlord(
  deps: Deps, render: Deps["pdf"], workRef: admin.firestore.DocumentReference, work: admin.firestore.DocumentData,
  ctx: { target: string; day: number; nowMs: number; period: string }, out: RunSummary, outOfTime: () => boolean,
): Promise<void> {
  const db = deps.db;
  const uid = String(work.uid);
  const user = db.collection("users").doc(uid);
  const u = (await user.get()).data();
  const props = (work.props ?? {}) as Record<string, string>;
  const notified = (work.notified ?? {}) as Record<string, string>;
  let syncedAt: number | null | undefined;                          // read once per landlord, only when a report is about to be made

  /** One SMS per property per outcome per month. Recorded only after it was sent, so a failed send is tried again on the next run. */
  const tell = async (pid: string, propertyName: string, outcome: Notice, fresh: DataAsOf): Promise<void> => {
    if (notified[pid] === outcome || notified[pid] === "no_phone") return;
    const phone = checkSafaricomPhone(u?.phone);
    if (!phone.ok) { notified[pid] = "no_phone"; await workRef.update({ [`notified.${pid}`]: "no_phone" }); return; }
    const sent = await sendHpSms({ mobile: phone.msisdn, message: staleNoticeText({ outcome, level: fresh.level, ageDays: fresh.ageDays, property: propertyName, month: ctx.target }) });
    if (!sent.success) { console.error(`Stale-records SMS not sent for ${uid}/${pid}:`, sent.error); return; }
    notified[pid] = outcome;
    await workRef.update({ [`notified.${pid}`]: outcome });
  };
  if (!u || !FREE_TIERS.includes(String(u.tier ?? "").toLowerCase()) || u.complianceAuto === false) { await workRef.update({ state: "done", reason: "not_eligible" }); return; }
  const properties = await user.collection("properties").get();
  let open = 0;
  for (const p of properties.docs) {
    if (props[p.id]) continue;
    if (outOfTime() || out.generated >= MAX_REPORTS_PER_RUN) { open++; continue; }
    const pid = idFilter(p.id);
    const [tenants, invoices] = await Promise.all([
      user.collection("tenants").where("propertyId", "==", pid).get(),
      user.collection("invoices").where("propertyId", "==", pid).where("billingMonth", "==", ctx.target).get(),
    ]);
    const active = tenants.docs.filter((t) => t.data().isActive !== false && t.data().isRestricted !== true).length;
    if (active === 0) { await workRef.update({ [`props.${p.id}`]: "skipped_no_tenants" }); out.skipped++; continue; }
    const settled = rentSettled(invoices.docs.map((i) => ({ rentAmount: Number(i.data().rentAmount ?? 0), amountPaid: Number(i.data().amountPaid ?? 0) })), active);
    if (!dueForAuto(ctx.day, settled)) { open++; continue; }
    if (invoices.empty) { await workRef.update({ [`props.${p.id}`]: "skipped_no_invoices" }); out.skipped++; continue; }

    // are the synced records current? (decided before the free allowance is touched, so a skip costs the landlord nothing)
    if (syncedAt === undefined) syncedAt = await loadSyncedAt(db, uid);
    const fresh = classifyFreshness(syncedAt, ctx.nowMs);
    const action = autoAction(fresh.level, ctx.day, AUTO_FORCE_DAY);
    if (action === "wait" || action === "skip") {
      await tell(p.id, String(p.data().name ?? ""), "skipped", fresh);
      if (action === "wait") { open++; continue; }
      await workRef.update({ [`props.${p.id}`]: "skipped_stale", [`stale.${p.id}`]: { level: fresh.level, syncedAt: fresh.syncedAt } });
      out.skipped++;
      continue;
    }

    // the free allowance, atomically; if it is gone, the landlord already has (or chose to buy) this month's report
    const qRef = db.collection("complianceQuota").doc(`${uid}_${p.id}_${ctx.period}`);
    const got = await db.runTransaction(async (tx) => {
      const used = Number((await tx.get(qRef)).data()?.used ?? 0);
      if (used >= 1) return false;
      tx.set(qRef, { used: used + 1, uid, propertyId: p.id, period: ctx.period, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      return true;
    });
    if (!got) { await workRef.update({ [`props.${p.id}`]: "skipped_allowance_used" }); out.skipped++; continue; }

    const id = randomHex(8);
    await reportsCol(db).doc(id).set({
      id, channel: "auto", actorKey: `auto_${uid}`, uid, ownerId: null, propertyId: p.id, month: ctx.target, kind: "mri_monthly", state: "paid", entitled: true,
      freeConsumed: true, priceMinor: 0, tier: String(u.tier), period: ctx.period, createdAt: ctx.nowMs, paidAt: ctx.nowMs,
      auto: { settled, dataLevel: fresh.level, dataSyncedAt: fresh.syncedAt },
    });
    let made = false;
    try {
      await generateOrder(deps, id, render);
      await workRef.update({ [`props.${p.id}`]: "generated", [`reports.${p.id}`]: id });
      out.generated++;
      made = true;
    } catch (e) { console.error(`Auto report ${id} failed:`, e); await workRef.update({ [`props.${p.id}`]: "failed" }); out.failed++; }
    if (made && action === "generate_warn") {
      try { await tell(p.id, String(p.data().name ?? ""), "warned", fresh); } catch (e) { console.error(`Stale-records notice failed for ${uid}/${p.id}:`, e); }   // the report is already made; never undo it
    }
  }
  if (open === 0) await workRef.update({ state: "done", finishedAt: Date.now() });
}

/** Every 6 hours is cheap: it only touches landlords still waiting and stops on its own after the 20th. */
export const crScheduler = onSchedule(
  { schedule: "every 6 hours", timeZone: "Africa/Nairobi", region: "us-central1", secrets: BUNDLE_SECRETS, memory: "2GiB", timeoutSeconds: 540, maxInstances: 1 },
  async () => {
    const deps = defaultDeps();
    const r = await runScheduler(deps, () => { const x = createPdfRenderer(); return { render: x.render.bind(x), close: () => x.close() }; });
    console.log("compliance scheduler", JSON.stringify(r));
  },
);
