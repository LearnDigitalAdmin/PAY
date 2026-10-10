// MyChama connector context + hook (the provider component lives in ChamaConnectorProvider.tsx).
import { createContext, useContext } from 'react';
import type { ChamaSnapshotDoc, MyChamaErrorCode, SyncResponse } from './contract';

export interface ChamaConnector {
  enabled: boolean;                       // signed in as landlord/tenant
  snapshot: ChamaSnapshotDoc | null;
  snapshotLoaded: boolean;
  syncing: boolean;
  syncError: MyChamaErrorCode | null;
  lastResponse: SyncResponse | null;
  /** snapshot exists but is older than SNAPSHOT_STALE_AFTER_SECONDS (the server only marks `stale` on failures) */
  staleByTime: boolean;
  refresh: () => Promise<SyncResponse | null>;
}

export const ChamaConnectorContext = createContext<ChamaConnector | null>(null);

export function useChamaConnector(): ChamaConnector {
  const v = useContext(ChamaConnectorContext);
  if (!v) throw new Error('useChamaConnector must be used inside <ChamaConnectorProvider>');
  return v;
}
