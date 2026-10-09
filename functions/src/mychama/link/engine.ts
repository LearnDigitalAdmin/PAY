// Linking engine: plan (read-only) and apply (writes under chamaLinks/{uid}/links in the plot DB only).
import { MYCHAMA_PATHS, type ChamaLinkDoc, type LinkState } from "../contract";
import { computeIdKey, computePhoneKey, maskPhone, mychamaDb, plotDb } from "../config";
import * as P from "../paths";
import type { Caller } from "../sync/identity";
import { computeLinkActions, type ExistingLink, type LinkActions } from "./actions";
import { findCandidates } from "./match";
import { pendingIdFor } from "./crypto";

export interface PendingView { pendingId: string; phoneKey: string; phoneE164: string; maskedPhone: string; chamaCount: number }

export interface LinkPlan {
  actions: LinkActions;
  existing: ChamaLinkDoc[];
  ambiguousChamaIds: string[];
  noId: boolean;
}

/** Read-only: what would the link pass do right now? */
export async function planLinkPass(caller: Caller, provenSmsPhoneKeys: string[] = []): Promise<LinkPlan> {
  const existing = await readLinks(caller.uid);
  const idKey = computeIdKey(caller.idNumber);
  if (!idKey) {
    // No usable ID: nothing to match. Existing links are left exactly as they are.
    return { actions: { activate: [], keep: existing.filter((l) => l.state === "active").map((l) => l.linkId), reverify: [], revoke: [], pending: [] }, existing, ambiguousChamaIds: [], noId: true };
  }
  const { candidates, ambiguousChamaIds } = await findCandidates(idKey);
  const verifiedPhoneKey = caller.verifiedPhoneE164 ? computePhoneKey(caller.verifiedPhoneE164) : null;
  const ex: ExistingLink[] = existing.map((l) => ({ linkId: l.linkId, state: l.state, boundPhoneKey: l.boundPhoneKey, verifiedVia: l.verifiedVia }));
  const actions = computeLinkActions({ candidates, existing: ex, verifiedPhoneKey, provenSmsPhoneKeys });
  return { actions, existing, ambiguousChamaIds, noId: false };
}

export interface LinkPassResult {
  active: ChamaLinkDoc[];
  needsReverify: ChamaLinkDoc[];
  pending: PendingView[];
  activatedForPhoneKeys: Record<string, number>;
  ambiguousCount: number;
  noId: boolean;
}

/** Plan, then persist the decisions. Never writes to mychama1. */
export async function runLinkPass(caller: Caller, provenSmsPhoneKeys: string[] = []): Promise<LinkPassResult> {
  const plan = await planLinkPass(caller, provenSmsPhoneKeys);
  const { actions } = plan;
  const db = plotDb();
  const now = Date.now();
  const byId = new Map(plan.existing.map((l) => [l.linkId, l]));
  const batch = db.batch();
  const activatedForPhoneKeys: Record<string, number> = {};

  if (actions.activate.length > 0) {
    const names = await chamaNames(actions.activate.map((a) => a.candidate.chamaId));
    for (const a of actions.activate) {
      const prev = byId.get(a.linkId);
      const doc: ChamaLinkDoc = {
        linkId: a.linkId, uid: caller.uid, chamaId: a.candidate.chamaId, memberId: a.candidate.memberId,
        chamaName: names.get(a.candidate.chamaId) || prev?.chamaName || "",
        state: "active", verifiedVia: a.via, boundPhoneKey: a.candidate.phoneKey,
        boundPhoneMasked: maskPhone(a.candidate.phoneE164),
        linkedAt: prev && prev.state !== "revoked" ? prev.linkedAt : now, updatedAt: now,
      };
      batch.set(db.doc(MYCHAMA_PATHS.link(caller.uid, a.linkId)), doc);
      byId.set(a.linkId, doc);
      activatedForPhoneKeys[a.candidate.phoneKey] = (activatedForPhoneKeys[a.candidate.phoneKey] || 0) + 1;
    }
  }
  const setState = (ids: string[], state: LinkState) => {
    for (const id of ids) {
      const prev = byId.get(id);
      if (!prev || prev.state === state) continue;
      batch.update(db.doc(MYCHAMA_PATHS.link(caller.uid, id)), { state, updatedAt: now });
      byId.set(id, { ...prev, state, updatedAt: now });
    }
  };
  setState(actions.reverify, "needs_reverify");
  setState(actions.revoke, "revoked");
  if (actions.activate.length || actions.reverify.length || actions.revoke.length) await batch.commit();

  const all = [...byId.values()];
  return {
    active: all.filter((l) => l.state === "active"),
    needsReverify: all.filter((l) => l.state === "needs_reverify"),
    pending: pendingViews(caller.uid, actions),
    activatedForPhoneKeys,
    ambiguousCount: plan.ambiguousChamaIds.length,
    noId: plan.noId,
  };
}

export function pendingViews(uid: string, actions: LinkActions): PendingView[] {
  return actions.pending.map((g) => ({
    pendingId: pendingIdFor(uid, g.phoneKey), phoneKey: g.phoneKey, phoneE164: g.phoneE164,
    maskedPhone: maskPhone(g.phoneE164), chamaCount: g.candidates.length,
  }));
}

async function readLinks(uid: string): Promise<ChamaLinkDoc[]> {
  const snap = await plotDb().collection(MYCHAMA_PATHS.links(uid)).get();
  return snap.docs.map((d) => d.data() as ChamaLinkDoc);
}

async function chamaNames(chamaIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(chamaIds)];
  if (unique.length === 0) return out;
  try {
    const db = mychamaDb();
    const snaps = await db.getAll(...unique.map((id) => db.doc(P.chama(id))));
    for (const s of snaps) if (s.exists) out.set(s.id, String(s.data()?.name || ""));
  } catch (e) {
    console.error("mychama link: chama name lookup failed:", (e as Error)?.message || e);   // cosmetic only
  }
  return out;
}
