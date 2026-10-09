// Sync orchestration: lease/cooldown gate -> link pass -> per-chama reads -> snapshot write.
// Reads mychama1, writes ONLY plot docs (chamaSnapshots/{uid}, chamaSyncState/{uid}, chamaLinks/*).
import {
  MYCHAMA_LIMITS, MYCHAMA_PATHS,
  type ChamaSnapshotChama, type ChamaSnapshotDoc, type ConnectorStatus, type MyChamaErrorCode,
  type ChamaLinkDoc, type SyncReason, type SyncResponse,
} from "../contract";
import { plotDb } from "../config";
import { myChamaError } from "../errors";
import { runLinkPass } from "../link/engine";
import { buildContributions, buildLoans, buildMgr, combineTotals } from "./compute";
import { eatDateIso, eatMonthKey } from "./dates";
import type { Caller } from "./identity";
import { readChamaForMember } from "./read";

const L = MYCHAMA_LIMITS;
const LEASE_MS = 90_000;

export interface SyncOptions { force?: boolean; bypassCooldown?: boolean }

export async function runSyncFor(caller: Caller, reason: SyncReason, opts: SyncOptions = {}): Promise<SyncResponse> {
  const uid = caller.uid;
  const now = Date.now();
  const gate = await acquire(uid, reason, opts, now);

  if (!gate.go) {
    const snap = await readSnapshot(uid);
    return { status: snap?.status ?? "never_linked", throttled: true, lastSyncedAt: snap?.lastSyncedAt ?? null, nextAllowedAt: gate.nextAllowedAt };
  }

  try {
    try {
      const snapshot = await buildSnapshot(caller, now);
      await plotDb().doc(MYCHAMA_PATHS.snapshot(uid)).set(snapshot);
      await plotDb().doc(MYCHAMA_PATHS.syncState(uid)).set({ lastSyncedAt: now }, { merge: true });
      return { status: snapshot.status, throttled: false, lastSyncedAt: now, nextAllowedAt: now + L.SYNC_COOLDOWN_SECONDS * 1000 };
    } catch (e) {
      // Failed sync: NEVER wipe the last good data — only status / error / attempt time change.
      console.error("mychama sync failed:", (e as Error)?.message || e);
      const prev = await readSnapshot(uid).catch(() => null);
      const code: MyChamaErrorCode = "upstream_failure";
      const failure: ChamaSnapshotDoc = {
        version: 1, uid,
        status: prev?.lastSyncedAt ? "stale" : "unavailable",
        lastSyncedAt: prev?.lastSyncedAt ?? null, lastAttemptAt: now, lastError: { code, at: now },
        chamas: prev?.chamas ?? [], pending: prev?.pending ?? [],
      };
      try {
        await plotDb().doc(MYCHAMA_PATHS.snapshot(uid)).set(failure);
      } catch {
        throw myChamaError("internal", "Could not record sync state.", "internal");
      }
      return { status: failure.status, throttled: false, lastSyncedAt: failure.lastSyncedAt, nextAllowedAt: now + L.SYNC_MANUAL_COOLDOWN_SECONDS * 1000 };
    }
  } finally {
    await plotDb().doc(MYCHAMA_PATHS.syncState(uid)).set({ leaseUntil: 0 }, { merge: true }).catch(() => undefined);
  }
}

// ─────────────────────────────── gate ───────────────────────────────
async function acquire(uid: string, reason: SyncReason, opts: SyncOptions, now: number): Promise<{ go: boolean; nextAllowedAt: number | null }> {
  const db = plotDb();
  const stateRef = db.doc(MYCHAMA_PATHS.syncState(uid));
  const snapRef = db.doc(MYCHAMA_PATHS.snapshot(uid));

  return db.runTransaction(async (tx) => {
    const [st, sn] = await Promise.all([tx.get(stateRef), tx.get(snapRef)]);
    const s = st.data() || {};
    const leaseUntil = Number(s.leaseUntil || 0);
    if (leaseUntil > now) return { go: false, nextAllowedAt: leaseUntil };          // another sync is running

    const first = !sn.exists;
    const forced = opts.bypassCooldown === true || (reason === "login" && first);
    const cooldownSec = reason === "manual" || opts.force ? L.SYNC_MANUAL_COOLDOWN_SECONDS : L.SYNC_COOLDOWN_SECONDS;
    const last = Number(s.lastAttemptAt || 0);
    if (!forced && now - last < cooldownSec * 1000) return { go: false, nextAllowedAt: last + cooldownSec * 1000 };

    tx.set(stateRef, { lastAttemptAt: now, leaseUntil: now + LEASE_MS }, { merge: true });
    return { go: true, nextAllowedAt: null };
  });
}

async function readSnapshot(uid: string): Promise<ChamaSnapshotDoc | null> {
  const s = await plotDb().doc(MYCHAMA_PATHS.snapshot(uid)).get();
  return s.exists ? (s.data() as ChamaSnapshotDoc) : null;
}

// ───────────────────────────── snapshot ─────────────────────────────
async function buildSnapshot(caller: Caller, now: number): Promise<ChamaSnapshotDoc> {
  const pass = await runLinkPass(caller);            // may throw (mychama1 unreachable / index missing) => whole-sync failure
  const t = { today: eatDateIso(now), month: eatMonthKey(now) };

  const results = await Promise.all(pass.active.map((l) => buildChama(l, t, now)));
  if (results.length > 0 && results.every((r) => r.failed)) throw new Error("every linked chama was unreadable");

  const chamas = results.map((r) => r.chama).sort((a, b) => a.chamaName.localeCompare(b.chamaName));
  const status: ConnectorStatus = pass.active.length > 0 ? "ok" : pass.needsReverify.length > 0 ? "needs_reverify" : "never_linked";
  return {
    version: 1, uid: caller.uid, status, lastSyncedAt: now, lastAttemptAt: now, lastError: null, chamas,
    pending: pass.pending.map((p) => ({ pendingId: p.pendingId, maskedPhone: p.maskedPhone, chamaCount: p.chamaCount })),
  };
}

async function buildChama(link: ChamaLinkDoc, t: { today: string; month: string }, now: number): Promise<{ chama: ChamaSnapshotChama; failed: boolean }> {
  try {
    const r = await readChamaForMember(link.chamaId, link.memberId);
    const c = r.contributions ? buildContributions(r.contributions, t) : null;
    const l = r.loans ? buildLoans(r.loans, t) : null;
    const m = r.pots ? buildMgr(r.pots, link.memberId) : null;
    const dataStatus = r.failed.length === 0 ? "ok" : r.failed.length >= 3 ? "unavailable" : "partial";
    return {
      failed: dataStatus === "unavailable",
      chama: {
        chamaId: link.chamaId, chamaName: r.chama.name || link.chamaName, memberId: link.memberId,
        onlineCollectionEnabled: r.chama.plan !== "free" && r.chama.status === "active" && r.chama.settlementSplitCode !== "",
        dataStatus, missing: r.failed,
        contributions: c?.snap ?? null, loans: l?.snap ?? null, mgr: m?.snap ?? null,
        totals: combineTotals([c, l, m], m?.snap ?? null, t), asOf: now,
      },
    };
  } catch (e) {
    console.error(`mychama sync: chama ${link.chamaId} unreadable:`, (e as Error)?.message || e);
    return {
      failed: true,
      chama: {
        chamaId: link.chamaId, chamaName: link.chamaName, memberId: link.memberId, onlineCollectionEnabled: false,
        dataStatus: "unavailable", missing: ["contributions", "loans", "mgr"],
        contributions: null, loans: null, mgr: null, totals: null, asOf: now,
      },
    };
  }
}
