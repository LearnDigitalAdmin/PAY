// Typed wrapper over the lmmx_tenant_* callables (contract section 4). With VITE_LMMX_MOCK=true every op is answered from
// mock.ts, so the whole app can be tried without CORE. Errors carry PAY's `details.lmmx` code as `.lmmx`.
import { httpsCallable } from 'firebase/functions';
import { functions } from '../Firebase';
import type { LmmxCallableMap, LmmxErrorCode } from './contract';
import { mockCall } from './mock';

export type TenantOp = Extract<keyof LmmxCallableMap, `lmmx_tenant_${string}`>;
export const isMock = (): boolean => import.meta.env.VITE_LMMX_MOCK === 'true';

export class LmmxApiError extends Error {
  lmmx?: LmmxErrorCode;
  /** Optional extras PAY may add to `details` (not in the contract): tries left on a wrong code. */
  attemptsLeft?: number;
  /** True when no answer came back at all (offline, timeout), as opposed to PAY refusing. */
  network: boolean;
  constructor(message: string, lmmx?: LmmxErrorCode, attemptsLeft?: number, network = false) {
    super(message);
    this.name = 'LmmxApiError';
    this.lmmx = lmmx;
    this.attemptsLeft = attemptsLeft;
    this.network = network;
  }
}

export async function lmmx<K extends TenantOp>(op: K, data: LmmxCallableMap[K]['in']): Promise<LmmxCallableMap[K]['out']> {
  if (isMock()) return (await mockCall(op, data as Record<string, unknown>)) as LmmxCallableMap[K]['out'];
  try {
    const res = await httpsCallable<LmmxCallableMap[K]['in'], LmmxCallableMap[K]['out']>(functions, op)(data);
    return res.data;
  } catch (e) {
    const err = e as { code?: string; message?: string; details?: { lmmx?: LmmxErrorCode; attemptsLeft?: number } };
    const network = !err.details?.lmmx && (err.code === 'functions/unavailable' || err.code === 'functions/deadline-exceeded' || !err.code);
    throw new LmmxApiError(err.message || 'Request failed', err.details?.lmmx, err.details?.attemptsLeft, network);
  }
}

/** The text a tenant should read for any failure. */
export function errorMessage(e: unknown, table: Partial<Record<LmmxErrorCode, string>>, fallback: string): string {
  if (e instanceof LmmxApiError) {
    if (e.lmmx && table[e.lmmx]) return table[e.lmmx] as string;
    if (e.network) return 'We could not reach the server. Check your internet and try again.';
  }
  return fallback;
}
