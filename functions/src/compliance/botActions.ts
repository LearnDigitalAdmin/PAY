// Landlord Watch on WhatsApp: compliance reports through the existing bot endpoint (lwBotApi). The bot sends the owner's WhatsApp
// number as the actor; every call re-checks that the owner is connected and unlocked (an owner whose phone matches the property's
// owner phone is unlocked automatically). Prices, the free allowance and the checkout gate are the same as everywhere else: service.ts.
import type * as admin from "firebase-admin";
import type { Actor } from "../landlordWatch/actors";
import { LwError, type LwCode } from "../landlordWatch/errors";
import { parseOwnerId } from "../landlordWatch/service";
import { watchPrincipal } from "./access";
import { REPORT_REUSE_MS } from "./constants";
import { CrError, type CrCode } from "./errors";
import { reportsCol } from "./payments";
import * as svc from "./service";
import type { Deps as CrDeps } from "./service";

type Db = admin.firestore.Firestore;
type BotCtx = { deps: CrDeps; actor: Actor; lang: "en" | "sw" };

const CODE: Record<CrCode, LwCode> = {
  CR_BAD_REQUEST: "LW_BAD_MONTH", CR_NOT_FOUND: "LW_NOT_FOUND", CR_NO_DATA: "LW_REPORT_NO_DATA", CR_TOO_LARGE: "LW_UNAVAILABLE",
  CR_PAYMENT_FAILED: "LW_PAYMENT_FAILED", CR_UNAVAILABLE: "LW_UNAVAILABLE",
  CR_NOT_ALLOWED: "LW_NOT_ALLOWED",
};
/** The bot knows LW_* codes. "Unlock first" is LW_LOCKED so the bot offers its unlock flow. */
function toLw(e: unknown): unknown {
  if (!(e instanceof CrError)) return e;
  let code: LwCode = CODE[e.code];
  if (e.code === "CR_NOT_ALLOWED" && /unlock/i.test(e.message)) code = "LW_LOCKED";
  if (e.code === "CR_BAD_REQUEST" && /phone|safaricom|number/i.test(e.message)) code = "LW_PAYMENT_FAILED";   // not a month problem
  return new LwError(code, e.message);
}
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) { throw toLw(e); }
}

function ownerIdOf(data: { ownerId?: unknown }): string {
  try { return parseOwnerId(data.ownerId); } catch (e) { throw new LwError("LW_BAD_OWNER_ID", e instanceof Error ? e.message : "Enter an owner ID like PYP-0001."); }
}

/** The request shape the bot already understands for transcripts (requestId, state, url, expiresAt ...), plus the report's kind and name. */
export function shapeForBot(v: svc.OrderView, ownerId: string) {
  return {
    requestId: v.orderId, ownerId, month: v.month, kind: v.kind, title: v.title, state: v.state, priceKes: v.priceKes,
    // expiresAt = how long the report can still be asked for again (7 days from when it was made), not the life of the one-time link
    url: v.url, expiresAt: v.readyAt ? new Date(Date.parse(v.readyAt) + REPORT_REUSE_MS).toISOString() : undefined, fileName: v.fileName, message: v.message,
    error: v.error ?? undefined, createdAt: v.createdAt ?? new Date(0).toISOString(),
  };
}

/** An order the caller made: same actor, via Landlord Watch, and the owner must still be connected and unlocked. */
async function ownedOrder(db: Db, actor: Actor, orderId: unknown, nowMs: number) {
  const id = String(orderId ?? "");
  if (!/^[a-f0-9]{16}$/.test(id)) throw new CrError("CR_NOT_FOUND", "Report not found.");
  const d = (await reportsCol(db).doc(id).get()).data();
  if (!d || d.channel !== "watch" || d.actorKey !== actor.key || typeof d.ownerId !== "string") throw new CrError("CR_NOT_FOUND", "Report not found.");
  const { pr } = await watchPrincipal(db, actor, d.ownerId, nowMs);
  if (pr.landlordUid !== d.uid) throw new CrError("CR_NOT_FOUND", "Report not found.");
  return { pr, ownerId: d.ownerId as string };
}

export const REPORT_ACTIONS: Record<string, (ctx: BotCtx, data: any) => Promise<unknown>> = {
  reportQuote: ({ deps, actor }, data) => guarded(async () => {
    const ownerId = ownerIdOf(data);
    const { pr, propertyId } = await watchPrincipal(deps.db, actor, ownerId, deps.now().getTime());
    return svc.quote(deps, pr, { propertyId });
  }),
  reportOrder: ({ deps, actor }, data) => guarded(async () => {
    const ownerId = ownerIdOf(data);
    const { pr, propertyId } = await watchPrincipal(deps.db, actor, ownerId, deps.now().getTime());
    const v = await svc.createOrder(deps, pr, { propertyId, month: data.month, kind: data.kind });
    return shapeForBot(v, ownerId);
  }),
  reportCheckout: ({ deps, actor }, data) => guarded(async () => {
    const { pr, ownerId } = await ownedOrder(deps.db, actor, data.orderId, deps.now().getTime());
    return shapeForBot(await svc.checkout(deps, pr, { orderId: data.orderId, phone: data.phone }), ownerId);
  }),
  reportStatus: ({ deps, actor }, data) => guarded(async () => {
    const { pr, ownerId } = await ownedOrder(deps.db, actor, data.orderId, deps.now().getTime());
    return shapeForBot(await svc.status(deps, pr, { orderId: data.orderId }), ownerId);
  }),
  reportList: ({ deps, actor }, data) => guarded(async () => {
    const ownerId = ownerIdOf(data);
    const { pr, propertyId } = await watchPrincipal(deps.db, actor, ownerId, deps.now().getTime());
    const out = await svc.list(deps, pr, { propertyId });
    return { items: out.items.map((v) => { const s = shapeForBot(v, ownerId); delete s.url; return s; }) };   // a list never carries a link
  }),
};
