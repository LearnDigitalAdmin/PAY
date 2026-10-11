// Create-only desk facts and audit rows, plus the small pure helpers every webhook uses to build them.
import { DESK, deskDb } from "./db";
import type { Product } from "./config";
import type { DeskAuditEntry, DeskCommission, DeskEventDoc, DeskEventType } from "./types";

const TYPES: DeskEventType[] = ["sms_purchase", "subscription_payment", "report_purchase", "rent_payment", "refund"];
const PRODUCTS: Product[] = ["chama", "school", "pms"];
const isMinor = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const isPeriod = (s: unknown): boolean => typeof s === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

/** Same checks the desk events trigger applies — an event that would be rejected there is never written here. */
export function validateDeskEvent(e: DeskEventDoc): string | null {
  if (!e || typeof e !== "object") return "event is empty";
  if (typeof e.eventId !== "string" || !e.eventId || e.eventId.includes("/")) return "invalid eventId";
  if (!TYPES.includes(e.type)) return "unknown event type";
  if (!PRODUCTS.includes(e.product)) return "unknown product";
  if (typeof e.entityKey !== "string" || !e.entityKey) return "missing entityKey";
  if (typeof e.agentId !== "string" || !e.agentId) return "missing agentId";
  if (typeof e.paystackRef !== "string" || !e.paystackRef) return "missing paystackRef";
  if (!isMinor(e.grossMinor) || !isMinor(e.feeMinor) || e.feeMinor > e.grossMinor) return "invalid gross or fee";
  if (typeof e.agentSharePct !== "number" || !(e.agentSharePct >= 0 && e.agentSharePct < 100)) return "invalid agentSharePct";
  if (typeof e.paidAt !== "number" || !Number.isFinite(e.paidAt) || e.paidAt <= 0) return "invalid paidAt";
  if (e.type === "refund" && (typeof e.originalRef !== "string" || !e.originalRef)) return "refund without originalRef";
  if (e.periodMonth !== undefined && !isPeriod(e.periodMonth)) return "invalid periodMonth";
  return null;
}

/**
 * Create-only write to desk_events/{eventId}. "Already exists" is success (a replayed webhook), reported as `false`.
 * Throws on an invalid event or a transient Firestore error — callers decide whether that may block (it must never block a payment).
 */
export async function writeDeskEvent(event: DeskEventDoc): Promise<boolean> {
  const bad = validateDeskEvent(event);
  if (bad) throw new Error(`Invalid desk event ${event?.eventId ?? ""}: ${bad}`);
  const doc: Record<string, unknown> = { ...event };
  for (const k of Object.keys(doc)) if (doc[k] === undefined) delete doc[k];
  try {
    await deskDb().collection(DESK.events).doc(event.eventId).create(doc);
    return true;
  } catch (err) {
    const e = err as { code?: unknown; message?: string };
    if (e.code === 6 || e.code === "already-exists" || /already exists/i.test(e.message ?? "")) return false;
    throw err;
  }
}

/** Append-only audit row. Never throws: an audit failure must not break a payment path. Returns the row id or "". */
export async function writeDeskAudit(entry: DeskAuditEntry): Promise<string> {
  try {
    const ref = deskDb().collection(DESK.audit).doc();
    await ref.create({ ...entry, meta: entry.meta ?? {}, at: Date.now(), source: "pay" });
    return ref.id;
  } catch (err) {
    console.error("desk audit write failed:", entry.action, (err as Error)?.message);
    return "";
  }
}

/** "YYYY-MM" of an instant in Africa/Nairobi (UTC+3, no daylight saving). */
export function monthKeyEAT(ms: number): string {
  const d = new Date(ms + 3 * 3_600_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Entity keys look like "chama:SMC-0042", "school:<KNEC code>", "pms:<landlordCode>". */
export function productOfEntityKey(entityKey: unknown): Product | null {
  if (typeof entityKey !== "string") return null;
  const p = entityKey.split(":")[0];
  return p === "chama" || p === "school" || p === "pms" ? p : null;
}

const numeric = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

export interface PaystackMoneyFacts { grossMinor: number; feeMinor: number; paidAt: number }
/** The real gross and fee (minor units) and paid time from a Paystack charge.success `data` object. null when gross is unusable. */
export function paystackMoneyFacts(data: unknown, now = Date.now()): PaystackMoneyFacts | null {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const gross = numeric(d.amount);
  if (gross === null || !Number.isSafeInteger(gross) || gross < 0) return null;
  const feeRaw = numeric(d.fees);
  const fee = feeRaw !== null && Number.isSafeInteger(feeRaw) && feeRaw >= 0 ? feeRaw : 0;
  const paid = typeof d.paid_at === "string" ? Date.parse(d.paid_at) : NaN;
  return { grossMinor: gross, feeMinor: fee, paidAt: Number.isFinite(paid) && paid > 0 ? paid : now };
}

/** Validates the `deskCommission` object a charge stored on its pending document. null when it is absent or unusable. */
export function readDeskCommission(raw: unknown): DeskCommission | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const agentId = typeof c.agentId === "string" ? c.agentId : "";
  const agentCode = typeof c.agentCode === "string" ? c.agentCode : "";
  // Chama stores only the desk CODE (the id is looked up in desk_agents); the PAY-side charges store both.
  if (!agentId && !agentCode) return null;
  if (typeof c.entityKey !== "string" || !c.entityKey || !productOfEntityKey(c.entityKey)) return null;
  const share = numeric(c.sharePct);
  if (share === null || !(share >= 0 && share < 100)) return null;
  return {
    agentId,
    agentCode,
    sharePct: share,
    rule: typeof c.rule === "string" ? c.rule : "",
    entityKey: c.entityKey,
  };
}

/** desk_agents lookup by desk code (COG-0001 …). */
export async function findDeskAgentByCode(agentCode: string): Promise<{ agentId: string } | null> {
  if (typeof agentCode !== "string" || !agentCode) return null;
  const snap = await deskDb().collection(DESK.agents).where("agentCode", "==", agentCode).limit(1).get();
  if (snap.empty) return null;
  const d = snap.docs[0].data() as { agentId?: unknown };
  return { agentId: typeof d.agentId === "string" && d.agentId ? d.agentId : snap.docs[0].id };
}

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type EventOutcome = "written" | "duplicate" | "skipped" | "failed";

/**
 * writeDeskEvent for payment paths that must not be disturbed: retries a transient failure, and never throws.
 * An invalid event is skipped; a persistent failure is audited WITH the full event so it can be re-created by hand.
 */
export async function writeDeskEventResilient(event: DeskEventDoc, retryDelayMs = 250): Promise<EventOutcome> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return (await writeDeskEvent(event)) ? "written" : "duplicate";
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (/^Invalid desk event/.test(msg)) {
        console.error("Desk event rejected:", msg);
        await writeDeskAudit({ action: "desk_event_skipped", agentId: event.agentId, entityKey: event.entityKey, meta: { eventId: event.eventId, reason: msg } });
        return "skipped";
      }
      if (attempt === 3) {
        console.error("Desk event write failed after retries:", event.eventId, msg);
        await writeDeskAudit({ action: "desk_event_write_failed", agentId: event.agentId, entityKey: event.entityKey, meta: { eventId: event.eventId, event, error: msg.slice(0, 300) } });
        return "failed";
      }
      await pause(retryDelayMs * attempt);
    }
  }
  return "failed";
}
