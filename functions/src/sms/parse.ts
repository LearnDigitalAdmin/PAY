// Tolerant parser for HostPinnacle callbacks. The exact payload shape is configured/documented by HostPinnacle and is NOT assumed:
// field names are matched case-insensitively against aliases, single events or arrays are accepted, and every raw payload is also
// stored in sms_dlr_inbox so aliases can be adjusted from real traffic.
import type { DeliveryStatus, DlrEvent } from "./types";

const A = {
  id: ["msgid", "messageid", "message_id", "transactionid", "transaction_id", "guid", "requestid", "request_id", "smsid", "uuid", "id"],
  mobile: ["mobile", "msisdn", "to", "destination", "recipient", "phone", "mobileno", "mobile_no", "number"],
  status: ["dlrstatus", "dlr_status", "deliverystatus", "delivery_status", "messagestatus", "message_status", "status", "state", "dlr"],
  code: ["errorcode", "error_code", "errcode", "err", "reasoncode", "reason_code", "code"],
  desc: ["description", "statusdesc", "status_desc", "reason", "errormessage", "error_message", "error", "remarks"],
  time: ["donetime", "done_time", "deliverytime", "delivery_time", "dlrtime", "timestamp", "time", "date", "senttime"],
  inboundText: ["message", "msg", "text", "sms", "content"], inboundFrom: ["from", "sender", "source"],
};
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const scalar = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : null);

/** First scalar whose key matches an alias (alias order = priority); looks one level into nested objects. */
export function pick(o: Obj, aliases: string[]): string | null {
  const lower: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) lower[k.toLowerCase()] = v;
  for (const a of aliases) { const s = scalar(lower[a]); if (s !== null) return s; }
  for (const v of Object.values(lower)) if (isObj(v)) { const s = pick(v, aliases); if (s !== null) return s; }
  return null;
}

export function normalizeStatus(raw: string | null): DeliveryStatus {
  const s = (raw || "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (!s) return "UNKNOWN";
  if (/^(DELIVRD|DELIVERED|DELIVERY_SUCCESS|DELIVERED_TO_HANDSET|DLVRD|SUCCESS_DELIVERED)$/.test(s)) return "DELIVERED";
  if (/^(UNDELIV|UNDELIVERED|UNDELIVERABLE|NOT_DELIVERED)$/.test(s)) return "UNDELIVERED";
  if (/^(EXPIRED|EXPIRD)$/.test(s)) return "EXPIRED";
  if (/^(REJECTD|REJECTED|REJECT)$/.test(s)) return "REJECTED";
  if (/^(FAILED|FAIL|FAILURE|ERROR|BLOCKED|DND|DELIVERY_FAILED)$/.test(s)) return "FAILED";
  if (/^(ENROUTE|ACCEPTD|ACCEPTED|SUBMITTED|QUEUED|SENT|PENDING|BUFFERED)$/.test(s)) return "SENT";
  return "UNKNOWN";
}
export function normalizeMobile(raw: string | null): string | null {
  if (!raw) return null;
  const d = raw.replace(/\D/g, "");
  if (/^0[17]\d{8}$/.test(d)) return "254" + d.slice(1);
  if (/^254[17]\d{8}$/.test(d)) return d;
  return d.length >= 9 ? d : null;
}
function parseTime(raw: string | null, now: number): number {
  if (!raw) return now;
  if (/^\d{10}$/.test(raw)) return Number(raw) * 1000;
  if (/^\d{13}$/.test(raw)) return Number(raw);
  const t = Date.parse(raw.replace(" ", "T"));
  return Number.isFinite(t) ? t : now;
}

/** Every id-like value anywhere in a send response, for matching later callbacks. */
export function extractProviderIds(raw: unknown, out = new Set<string>(), depth = 0): string[] {
  if (depth > 4 || raw === null || typeof raw !== "object") return [...out];
  if (Array.isArray(raw)) { for (const v of raw.slice(0, 50)) extractProviderIds(v, out, depth + 1); return [...out].slice(0, 20); }
  for (const [k, v] of Object.entries(raw as Obj)) {
    if (A.id.includes(k.toLowerCase())) { const s = scalar(v); if (s && s.length <= 80) out.add(s); }
    else if (v && typeof v === "object") extractProviderIds(v, out, depth + 1);
  }
  return [...out].slice(0, 20);
}

export interface ParsedCallback { events: DlrEvent[]; inbound: number; items: number }
function itemsOf(body: unknown, query: Obj): Obj[] {
  const lists: Obj[][] = [];
  const walk = (v: unknown, d: number) => {
    if (d > 3) return;
    if (Array.isArray(v)) { const objs = v.filter(isObj); if (objs.length) lists.push(objs); }
    else if (isObj(v)) for (const x of Object.values(v)) if (Array.isArray(x) || isObj(x)) walk(x, d + 1);
  };
  walk(body, 0);
  if (lists.length) return lists.flat();
  const merged: Obj = { ...query, ...(isObj(body) ? body : {}) };
  return Object.keys(merged).length ? [merged] : [];
}
export function parseCallback(input: { query?: Obj; body?: unknown }, now = Date.now()): ParsedCallback {
  const items = itemsOf(input.body, input.query || {});
  const events: DlrEvent[] = []; let inbound = 0;
  for (const it of items) {
    const statusRaw = pick(it, A.status);
    if (statusRaw === null && pick(it, A.inboundText) !== null && pick(it, A.inboundFrom) !== null) { inbound++; continue; }
    if (statusRaw === null && pick(it, A.id) === null) continue;
    const rawTime = pick(it, A.time);
    events.push({ providerId: pick(it, A.id), mobile: normalizeMobile(pick(it, A.mobile)), status: normalizeStatus(statusRaw), rawStatus: statusRaw || "",
      code: pick(it, A.code), description: pick(it, A.desc), at: parseTime(rawTime, now), rawTime });
  }
  return { events, inbound, items: items.length };
}
