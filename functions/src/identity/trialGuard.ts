/**
 * Trial-abuse guard: one person (one National ID, one phone) gets ONE account and ONE free trial.
 *
 *  - findExistingAccount()      non-scheduled helper. Given an ID number and/or phone, finds the account that already owns
 *                               them (spelling variants of the ID, every stored shape of the phone). Used at sign-up so a
 *                               repeat sign-up is sent back to the existing account instead of starting a new trial.
 *  - trialAlreadyClaimed()      / recordTrialClaims()   a ledger (trial_claims/*) that outlives the account, so deleting an
 *                               account and signing up again does not earn a second trial.
 *  - reconcileIdentityDuplicates  scheduled, once a day. Finds accounts that share an ID or phone (legacy data, agent-created
 *                               accounts, anything that slipped through), keeps the oldest / paying one as the primary, links
 *                               the others to it (duplicateOf), and ends the extra trials. It never deletes or merges data.
 */
import * as admin from "firebase-admin";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { nationalDigits, phoneStorageVariants } from "../phone/safaricom";

/** "12 345-678" / "0012345678" / "a1234567" -> "12345678" | "A1234567". Leading zeros are not significant in a National ID. */
export function normalizeIdKey(raw: unknown): string {
  const n = String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return /^\d+$/.test(n) ? n.replace(/^0+/, "") : n;
}
/** 701234567 / +254701234567 / 0701234567 -> "701234567" (the 9 national digits), "" when not a Kenyan mobile. */
export const normalizePhoneKey = (raw: unknown): string => nationalDigits(raw);

const claimId = (kind: "id" | "phone", key: string) => `${kind}_${key}`;

export interface ExistingAccount {
  uid: string;
  matchedBy: "id" | "phone";
  email?: string;
  emailHint: string;     // j***@gmail.com — enough to recognise it, not enough to harvest it
  isTrial: boolean;
  tier: string;
}

function maskEmail(email?: string): string {
  if (!email || !email.includes("@")) return "";
  const [name, domain] = email.split("@");
  return `${name.slice(0, 1)}${"*".repeat(Math.max(2, Math.min(name.length - 1, 5)))}@${domain}`;
}

function toExisting(doc: admin.firestore.QueryDocumentSnapshot | admin.firestore.DocumentSnapshot, by: "id" | "phone"): ExistingAccount {
  const d = (doc.data() ?? {}) as Record<string, any>;
  return { uid: doc.id, matchedBy: by, email: d.email, emailHint: maskEmail(d.email), isTrial: d.isTrial === true, tier: String(d.tier ?? "free") };
}

/**
 * The account that already owns this ID number or phone, or null. ID is checked first (users/{id} is the document id for
 * accounts made with a custom UID, then the stored id fields), then every stored shape of the phone.
 */
export async function findExistingAccount(
  db: admin.firestore.Firestore, p: { idNumber?: unknown; phone?: unknown },
): Promise<ExistingAccount | null> {
  const users = db.collection("users");
  const idKey = normalizeIdKey(p.idNumber);
  if (idKey) {
    // the raw spellings people actually type: "12345678", "012345678"
    for (const candidate of new Set([idKey, `0${idKey}`, String(p.idNumber ?? "").trim()])) {
      if (!candidate) continue;
      const snap = await users.doc(candidate).get();
      if (snap.exists) return toExisting(snap, "id");
    }
    const byField = await users.where("localId", "in", [idKey, `0${idKey}`, ...(Number(idKey) ? [Number(idKey)] : [])]).limit(1).get();
    if (!byField.empty) return toExisting(byField.docs[0], "id");
  }
  const variants = phoneStorageVariants(p.phone);
  if (variants.length) {
    const byPhone = await users.where("phone", "in", variants).limit(1).get();
    if (!byPhone.empty) return toExisting(byPhone.docs[0], "phone");
  }
  return null;
}

/** True when this ID or phone has already been given a trial (even if that account has since been deleted). */
export async function trialAlreadyClaimed(db: admin.firestore.Firestore, p: { idNumber?: unknown; phone?: unknown }): Promise<boolean> {
  const refs: admin.firestore.DocumentReference[] = [];
  const idKey = normalizeIdKey(p.idNumber), phoneKey = normalizePhoneKey(p.phone);
  if (idKey) refs.push(db.collection("trial_claims").doc(claimId("id", idKey)));
  if (phoneKey) refs.push(db.collection("trial_claims").doc(claimId("phone", phoneKey)));
  if (!refs.length) return false;
  const snaps = await db.getAll(...refs);
  return snaps.some((s) => s.exists);
}

export async function recordTrialClaims(db: admin.firestore.Firestore, p: { idNumber?: unknown; phone?: unknown; uid: string }): Promise<void> {
  const idKey = normalizeIdKey(p.idNumber), phoneKey = normalizePhoneKey(p.phone);
  const batch = db.batch();
  const base = { uid: p.uid, claimedAt: admin.firestore.FieldValue.serverTimestamp() };
  if (idKey) batch.set(db.collection("trial_claims").doc(claimId("id", idKey)), base, { merge: true });
  if (phoneKey) batch.set(db.collection("trial_claims").doc(claimId("phone", phoneKey)), base, { merge: true });
  await batch.commit();
}

interface Slim { id: string; createdMs: number; paying: boolean; isTrial: boolean; tokens: number; idKey: string; phoneKey: string; duplicateOf?: string }

/** The reconcile pass, separated from the schedule so it can be run from a test or a one-off call. */
export async function reconcileDuplicates(db: admin.firestore.Firestore, signupBonusTokens: number): Promise<{ scanned: number; groups: number; trialsEnded: number; linked: number }> {
  const PAGE = 500;
  const slim: Slim[] = [];
  let last: admin.firestore.QueryDocumentSnapshot | undefined;
  for (;;) {
    let q = db.collection("users").orderBy(admin.firestore.FieldPath.documentId()).limit(PAGE)
      .select("localId", "id", "phone", "createdAt", "isTrial", "tier", "type", "tokens", "duplicateOf");
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    for (const d of snap.docs) {
      const x = d.data() as Record<string, any>;
      const created = x.createdAt?.toMillis?.() ?? 0;
      slim.push({
        id: d.id, createdMs: created, isTrial: x.isTrial === true, tokens: Number(x.tokens) || 0,
        paying: x.isTrial !== true && String(x.tier ?? "free").toLowerCase() !== "free" && x.type === "paid",
        idKey: normalizeIdKey(x.localId ?? x.id ?? d.id), phoneKey: normalizePhoneKey(x.phone),
        duplicateOf: typeof x.duplicateOf === "string" ? x.duplicateOf : undefined,
      });
    }
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < PAGE) break;
  }

  // union accounts that share an ID key or a phone key
  const parent = new Map<string, string>();
  const find = (a: string): string => { while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a)!)!); a = parent.get(a)!; } return a; };
  slim.forEach((s) => parent.set(s.id, s.id));
  const seen = new Map<string, string>();
  for (const s of slim) {
    for (const key of [s.idKey && `id:${s.idKey}`, s.phoneKey && `ph:${s.phoneKey}`].filter(Boolean) as string[]) {
      const other = seen.get(key);
      if (other) parent.set(find(s.id), find(other)); else seen.set(key, s.id);
    }
  }
  const groups = new Map<string, Slim[]>();
  for (const s of slim) { const r = find(s.id); groups.set(r, [...(groups.get(r) ?? []), s]); }

  let groupCount = 0, trialsEnded = 0, linked = 0;
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    groupCount++;
    // primary: a paying account first, then the oldest
    const ordered = [...members].sort((a, b) => Number(b.paying) - Number(a.paying) || (a.createdMs || Infinity) - (b.createdMs || Infinity));
    const primary = ordered[0];
    await recordTrialClaims(db, { idNumber: primary.idKey, phone: primary.phoneKey, uid: primary.id });
    for (const dup of ordered.slice(1)) {
      if (dup.duplicateOf === primary.id && !dup.isTrial) continue;   // already handled on an earlier run
      const ref = db.collection("users").doc(dup.id);
      const update: Record<string, unknown> = {
        duplicateOf: primary.id, identityFlaggedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      if (dup.isTrial) {
        Object.assign(update, {
          tier: "free", type: "free", storage: false, isPremium: false, isTrial: false,
          trialEndedAt: admin.firestore.FieldValue.serverTimestamp(), trialRevokedReason: "duplicate_identity",
          tokens: Math.max(0, dup.tokens - signupBonusTokens),   // take back the signup gift, never below zero
        });
        trialsEnded++;
      }
      await ref.set(update, { merge: true });
      await db.collection("identity_flags").doc(dup.id).set({
        uid: dup.id, primaryUid: primary.id, trialEnded: dup.isTrial,
        sharedId: dup.idKey === primary.idKey && !!dup.idKey, sharedPhone: dup.phoneKey === primary.phoneKey && !!dup.phoneKey,
        flaggedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      linked++;
    }
  }
  return { scanned: slim.length, groups: groupCount, trialsEnded, linked };
}

/** Once a day, 03:30 Nairobi. */
export const reconcileIdentityDuplicates = onSchedule({
  schedule: "30 3 * * *",
  timeZone: "Africa/Nairobi",
  region: "us-central1",
  memory: "512MiB",
  timeoutSeconds: 540,
}, async () => {
  const bonus = 50;   // PMS_SIGNUP_FREE_TOKENS in index.ts
  const r = await reconcileDuplicates(admin.firestore(), bonus);
  console.log(`reconcileIdentityDuplicates: scanned ${r.scanned}, duplicate groups ${r.groups}, linked ${r.linked}, trials ended ${r.trialsEnded}`);
});
