// Transports for Landlord Watch: Firebase callables (PMS, CYBER web) and one HTTPS endpoint (WhatsApp bot).
// Identical semantics; see LANDLORD_WATCH_CONTRACT.md section 7.
import * as admin from "firebase-admin";
import { defineSecret } from "firebase-functions/params";
import { onCall, onRequest, type CallableRequest } from "firebase-functions/v2/https";
import { checkSafaricomPhone } from "../phone/safaricom";
import { MYCHAMA_ID_PEPPER, REGION, plotDb } from "../mychama/config";
import { MYCHAMA_HP_SECRETS, sendHpSmsChecked } from "../mychama/sms";
import { PAYSTACK_SECRET_KEY } from "../desk/paystack";
import { type Actor, actorFromBot, actorFromCallable } from "./actors";
import { LwError, toBotError, toHttpsError } from "./errors";
import { safeEqual } from "./keys";
import { defaultOtpDeps } from "./otp";
import { htmlToPdf } from "./pdf";
import { paystackPort, settleTranscriptPayment } from "./payments";
import * as svc from "./service";
import type { Ctx, Deps } from "./service";
import type { Lang } from "./types";

/** Shared with the WhatsApp bot through Secret Manager (same project). Create it once:  firebase functions:secrets:set LW_BOT_API_KEY */
export const LW_BOT_API_KEY = defineSecret("LW_BOT_API_KEY");

const SECRETS = [MYCHAMA_ID_PEPPER, ...MYCHAMA_HP_SECRETS, PAYSTACK_SECRET_KEY];

export function defaultDeps(): Deps {
  return {
    db: plotDb(),
    otp: defaultOtpDeps(sendHpSmsChecked),
    now: () => new Date(),
    pdf: htmlToPdf,
    storage: {
      async save(path, data) {
        await admin.storage().bucket().file(path).save(data, { contentType: "application/pdf", resumable: false });
      },
      async signedUrl(path, ttlMs) {
        const [url] = await admin.storage().bucket().file(path).getSignedUrl({ version: "v4", action: "read", expires: Date.now() + ttlMs });
        return url;
      },
    },
    paystack: paystackPort,
    checkPhone: checkSafaricomPhone,
    settle: settleTranscriptPayment,
  };
}

type Handler = (ctx: Ctx, data: any) => Promise<unknown>;
export const ACTIONS: Record<string, Handler> = {
  lookupProperty: svc.lookupProperty,
  connect: svc.connect,
  disconnect: svc.disconnect,
  listConnections: (ctx) => svc.listConnections(ctx),
  unlockSendOtp: svc.unlockSendOtp,
  unlockVerifyOtp: svc.unlockVerifyOtp,
  getSnapshot: svc.getSnapshot,
  transcriptQuota: svc.transcriptQuota,
  transcriptStart: svc.transcriptStart,
  transcriptResendOtp: svc.transcriptResendOtp,
  transcriptVerifyOtp: svc.transcriptVerifyOtp,
  transcriptPay: svc.transcriptPay,
  transcriptStatus: svc.transcriptStatus,
  transcriptList: svc.transcriptList,
};

const langOf = (data: unknown): Lang => ((data as { lang?: unknown } | null)?.lang === "sw" ? "sw" : "en");

/** Runs one action for an actor. Exposed for tests (inject fake deps). */
export async function runAction(action: string, actor: Actor, data: Record<string, unknown>, deps: Deps): Promise<unknown> {
  const handler = ACTIONS[action];
  if (!handler) throw new LwError("LW_NOT_ALLOWED", "Unknown action.");
  return handler({ deps, actor, lang: langOf(data) }, data);
}

const LIGHT = { region: REGION, secrets: SECRETS, memory: "512MiB" as const, timeoutSeconds: 60, maxInstances: 20 };
// Generating a PDF needs Chromium: more memory and time, and fewer concurrent instances.
const HEAVY = { region: REGION, secrets: SECRETS, memory: "2GiB" as const, timeoutSeconds: 150, maxInstances: 5 };

function callable(action: string, opts: typeof LIGHT | typeof HEAVY = LIGHT) {
  return onCall(opts, async (req: CallableRequest<Record<string, unknown>>) => {
    try {
      const data = (req.data ?? {}) as Record<string, unknown>;
      const deps = defaultDeps();
      const actor = await actorFromCallable(deps.db, req, data.channel);
      return await runAction(action, actor, data, deps);
    } catch (e) {
      throw toHttpsError(e);
    }
  });
}

export const lwLookupProperty = callable("lookupProperty");
export const lwConnect = callable("connect");
export const lwDisconnect = callable("disconnect");
export const lwListConnections = callable("listConnections");
export const lwUnlockSendOtp = callable("unlockSendOtp");
export const lwUnlockVerifyOtp = callable("unlockVerifyOtp");
export const lwGetSnapshot = callable("getSnapshot");
export const lwTranscriptQuota = callable("transcriptQuota");
export const lwTranscriptStart = callable("transcriptStart");
export const lwTranscriptResendOtp = callable("transcriptResendOtp");
export const lwTranscriptVerifyOtp = callable("transcriptVerifyOtp", HEAVY);
export const lwTranscriptPay = callable("transcriptPay");
export const lwTranscriptStatus = callable("transcriptStatus", HEAVY);
export const lwTranscriptList = callable("transcriptList");

/** WhatsApp bot endpoint: POST { action, actor: { phone }, ...params } with header x-lw-key. */
export const lwBotApi = onRequest({ ...HEAVY, secrets: [...SECRETS, LW_BOT_API_KEY], cors: false }, async (req, res) => {
  if (req.method !== "POST") { res.status(405).json({ ok: false, error: { code: "LW_NOT_ALLOWED", message: "POST only." } }); return; }
  const key = String(req.get("x-lw-key") ?? "");
  if (!key || !safeEqual(key, LW_BOT_API_KEY.value())) { res.status(401).json({ ok: false, error: { code: "LW_NOT_ALLOWED", message: "Unauthorized." } }); return; }
  try {
    const body = (req.body ?? {}) as { action?: string; actor?: { phone?: string } } & Record<string, unknown>;
    const { action, actor: a, ...params } = body;
    const actor = actorFromBot(a?.phone);
    const data = await runAction(String(action ?? ""), actor, params, defaultDeps());
    res.status(200).json({ ok: true, data });
  } catch (e) {
    res.status(200).json({ ok: false, error: toBotError(e) });
  }
});
