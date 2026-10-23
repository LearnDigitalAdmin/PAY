// TRACK B — server-side validation for mychamaPayInitiate. Reads mychama1 only; writes nothing.
// Everything the client sends is treated as untrusted: ids are shape-checked BEFORE they are put
// into a Firestore path, and every target must belong to the member resolved from the caller's link.
import type * as admin from "firebase-admin";
import type { MyChamaPurpose, PayInitiateRequest } from "../contract";
import { myChamaError } from "../errors";
import { normalizeKePhone } from "../config";
import { checkSafaricomPhone } from "../../phone/safaricom";
import { MAX_GROSS_KES, MIN_NET_KES, round2 } from "./fees";

type Db = admin.firestore.Firestore;

/** chamas/{id}.settlementSplitKeyVersion === 2  <=>  settlementSplitCode belongs to the NEW (MyChama) Paystack
 *  account. Written by scripts/mychama/migrate-splits.mjs and by the Chama setup/approve callables
 *  (track-B-chama.patch). A split code without it belongs to the OLD account and must never be charged. */
export const SPLIT_KEY_VERSION = 2;

const PURPOSES: readonly MyChamaPurpose[] = ["contribution", "loan_repayment", "mgr_contribution"];
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CLIENT_REQUEST_ID = /^[A-Za-z0-9_-]{8,100}$/;
const EPS = 0.009;

export const isSafeId = (v: unknown): v is string => typeof v === "string" && SAFE_ID.test(v);
const bad = (m: string) => myChamaError("invalid_target", m, "invalid-argument");

// ───────────────────────── phone helpers (mirror Chama shared/phone.py) ─────────────────────────
export function localPhone(e164: string): string {
  const digits = (e164 || "").replace(/\D/g, "");
  return digits.startsWith("254") ? "0" + digits.slice(3) : digits;
}
export function detectProvider(raw: string): "mpesa" | "airtel" {
  return ["073", "075", "078"].includes(localPhone(normalizeKePhone(raw)).slice(0, 3)) ? "airtel" : "mpesa";
}
/** Valid = Kenyan mobile format AND a Safaricom prefix (shared rule: ../../phone/safaricom.ts). */
export const isValidKenyanPhone = (raw: string): boolean => /^\+254[17]\d{8}$/.test(normalizeKePhone(raw)) && checkSafaricomPhone(raw).ok;
/** The message to show for a rejected number (never empty). */
export const phoneRejectionMessage = (raw: string): string => { const c = checkSafaricomPhone(raw); return c.ok ? "A valid Safaricom phone number is required." : c.message; };

// ───────────────────────── request shape ─────────────────────────
export interface CleanRequest {
  chamaId: string;
  purpose: MyChamaPurpose;
  amount: number;
  clientRequestId: string;
  phone: string | null;
  contributionId: string | null;
  loanId: string | null;
  installmentNo: number | null;
  potId: string | null;
  potPeriod: number | null;
  arrearId: string | null;
}

const optId = (v: unknown, name: string): string | null => {
  if (v === undefined || v === null || v === "") return null;
  if (!isSafeId(v)) throw bad(`${name} is not valid.`);
  return v;
};
const optInt = (v: unknown, name: string): number | null => {
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 1_000_000) throw bad(`${name} is not valid.`);
  return v;
};

export function cleanRequest(d: Partial<PayInitiateRequest> | undefined): CleanRequest {
  const x = d || {};
  if (!isSafeId(x.chamaId)) throw bad("chamaId is required.");
  if (!PURPOSES.includes(x.purpose as MyChamaPurpose)) throw bad("A valid purpose is required.");
  if (typeof x.clientRequestId !== "string" || !CLIENT_REQUEST_ID.test(x.clientRequestId)) {
    throw bad("clientRequestId must be 8-100 characters (letters, digits, - or _).");
  }
  const amount = x.amount;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < MIN_NET_KES || round2(amount) !== amount) {
    throw myChamaError("invalid_amount", `amount must be at least KES ${MIN_NET_KES}, with at most 2 decimals.`, "invalid-argument");
  }
  if (x.phone !== undefined && x.phone !== null && typeof x.phone !== "string") {
    throw myChamaError("invalid_phone", "phone is not valid.", "invalid-argument");
  }
  return {
    chamaId: x.chamaId,
    purpose: x.purpose as MyChamaPurpose,
    amount,
    clientRequestId: x.clientRequestId,
    phone: typeof x.phone === "string" && x.phone.trim() ? x.phone.trim() : null,
    contributionId: optId(x.contributionId, "contributionId"),
    loanId: optId(x.loanId, "loanId"),
    installmentNo: optInt(x.installmentNo, "installmentNo"),
    potId: optId(x.potId, "potId"),
    potPeriod: optInt(x.potPeriod, "potPeriod"),
    arrearId: optId(x.arrearId, "arrearId"),
  };
}

export function assertGrossWithinLimit(gross: number): void {
  if (gross > MAX_GROSS_KES) {
    throw myChamaError("invalid_amount", `That amount is above the KES ${MAX_GROSS_KES.toLocaleString("en-KE")} mobile-money limit once fees are added.`, "invalid-argument");
  }
}

// ───────────────────────── target ownership / payability ─────────────────────────
export interface Target {
  contributionId: string | null;
  loanId: string | null;
  installmentNo: number | null;
  potId: string | null;
  potPeriod: number | null;
  arrearId: string | null;
}
const EMPTY: Target = { contributionId: null, loanId: null, installmentNo: null, potId: null, potPeriod: null, arrearId: null };

/** Returns ONLY the fields relevant to the purpose (anything else the client sent is dropped). */
export async function validateTarget(db: Db, chamaId: string, memberId: string, r: CleanRequest): Promise<Target> {
  if (r.purpose === "contribution") {
    if (!r.contributionId) throw bad("contributionId is required.");
    const snap = await db.doc(`chamas/${chamaId}/contributions/${r.contributionId}`).get();
    const c = snap.data();
    if (!snap.exists || !c || c.memberId !== memberId) throw bad("That contribution isn't yours.");
    if (c.closedAt || c.status === "paid" || (Number(c.amount) || 0) - (Number(c.paidAmount) || 0) <= EPS) {
      throw bad("That contribution has nothing left to pay.");
    }
    return { ...EMPTY, contributionId: r.contributionId };
  }

  if (r.purpose === "loan_repayment") {
    if (!r.loanId || r.installmentNo === null || r.installmentNo < 1) throw bad("loanId and installmentNo are required.");
    const snap = await db.doc(`chamas/${chamaId}/loans/${r.loanId}`).get();
    const loan = snap.data();
    if (!snap.exists || !loan || loan.memberId !== memberId) throw bad("That loan isn't yours.");
    if (!["active", "overdue"].includes(loan.status)) throw bad("That loan isn't open for repayment.");
    const inst = (Array.isArray(loan.schedule) ? loan.schedule : []).find((s: any) => s && s.n === r.installmentNo);
    if (!inst || inst.paid || (Number(inst.due) || 0) - (Number(inst.paidAmount) || 0) <= EPS) {
      throw bad("That instalment has nothing left to pay.");
    }
    return { ...EMPTY, loanId: r.loanId, installmentNo: r.installmentNo };
  }

  // mgr_contribution
  if (!r.potId) throw bad("potId is required.");
  const potSnap = await db.doc(`chamas/${chamaId}/mgrPots/${r.potId}`).get();
  const pot = potSnap.data();
  if (!potSnap.exists || !pot || pot.status !== "active") throw bad("That pot isn't collecting.");
  if (!Array.isArray(pot.memberIds) || !pot.memberIds.includes(memberId)) throw bad("You're not a member of that pot.");

  if (r.arrearId) {
    const aSnap = await db.doc(`chamas/${chamaId}/mgrPots/${r.potId}/arrears/${r.arrearId}`).get();
    const a = aSnap.data();
    if (!aSnap.exists || !a || a.memberId !== memberId || a.status !== "open" || (Number(a.amount) || 0) <= EPS) {
      throw bad("That arrear is no longer open.");
    }
    return { ...EMPTY, potId: r.potId, arrearId: r.arrearId };
  }

  if (r.potPeriod === null || r.potPeriod !== pot.period) throw bad("That pot period is no longer current.");
  const rec = await db.collection(`chamas/${chamaId}/mgrPots/${r.potId}/records`)
    .where("memberId", "==", memberId).where("period", "==", pot.period).limit(1).get();
  if (!rec.empty && rec.docs[0].data().status === "paid") throw bad("This period is already fully paid.");
  return { ...EMPTY, potId: r.potId, potPeriod: r.potPeriod };
}
