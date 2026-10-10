// Provides the session (see session.ts for the rules). Component-only file so fast refresh works.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { auth } from '../Firebase';
import { SessionContext, resolveRole, writeLegacyAgentCache, type ResolveResult, type Session } from './session';

export const SessionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, setState] = useState<Omit<Session, 'refresh'>>({ status: 'loading', user: null, role: null, agentProfile: null, freshSignIn: false });
  const runId = useRef(0);
  const userRef = useRef<User | null>(null);

  const apply = useCallback(async (user: User | null): Promise<ResolveResult> => {
    const id = ++runId.current;
    userRef.current = user;
    if (!user) {
      writeLegacyAgentCache(null);
      setState({ status: 'signedOut', user: null, role: null, agentProfile: null, freshSignIn: false });
      return { role: null, agentProfile: null };
    }
    // Fresh sign-in (or a different user): hold the session in 'loading' until the role is resolved, so
    // ProtectedRoute shows the spinner instead of seeing 'signedOut' and bouncing the person to "/".
    setState((s) => (s.status === 'signedIn' && s.user?.uid === user.uid ? s : { ...s, status: 'loading', user }));
    let result: ResolveResult;
    try {
      result = await resolveRole(user);
    } catch (e) {
      console.error('Session resolve failed:', e);
      result = { role: null, agentProfile: null };
    }
    if (id !== runId.current) return result;   // a newer resolve superseded this one
    writeLegacyAgentCache(result.role === 'agent' ? result.agentProfile : null);
    const last = Date.parse(user.metadata.lastSignInTime || '');
    setState({
      status: 'signedIn', user, role: result.role, agentProfile: result.agentProfile,
      freshSignIn: Number.isFinite(last) && Date.now() - last < 120_000,
    });
    return result;
  }, []);

  useEffect(() => onAuthStateChanged(auth, (u) => { void apply(u); }), [apply]);

  const refresh = useCallback(() => apply(userRef.current ?? auth.currentUser), [apply]);
  const value = useMemo<Session>(() => ({ ...state, refresh }), [state, refresh]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
};
