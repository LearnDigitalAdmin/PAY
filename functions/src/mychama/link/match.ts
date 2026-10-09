// Finds the mychama1 member records that carry a given idKey (collection-group query on the indexed
// `members.idKey` field — see the Chama track-A patch). READ-ONLY.
import { mychamaDb, computePhoneKey, normalizeKePhone } from "../config";
import type { Candidate } from "./actions";

const KE_MOBILE = /^\+254[17]\d{8}$/;

export interface MatchResult { candidates: Candidate[]; ambiguousChamaIds: string[] }

export async function findCandidates(idKey: string): Promise<MatchResult> {
  const snap = await mychamaDb().collectionGroup("members").where("idKey", "==", idKey).limit(200).get();

  const perChama = new Map<string, Candidate[]>();
  const ambiguous = new Set<string>();
  for (const d of snap.docs) {
    const data = d.data();
    if (data.status !== "active") continue;                     // inactive/suspended/removed never link
    const chamaId = d.ref.parent.parent?.id;
    if (!chamaId) continue;
    const e164 = normalizeKePhone(String(data.phoneNormalized || data.phone || ""));
    if (!KE_MOBILE.test(e164)) continue;                         // no usable phone => cannot be proven, ever
    const list = perChama.get(chamaId) || [];
    list.push({ chamaId, memberId: d.id, phoneKey: computePhoneKey(e164), phoneE164: e164 });
    perChama.set(chamaId, list);
  }

  const candidates: Candidate[] = [];
  for (const [chamaId, list] of perChama) {
    if (list.length > 1) ambiguous.add(chamaId);                 // two members, one ID, same chama: never link
    else candidates.push(list[0]);
  }
  return { candidates, ambiguousChamaIds: [...ambiguous] };
}
