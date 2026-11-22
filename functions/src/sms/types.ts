// Shared SMS delivery-tracking types. Product-agnostic: any product (Perks, LMM, MyChama, DESK...) can plug in.
export type DeliveryStatus = "UNKNOWN" | "SENT" | "DELIVERED" | "FAILED" | "UNDELIVERED" | "EXPIRED" | "REJECTED";
export const FAILURE_STATUSES: DeliveryStatus[] = ["FAILED", "UNDELIVERED", "EXPIRED", "REJECTED"];

export interface DlrEvent {
  providerId: string | null; mobile: string | null; status: DeliveryStatus; rawStatus: string;
  code: string | null; description: string | null; at: number; rawTime: string | null;
}
/** What we remember about one accepted send. The message BODY is never stored (it can contain OTPs): length and a short hash only. */
export interface DispatchDoc {
  id: string; product: string; ref: string | null; mobile: string; providerId: string | null; msgLen: number; msgHash: string;
  delivery: DeliveryStatus; createdAt: number; expireAt: number; rawResponse: string;
  dlrAt?: number; dlrCode?: string | null; dlrDescription?: string | null; matchedBy?: string;
}
export const SMS_COLL = { dispatch: "sms_dispatch", inbox: "sms_dlr_inbox", events: "sms_dlr_events" } as const;
export const RETENTION_MS = 90 * 24 * 3600 * 1000;
export type ProductHandler = (event: DlrEvent, dispatch: DispatchDoc) => Promise<void>;
