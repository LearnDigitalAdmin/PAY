// Where a signed-in tenant goes after `lmmx_tenant_link` says which accounts match. Pure, so it is easy to reason about.
export type Kind = 'lmm' | 'legacy';
export type Destination = 'lmm' | 'legacy' | 'choose' | 'none';

export function decideDestination(kinds: readonly Kind[]): Destination {
  const lmm = kinds.includes('lmm');
  const legacy = kinds.includes('legacy');
  return lmm && legacy ? 'choose' : lmm ? 'lmm' : legacy ? 'legacy' : 'none';
}

const KEY = 'samuhia.lmmx.kinds';
/** What the link step found, kept for this browser session only so the app can offer "open my rent invoice instead". */
export function rememberKinds(kinds: readonly Kind[]): void { try { sessionStorage.setItem(KEY, JSON.stringify(kinds)); } catch { /* storage unavailable */ } }
export function recalledKinds(): Kind[] {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v.filter((k): k is Kind => k === 'lmm' || k === 'legacy') : [];
  } catch { return []; }
}
