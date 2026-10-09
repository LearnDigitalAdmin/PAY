// READ-ONLY access to mychama1 for one (chama, member). Per-section try/catch: a failing section comes
// back as null (never 0) and is named in `failed`. Nothing here ever writes to mychama1.
import type * as admin from "firebase-admin";
import { mychamaDb } from "../config";
import * as P from "../paths";
import type { ChamaDataSection } from "../contract";
import type { PotBundle, RawContribution, RawLoan, RawMgrArrear, RawMgrPayout, RawMgrRecord, RawPot } from "./compute";

type Doc = admin.firestore.DocumentData;

export interface ChamaMemberRead {
  chama: { name: string; plan: string; status: string; settlementSplitCode: string };
  member: { status: string; role: string; phoneNormalized: string };
  contributions: RawContribution[] | null;
  loans: RawLoan[] | null;
  pots: PotBundle[] | null;
  failed: ChamaDataSection[];
}

/** Throws if the chama or member document itself cannot be read (that is a whole-chama failure). */
export async function readChamaForMember(chamaId: string, memberId: string): Promise<ChamaMemberRead> {
  const db = mychamaDb();
  const [chamaSnap, memberSnap] = await Promise.all([db.doc(P.chama(chamaId)).get(), db.doc(P.member(chamaId, memberId)).get()]);
  if (!chamaSnap.exists || !memberSnap.exists) throw new Error("chama or member document missing");
  const c: Doc = chamaSnap.data() || {};
  const m: Doc = memberSnap.data() || {};

  const failed: ChamaDataSection[] = [];

  const contributions = await section("contributions", failed, async () => {
    const snap = await db.collection(P.contributions(chamaId)).where("memberId", "==", memberId).get();
    return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Doc) }) as RawContribution);
  });

  const loans = await section("loans", failed, async () => {
    const snap = await db.collection(P.loans(chamaId)).where("memberId", "==", memberId).get();
    return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Doc) }) as RawLoan);
  });

  const pots = await section("mgr", failed, async () => {
    // array-contains alone needs no composite index; status is filtered in code.
    const potSnap = await db.collection(P.mgrPots(chamaId)).where("memberIds", "array-contains", memberId).get();
    const bundles: PotBundle[] = [];
    for (const pd of potSnap.docs) {
      const pot = { id: pd.id, ...(pd.data() as Doc) } as RawPot;
      if (pot.status !== "active") continue;
      const [recs, pays, arrs] = await Promise.all([
        db.collection(P.mgrRecords(chamaId, pd.id)).where("memberId", "==", memberId).get(),
        db.collection(P.mgrPayouts(chamaId, pd.id)).where("memberId", "==", memberId).get(),
        db.collection(P.mgrArrears(chamaId, pd.id)).where("memberId", "==", memberId).get(),
      ]);
      bundles.push({
        pot,
        records: recs.docs.map((d) => d.data() as RawMgrRecord),
        payouts: pays.docs.map((d) => d.data() as RawMgrPayout),
        arrears: arrs.docs.map((d) => ({ id: d.id, ...(d.data() as Doc) }) as RawMgrArrear),
      });
    }
    return bundles;
  });

  return {
    chama: { name: String(c.name || ""), plan: String(c.plan || "free"), status: String(c.status || "active"), settlementSplitCode: String(c.settlementSplitCode || "") },
    member: { status: String(m.status || ""), role: String(m.role || "member"), phoneNormalized: String(m.phoneNormalized || "") },
    contributions, loans, pots, failed,
  };
}

async function section<T>(name: ChamaDataSection, failed: ChamaDataSection[], fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    failed.push(name);
    console.error(`mychama sync: section ${name} failed:`, (e as Error)?.message || e);
    return null;
  }
}
