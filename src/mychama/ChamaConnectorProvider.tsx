// MyChama connector state. The UI ALWAYS renders from the persisted snapshot document
// (chamaSnapshots/{uid}, read-only for clients); the sync callable only refreshes that document.
//   • first authenticated page load of a session  -> sync({reason:'login'}) when the sign-in is fresh,
//     otherwise sync({reason:'reload'}) — the server throttles, so this is cheap
//   • manual refresh                              -> sync({reason:'manual'})
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../Firebase';
import { useSession } from '../session/session';
import { mychamaApi, mychamaErrorCode, mychamaSnapshotPath } from './api';
import { MYCHAMA_LIMITS, type ChamaSnapshotDoc, type MyChamaErrorCode, type SyncResponse } from './contract';
import { ChamaConnectorContext, type ChamaConnector } from './connector';

export const ChamaConnectorProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const session = useSession();
  const uid = session.status === 'signedIn' && session.role ? session.user?.uid ?? null : null;

  const [snapshot, setSnapshot] = useState<ChamaSnapshotDoc | null>(null);
  const [snapshotLoaded, setSnapshotLoaded] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<MyChamaErrorCode | null>(null);
  const [lastResponse, setLastResponse] = useState<SyncResponse | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const syncedFor = useRef<string | null>(null);

  const runSync = useCallback(async (reason: 'login' | 'reload' | 'manual'): Promise<SyncResponse | null> => {
    setSyncing(true);
    setSyncError(null);
    try {
      const res = await mychamaApi.sync({ reason });
      setLastResponse(res);
      return res;
    } catch (e) {
      setSyncError(mychamaErrorCode(e) ?? 'upstream_failure');
      return null;
    } finally {
      setSyncing(false);
    }
  }, []);

  // Live snapshot listener.
  useEffect(() => {
    setSnapshot(null);
    setSnapshotLoaded(false);
    if (!uid) return;
    return onSnapshot(
      doc(db, mychamaSnapshotPath(uid)),
      (s) => { setSnapshot(s.exists() ? (s.data() as ChamaSnapshotDoc) : null); setSnapshotLoaded(true); },
      () => { setSnapshotLoaded(true); },        // e.g. rules not deployed yet: behave as "no data"
    );
  }, [uid]);

  // One sync per user per page load (the server decides whether it actually refreshes).
  useEffect(() => {
    if (!uid || syncedFor.current === uid) return;
    syncedFor.current = uid;
    void runSync(session.freshSignIn ? 'login' : 'reload');
  }, [uid, session.freshSignIn, runSync]);

  // Tick so "stale by time" updates without a reload.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const staleByTime = !!snapshot?.lastSyncedAt && now - snapshot.lastSyncedAt > MYCHAMA_LIMITS.SNAPSHOT_STALE_AFTER_SECONDS * 1000;
  const refresh = useCallback(() => runSync('manual'), [runSync]);

  const value = useMemo<ChamaConnector>(
    () => ({ enabled: !!uid, snapshot, snapshotLoaded, syncing, syncError, lastResponse, staleByTime, refresh }),
    [uid, snapshot, snapshotLoaded, syncing, syncError, lastResponse, staleByTime, refresh],
  );
  return <ChamaConnectorContext.Provider value={value}>{children}</ChamaConnectorContext.Provider>;
};
