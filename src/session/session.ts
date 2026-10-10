// Session layer: who is signed in and which portal (agent/landlord or tenant) they belong to.
//
// Source of truth = the Firebase Auth user + the server. Landlords are recognised by the custom claims
// { role: "landlord", agentId } (stamped by the `agentSyncClaims` callable); tenants by their
// tenants/{uid} profile. The old `localStorage.agentAuthUser` record is kept ONLY as a derived cache so
// AgentView (which still reads it) keeps working unchanged — it is rewritten from the verified session
// and removed on sign-out; nothing trusts it.
import { createContext, useContext } from 'react';
import type { User } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from '../Firebase';

export type PortalRole = 'agent' | 'tenant';

export interface AgentSessionProfile { id: string; email: string; name: string; type: string; tier: string }

export interface ResolveResult { role: PortalRole | null; agentProfile: AgentSessionProfile | null; message?: string }

export interface Session {
  status: 'loading' | 'signedOut' | 'signedIn';
  user: User | null;
  role: PortalRole | null;
  agentProfile: AgentSessionProfile | null;
  /** True when this sign-in happened moments ago (as opposed to a restored session on page load). */
  freshSignIn: boolean;
  /** Re-resolve the role for the current user (used right after a login completes). */
  refresh: () => Promise<ResolveResult>;
}

const PORTAL_KEY = 'samuhia.portal';
const LEGACY_AGENT_KEY = 'agentAuthUser';

/** Remember which portal the person chose on the welcome screen (matters for dual-role people). */
export function setPortalPreference(role: PortalRole): void {
  try { sessionStorage.setItem(PORTAL_KEY, role); } catch { /* storage unavailable */ }
}
function getPortalPreference(): PortalRole | null {
  try {
    const v = sessionStorage.getItem(PORTAL_KEY);
    return v === 'agent' || v === 'tenant' ? v : null;
  } catch { return null; }
}

export function writeLegacyAgentCache(profile: AgentSessionProfile | null): void {
  try {
    if (profile) localStorage.setItem(LEGACY_AGENT_KEY, JSON.stringify(profile));
    else localStorage.removeItem(LEGACY_AGENT_KEY);
  } catch { /* storage unavailable */ }
}

async function loadAgentProfile(user: User, claimAgentId: string | null): Promise<{ profile: AgentSessionProfile | null; message?: string }> {
  let agentId = claimAgentId;
  if (!agentId) {
    try {
      const res = await httpsCallable<void, { agentId: string; claimsChanged: boolean }>(functions, 'agentSyncClaims')();
      agentId = res.data.agentId;
      if (res.data.claimsChanged) await user.getIdToken(true);
    } catch (e) {
      const code = (e as { code?: string }).code || '';
      const message = code.endsWith('permission-denied') ? 'Access restricted to agent accounts.'
        : code.endsWith('failed-precondition') ? (e as Error).message : undefined;
      return { profile: null, message };
    }
  }
  const snap = await getDoc(doc(db, 'users', agentId));
  if (!snap.exists()) return { profile: null };
  const d = snap.data();
  return { profile: { id: snap.id, email: String(d.email || user.email || ''), name: String(d.name || ''), type: String(d.type || ''), tier: String(d.tier || '') } };
}

export async function resolveRole(user: User): Promise<ResolveResult> {
  const pref = getPortalPreference();
  const claims = (await user.getIdTokenResult()).claims;
  const claimAgentId = claims.role === 'landlord' && typeof claims.agentId === 'string' ? claims.agentId : null;

  const isTenant = async () => (await getDoc(doc(db, 'tenants', user.uid))).exists();
  const asAgent = async (): Promise<ResolveResult | null> => {
    const { profile, message } = await loadAgentProfile(user, claimAgentId);
    return profile ? { role: 'agent', agentProfile: profile } : message ? { role: null, agentProfile: null, message } : null;
  };
  const asTenant = async (): Promise<ResolveResult | null> => ((await isTenant()) ? { role: 'tenant', agentProfile: null } : null);

  const order: Array<() => Promise<ResolveResult | null>> =
    pref === 'tenant' ? [asTenant, asAgent]
    : pref === 'agent' || claimAgentId ? [asAgent, asTenant]
    : [asTenant, asAgent];

  let message: string | undefined;
  for (const step of order) {
    const r = await step();
    if (r?.role) return r;
    if (r?.message) message = r.message;
  }
  // A brand-new tenant (phone verified, profile not created yet) continues to the signup flow.
  if (user.phoneNumber && pref !== 'agent') return { role: 'tenant', agentProfile: null };
  return { role: null, agentProfile: null, message };
}

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}
