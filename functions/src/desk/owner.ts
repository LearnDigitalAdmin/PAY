// Who (if anyone) owns this customer on the desk? Read directly from the shared database.
import { customerDocId, DESK, deskDb } from "./db";
import type { DeskAgentDoc, DeskCustomerDoc, DeskOwner } from "./types";

const VALID_RANKS = ["clerk", "senior", "lead"];

/**
 * desk_customers/{entityKey} must name an `ownerAgentId`, must not be `selfOwned`, and the owner must be an `active`
 * desk_agents record with a payout subaccount in `agents/{id}.paymentInfo.accountId` (the main Paystack account).
 * Returns null when any of that is missing — the charge then simply carries no desk part.
 */
export async function resolveDeskOwner(entityKey: string): Promise<DeskOwner | null> {
  if (typeof entityKey !== "string" || !entityKey) return null;
  const db = deskDb();
  const cSnap = await db.collection(DESK.customers).doc(customerDocId(entityKey)).get();
  if (!cSnap.exists) return null;
  const c = cSnap.data() as Partial<DeskCustomerDoc>;
  if (typeof c.ownerAgentId !== "string" || !c.ownerAgentId || c.selfOwned === true) return null;

  const [dSnap, aSnap] = await Promise.all([
    db.collection(DESK.agents).doc(c.ownerAgentId).get(),
    db.collection("agents").doc(c.ownerAgentId).get(),
  ]);
  if (!dSnap.exists) return null;
  const d = dSnap.data() as Partial<DeskAgentDoc>;
  if (d.status !== "active" || typeof d.agentCode !== "string" || !d.agentCode) return null;
  if (typeof d.rank !== "string" || !VALID_RANKS.includes(d.rank)) return null;

  const sub = aSnap.exists ? (aSnap.data() as { paymentInfo?: { accountId?: unknown } }).paymentInfo?.accountId : undefined;
  if (typeof sub !== "string" || !sub.startsWith("ACCT_")) return null;
  return { agentId: c.ownerAgentId, agentCode: d.agentCode, rank: d.rank, subaccountCode: sub };
}
