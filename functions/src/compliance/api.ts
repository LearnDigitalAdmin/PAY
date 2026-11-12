// Entry points. Callables for the PMS app (the landlord's own account, and Landlord Watch for owners) and one key-protected
// HTTPS endpoint for the desk delegate. Prices and permissions are decided here and in service.ts, never by the caller.
import * as admin from "firebase-admin";
import { onCall, onRequest, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { REGION, plotDb } from "../mychama/config";
import { checkSafaricomPhone } from "../phone/safaricom";
import { BUNDLE_SECRETS, bundleSecret } from "../secretsBundle";
import { actorFromCallable } from "../landlordWatch/actors";
import { safeEqual } from "../landlordWatch/keys";
import { paystackPort } from "../landlordWatch/payments";
import { parseOwnerId } from "../landlordWatch/service";
import { watchPrincipal } from "./access";
import { CrError, toBotError, toHttpsError } from "./errors";
import { createPdfRenderer, htmlToPdfOnce } from "./pdf";
import * as svc from "./service";
import type { Deps, Principal } from "./service";

/** Shared with the PMS functions (the desk delegate) through the secrets bundle: add CR_SERVER_KEY to app-secrets-bundle. */
export const CR_SERVER_KEY = bundleSecret("CR_SERVER_KEY");
const DESK_LINK_TTL_MS = 7 * 24 * 3_600_000 - 60_000;      // a signed URL can last at most 7 days

export function defaultDeps(): Deps {
  return {
    db: plotDb(),
    now: () => new Date(),
    pdf: htmlToPdfOnce,
    storage: {
      async save(path, data) { await admin.storage().bucket().file(path).save(data, { contentType: "application/pdf", resumable: false }); },
      async signedUrl(path, ttlMs) { const [url] = await admin.storage().bucket().file(path).getSignedUrl({ version: "v4", action: "read", expires: Date.now() + ttlMs }); return url; },
    },
    paystack: paystackPort,
    checkPhone: checkSafaricomPhone,
  };
}
export { createPdfRenderer };

type Db = admin.firestore.Firestore;
/** The landlord's users/{id}: the auth uid itself, a landlord custom claim, or users.firebaseAuthUid (same mapping as the Firestore rules). */
export async function resolveLandlordId(db: Db, auth: NonNullable<CallableRequest<unknown>["auth"]>): Promise<string> {
  const claim = auth.token as Record<string, unknown>;
  if (claim.role === "landlord" && typeof claim.agentId === "string" && claim.agentId) {
    if ((await db.collection("users").doc(claim.agentId).get()).exists) return claim.agentId;
  }
  const byAuth = await db.collection("users").where("firebaseAuthUid", "==", auth.uid).limit(1).get();
  if (!byAuth.empty) return byAuth.docs[0].id;
  if ((await db.collection("users").doc(auth.uid).get()).exists) return auth.uid;
  throw new CrError("CR_NOT_ALLOWED", "No landlord account found for this sign-in.");
}

/** Who is asking and whose records. "watch" = a property owner using Landlord Watch: connected, unlocked, and the property is fixed by the owner ID. */
export async function principalFor(db: Db, req: CallableRequest<Record<string, unknown>>, data: Record<string, unknown>, now = Date.now()): Promise<{ pr: Principal; propertyId: string | null }> {
  if (!req.auth) throw new CrError("CR_NOT_ALLOWED", "Please sign in.");
  if (data.channel === "watch") {
    let ownerId: string;
    try { ownerId = parseOwnerId(data.ownerId); } catch (e) { throw new CrError("CR_BAD_REQUEST", e instanceof Error ? e.message : "Enter an owner ID like PYP-0001."); }
    const actor = await actorFromCallable(db, req, undefined);
    const { pr, propertyId } = await watchPrincipal(db, actor, ownerId, now);
    return { pr, propertyId };
  }
  const uid = await resolveLandlordId(db, req.auth);
  return { pr: { channel: "pms", actorKey: `u_${req.auth.uid}`, landlordUid: uid }, propertyId: null };
}

const LIGHT = { region: REGION, secrets: BUNDLE_SECRETS, memory: "512MiB" as const, timeoutSeconds: 60, maxInstances: 20 };
const HEAVY = { region: REGION, secrets: BUNDLE_SECRETS, memory: "2GiB" as const, timeoutSeconds: 180, maxInstances: 5 };      // Chromium

function callable(run: (deps: Deps, pr: Principal, data: Record<string, unknown>, propertyId: string | null) => Promise<unknown>, opts: typeof LIGHT | typeof HEAVY = LIGHT) {
  return onCall(opts, async (req: CallableRequest<Record<string, unknown>>) => {
    try {
      const data = (req.data ?? {}) as Record<string, unknown>;
      const deps = defaultDeps();
      const { pr, propertyId } = await principalFor(deps.db, req, data, deps.now().getTime());
      return await run(deps, pr, data, propertyId);
    } catch (e) { throw toHttpsError(e); }
  });
}
const withProperty = (data: Record<string, unknown>, propertyId: string | null) => (propertyId ? { ...data, propertyId } : data);

export const crQuote = callable((d, pr, data, pid) => svc.quote(d, pr, withProperty(data, pid) as { propertyId: unknown }));
export const crOrder = callable((d, pr, data, pid) => svc.createOrder(d, pr, withProperty(data, pid) as Parameters<typeof svc.createOrder>[2]));
export const crCheckout = callable((d, pr, data) => svc.checkout(d, pr, data as { orderId: unknown; phone?: unknown }));
export const crStatus = callable((d, pr, data) => svc.status(d, pr, data as { orderId: unknown }), HEAVY);
export const crList = callable((d, pr, data, pid) => svc.list(d, pr, withProperty(data, pid) as { propertyId?: unknown }));

/** Desk delegate -> here. POST { action, uid, propertyId?, month?, kind?, ticketId?, agentId? } with header x-cr-key. */
export const crServerApi = onRequest({ ...HEAVY, cors: false }, async (req, res) => {
  if (req.method !== "POST") { res.status(405).json({ ok: false, error: { code: "CR_NOT_ALLOWED", message: "POST only." } }); return; }
  const key = String(req.get("x-cr-key") ?? "");
  if (!key || !safeEqual(key, CR_SERVER_KEY.value())) { res.status(401).json({ ok: false, error: { code: "CR_NOT_ALLOWED", message: "Unauthorized." } }); return; }
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const deps = defaultDeps();
    const uid = String(b.uid ?? "");
    if (!uid) throw new CrError("CR_BAD_REQUEST", "Missing landlord.");
    let data: unknown;
    if (b.action === "deskPreview") data = await svc.deskPreview(deps, { uid, propertyId: b.propertyId, month: b.month, kind: b.kind });
    else if (b.action === "deskGenerate") data = await svc.createPaidDeskOrder(deps, { uid, propertyId: String(b.propertyId ?? ""), month: String(b.month ?? ""), kind: b.kind, ticketId: String(b.ticketId ?? ""), agentId: String(b.agentId ?? "") }, DESK_LINK_TTL_MS);
    else throw new CrError("CR_BAD_REQUEST", "Unknown action.");
    res.status(200).json({ ok: true, data });
  } catch (e) { res.status(200).json({ ok: false, error: toBotError(e) }); }
});
export { HttpsError };
