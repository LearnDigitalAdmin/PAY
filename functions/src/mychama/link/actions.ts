// PURE linking decisions (no Firebase imports): given the member records that carry the caller's idKey,
// the caller's existing links, and what phone proof exists right now, decide what to do.
// Rules (contract §5): silent link only on a verified-phone match; other phones go to `pending` (SMS
// code); per-phone grants; a link is bound to the phone it was proven on and drops to needs_reverify
// when the member's phone stops matching; vanished members are revoked.
import { makeLinkId, type LinkState, type LinkVerifiedVia } from "../contract";

export interface Candidate { chamaId: string; memberId: string; phoneKey: string; phoneE164: string }
export interface ExistingLink { linkId: string; state: LinkState; boundPhoneKey: string; verifiedVia: LinkVerifiedVia }

export interface LinkInputs {
  candidates: Candidate[];
  existing: ExistingLink[];
  /** HMAC key of the caller's Firebase-verified phone (null if none, e.g. email/password landlords). */
  verifiedPhoneKey: string | null;
  /** Phone keys just proven by an SMS code in THIS request (verifyCode only). */
  provenSmsPhoneKeys: string[];
}
export interface PendingGroup { phoneKey: string; phoneE164: string; candidates: Candidate[] }
export interface LinkActions {
  activate: Array<{ candidate: Candidate; via: LinkVerifiedVia; linkId: string }>;
  keep: string[];
  reverify: string[];
  revoke: string[];
  pending: PendingGroup[];
}

export function computeLinkActions(input: LinkInputs): LinkActions {
  const existingById = new Map(input.existing.map((l) => [l.linkId, l]));
  const out: LinkActions = { activate: [], keep: [], reverify: [], revoke: [], pending: [] };
  const pendingByPhone = new Map<string, PendingGroup>();
  const seen = new Set<string>();

  const addPending = (c: Candidate) => {
    const g = pendingByPhone.get(c.phoneKey) || { phoneKey: c.phoneKey, phoneE164: c.phoneE164, candidates: [] };
    g.candidates.push(c);
    pendingByPhone.set(c.phoneKey, g);
  };

  for (const c of input.candidates) {
    const linkId = makeLinkId(c.chamaId, c.memberId);
    seen.add(linkId);
    const ex = existingById.get(linkId);
    const proof: LinkVerifiedVia | null =
      input.verifiedPhoneKey && input.verifiedPhoneKey === c.phoneKey ? "firebase_phone"
      : input.provenSmsPhoneKeys.includes(c.phoneKey) ? "sms_code" : null;

    if (ex && (ex.state === "active" || ex.state === "needs_reverify") && ex.boundPhoneKey === c.phoneKey) {
      // Still the phone it was proven on (or the member's phone went back to it).
      if (ex.state === "active") out.keep.push(linkId);
      else out.activate.push({ candidate: c, via: ex.verifiedVia, linkId });
      continue;
    }
    if (proof) { out.activate.push({ candidate: c, via: proof, linkId }); continue; }
    if (ex && ex.state === "active") out.reverify.push(linkId);   // member's phone changed, no proof yet
    addPending(c);
  }

  for (const ex of input.existing) {
    if (!seen.has(ex.linkId) && ex.state !== "revoked") out.revoke.push(ex.linkId);
  }
  out.pending = [...pendingByPhone.values()];
  return out;
}
