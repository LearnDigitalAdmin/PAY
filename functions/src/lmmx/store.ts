import * as admin from "firebase-admin";
import { COL } from "./config";
import { sha256 } from "./crypto";
import { canonicalJson } from "./contract";
import type { AuditAction } from "./contract";
import { alertOps } from "../lmm/alert";

export const db = (): admin.firestore.Firestore => { if (!admin.apps.length) admin.initializeApp(); return admin.firestore(); };
export const col = (n: string) => db().collection(n);
export const FV = admin.firestore.FieldValue;
export type Tx = admin.firestore.Transaction;
export const now = (): number => Date.now();

export interface AuditInput {
  action: AuditAction; actor: { type: "desk" | "top" | "tenant" | "system" | "bot"; deskCode?: string; uid?: string; ip?: string };
  tenantId?: string; summary: string; detail?: Record<string, unknown>;
}
const pad10 = (n: number) => String(n).padStart(10, "0");

/** Append-only, hash-chained audit row. head = lmmx_audit_meta/head. Never throws (an audit failure must not stop a payment), but logs loudly. */
export async function audit(e: AuditInput): Promise<void> {
  try {
    await db().runTransaction(async (tx) => {
      const headRef = col(COL.auditMeta).doc("head");
      const head = (await tx.get(headRef)).data() as { seq: number; hash: string } | undefined;
      const seq = (head?.seq ?? 0) + 1;
      const prevHash = head?.hash ?? "GENESIS";
      const row = { seq, ts: now(), action: e.action, actor: { type: e.actor.type, deskCode: e.actor.deskCode ?? null, uid: e.actor.uid ?? null, ip: e.actor.ip ?? null },
        tenantId: e.tenantId ?? null, summary: e.summary.slice(0, 300), detail: e.detail ?? {}, prevHash };
      const hash = sha256(prevHash + canonicalJson(row));
      tx.create(col(COL.audit).doc(pad10(seq)), { ...row, hash });
      tx.set(headRef, { seq, hash });
    });
  } catch (err) { console.error("LMMX audit write failed:", e.action, (err as Error)?.message); }
}

/** Recompute the chain over a range. */
export async function verifyAudit(fromSeq = 1, toSeq = Number.MAX_SAFE_INTEGER): Promise<{ ok: boolean; checked: number; brokenAtSeq?: number }> {
  let prev = fromSeq <= 1 ? "GENESIS" : String((await col(COL.audit).doc(pad10(fromSeq - 1)).get()).data()?.hash ?? "");
  let checked = 0;
  const snap = await col(COL.audit).where("seq", ">=", fromSeq).where("seq", "<=", toSeq).orderBy("seq").limit(5000).get();
  for (const d of snap.docs) {
    const { hash, ...row } = d.data() as Record<string, unknown> & { hash: string; seq: number };
    if (row.prevHash !== prev || sha256(prev + canonicalJson(row)) !== hash) return { ok: false, checked, brokenAtSeq: row.seq };
    prev = hash; checked++;
  }
  return { ok: true, checked };
}

/** Append-only ledger rows, written inside the caller's transaction. */
export function ledger(tx: Tx, rows: { tenantId: string; cycleId?: string; type: string; amountMinor: number; direction: "in" | "out"; ref: string }[]): void {
  for (const r of rows) tx.set(col(COL.ledger).doc(), { ...r, createdAt: now() });
}

export type AlertK = Parameters<typeof alertOps>[0];
export const alert = (kind: AlertK, detail: string): Promise<boolean> => alertOps(kind, detail);

/** lmm_config/standalone: { enabled (default false), payoutsPaused }. Firestore can only PAUSE; every number is in code. Cached 20 s. */
let flagCache: { at: number; v: { enabled: boolean; payoutsPaused: boolean } } | null = null;
export async function flags(): Promise<{ enabled: boolean; payoutsPaused: boolean }> {
  if (flagCache && now() - flagCache.at < 20_000) return flagCache.v;
  const d = (await col(COL.config).doc("standalone").get()).data() ?? {};
  const v = { enabled: d.enabled === true, payoutsPaused: d.payoutsPaused === true };
  flagCache = { at: now(), v };
  return v;
}
export const clearFlagCache = (): void => { flagCache = null; };

/** Fixed-window counter. Returns false when over the limit. */
export async function rateOk(key: string, max: number, windowMs: number): Promise<boolean> {
  const bucket = Math.floor(now() / windowMs);
  const ref = col(COL.rate).doc(`${sha256(key).slice(0, 40)}_${bucket}`);
  return db().runTransaction(async (tx) => {
    const n = (((await tx.get(ref)).data()?.n as number | undefined) ?? 0) + 1;
    if (n > max) return false;
    tx.set(ref, { n, exp: (bucket + 2) * windowMs });
    return true;
  });
}
