// TRACK B — client-request idempotency, SAME collection/doc shape as Chama
// functions/shared/idempotency.py:  chamas/{chamaId}/idempotencyKeys/{clientRequestId}
//   reserve  -> { status:"pending", createdAt }
//   done     -> { status:"done", result, createdAt, expiresAt }   (7-day TTL)
// so a retry from ANY surface (Chama app, CYBER, PAY portal) dedupes on one key.
//
// Two deliberate improvements over the Python helper (decision C):
//   * the key can be RELEASED when the work fails (a retry would otherwise be refused as
//     "already being processed" forever);
//   * a `pending` placeholder older than STALE_PENDING_MS (a crashed instance) can be taken over.
import type * as admin from "firebase-admin";

export const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Callable timeout is 60 s and the Paystack call 20 s, so 3 minutes safely means "that attempt is dead". */
export const STALE_PENDING_MS = 3 * 60 * 1000;

export type Reservation =
  | { kind: "reserved" }
  | { kind: "replay"; result: Record<string, unknown> }
  | { kind: "in_flight" };

const keyRef = (db: admin.firestore.Firestore, chamaId: string, key: string) =>
  db.doc(`chamas/${chamaId}/idempotencyKeys/${key}`);

export async function reserveKey(db: admin.firestore.Firestore, chamaId: string, key: string): Promise<Reservation> {
  const ref = keyRef(db, chamaId, key);
  return db.runTransaction(async (tx): Promise<Reservation> => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const d = snap.data() || {};
      if (d.status === "done") return { kind: "replay", result: (d.result as Record<string, unknown>) || {} };
      if (Date.now() - (Number(d.createdAt) || 0) < STALE_PENDING_MS) return { kind: "in_flight" };
      // stale placeholder: the earlier attempt died — fall through and take it over
    }
    tx.set(ref, { status: "pending", createdAt: Date.now() });
    return { kind: "reserved" };
  });
}

export async function recordResult(
  db: admin.firestore.Firestore, chamaId: string, key: string, result: Record<string, unknown>
): Promise<void> {
  const now = Date.now();
  await keyRef(db, chamaId, key).set({ status: "done", result, createdAt: now, expiresAt: now + IDEMPOTENCY_TTL_MS });
}

/** Best-effort: never throws (called from error paths). */
export async function releaseKey(db: admin.firestore.Firestore, chamaId: string, key: string): Promise<void> {
  try {
    await keyRef(db, chamaId, key).delete();
  } catch (e) {
    console.error("mychamaPayInitiate: could not release idempotency key (non-fatal)", (e as Error)?.message);
  }
}
