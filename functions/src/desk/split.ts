// Paystack percentage splits for desk charges. Cached in `desk_split_codes` under the SAME key and document shape as the
// desk kernel's paystack/splits.ts, so CYBER, PAY and PMS share entries. Never use the legacy splitCodes/{agentId} cache.
import { createHash } from "crypto";
import axios from "axios";
import { DESK, deskDb } from "./db";
import { PAYSTACK_API_BASE, PAYSTACK_SECRET_KEY } from "./paystack";
import { toBps } from "./money";

export interface SplitSub { subaccount: string; sharePct: number }

/** Stable cache key: same subaccounts + same shares (to 0.01%) -> same Paystack split code. */
export function splitKey(subs: readonly SplitSub[]): string {
  const canon = [...subs].map((s) => `${s.subaccount}:${toBps(s.sharePct)}`).sort().join("|");
  return createHash("sha256").update(canon).digest("hex").slice(0, 32);
}

/** Every share in (0,100), total < 100 (the main account keeps the remainder), subaccounts start ACCT_. */
export function validateSplit(subs: readonly SplitSub[]): void {
  if (subs.length === 0) throw new Error("Split needs at least one subaccount");
  let total = 0;
  for (const s of subs) {
    if (typeof s.subaccount !== "string" || !s.subaccount.startsWith("ACCT_")) throw new Error("Invalid Paystack subaccount code");
    if (!(s.sharePct > 0 && s.sharePct < 100)) throw new Error("Split share must be between 0 and 100");
    total += toBps(s.sharePct);
  }
  if (total >= 10000) throw new Error("Split shares leave nothing for the platform");
}

/**
 * Get or create a Paystack percentage split (bearer "all-proportional": the fee is shared in proportion, so every party
 * receives its share of the amount AFTER Paystack's real fee). The main account takes the remainder.
 */
export async function getOrCreateDeskSplit(subs: readonly SplitSub[], label: string): Promise<string> {
  validateSplit(subs);
  const key = splitKey(subs);
  const ref = deskDb().collection(DESK.splitCodes).doc(key);
  const cached = await ref.get();
  const hit = cached.exists ? (cached.data() as { splitCode?: unknown }).splitCode : undefined;
  if (typeof hit === "string" && hit) return hit;

  const res = await axios.post(`${PAYSTACK_API_BASE}/split`, {
    name: `Desk ${label} ${key.slice(0, 8)}`.slice(0, 100),
    type: "percentage",
    currency: "KES",
    subaccounts: subs.map((s) => ({ subaccount: s.subaccount, share: s.sharePct })),
    bearer_type: "all-proportional",
  }, { timeout: 15_000, headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY.value()}`, "Content-Type": "application/json" } });
  const splitCode = res.data?.status ? res.data?.data?.split_code : undefined;
  if (typeof splitCode !== "string" || !splitCode) throw new Error(`Could not create split: ${res.data?.message ?? "no split code returned"}`);

  try {
    await ref.create({ splitCode, subs: subs.map((s) => ({ ...s })), label, createdAt: Date.now() });
    return splitCode;
  } catch (err) {
    if ((err as { code?: number }).code === 6) { // a concurrent request cached first: use the stored code
      const again = (await ref.get()).data() as { splitCode?: string } | undefined;
      if (again?.splitCode) return again.splitCode;
    }
    throw err;
  }
}
