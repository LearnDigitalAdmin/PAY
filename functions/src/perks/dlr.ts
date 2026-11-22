// Applies a HostPinnacle delivery report to the matching perks_smsLog row. Structural types only (no imports outside perks/).
import type { firestore } from "firebase-admin";
import { P } from "./types";

const FAIL = ["FAILED", "UNDELIVERED", "EXPIRED", "REJECTED"];
export async function perksDlr(db: firestore.Firestore, ev: { status: string; at: number; code: string | null; description: string | null }, dispatch: { ref?: string | null }): Promise<void> {
  const path = dispatch.ref || "";
  if (!path.startsWith(P.smsLog + "/") || path.split("/").length !== 2) return; // only ever touch our own log rows
  const ref = db.doc(path), snap = await ref.get();
  if (!snap.exists) return;
  const cur = snap.data() as { status?: string; delivery?: string };
  const patch: Record<string, unknown> = { delivery: ev.status, dlrAt: ev.at, dlrCode: ev.code, dlrDescription: ev.description };
  if (ev.status === "DELIVERED") { patch.deliveredAt = ev.at; if (cur.status === "FAILED") { patch.status = "SENT"; patch.error = null; } }
  else if (FAIL.includes(ev.status) && cur.status === "SENT" && cur.delivery !== "DELIVERED") { patch.status = "FAILED"; patch.error = `Not delivered: ${ev.description || ev.code || ev.status}`.slice(0, 300); }
  await ref.set(patch, { merge: true });
}
