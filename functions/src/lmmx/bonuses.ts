// Desk bonuses are desk_ledger payables ({kind:"bonus", status:"payable"}): the top desk pays them from its existing payables screen.
import * as crypto from "crypto";
import { col } from "./store";

export async function payableBonus(p: { deskUid: string; amountMinor: number; note: string; parts: readonly string[] }): Promise<boolean> {
  const entryId = crypto.createHash("sha256").update(p.parts.join("|")).digest("hex").slice(0, 28);   // same id rule as DESK kernel/ledger.ts
  try {
    await col("desk_ledger").doc(entryId).create({ entryId, agentId: p.deskUid, kind: "bonus", amountMinor: p.amountMinor, status: "payable", note: p.note.slice(0, 200), createdAt: Date.now() });
    return true;
  } catch (e) { if ((e as { code?: number }).code === 6) return false; throw e; }
}
