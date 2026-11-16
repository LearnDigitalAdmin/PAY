import { COL } from "./config";
import { now, col, FV } from "./store";
import type { LeadDoc, RecipientDoc, TenantDoc } from "./types";

export const leadIdOf = (contactKey: string): string => `LD${contactKey.slice(0, 14)}`;
/** One lead per landlord contact. Called when a tenant of that landlord is activated. */
export async function upsertLead(r: RecipientDoc, t: TenantDoc): Promise<void> {
  const id = leadIdOf(r.contactKey);
  const ref = col(COL.leads).doc(id);
  const snap = await ref.get();
  if (!snap.exists) {
    const lead: LeadDoc = { leadId: id, contactKey: r.contactKey, displayNameEnc: r.contactNameEnc, contactPhoneEnc: r.contactPhoneEnc, tenants: 1, monthlyRentMinor: t.rent.amountMinor,
      deskCodes: [t.deskCode], stage: "new", notes: [], onPms: false, attributedDeskCode: t.deskCode, attributedDeskUid: t.deskUid, updatedAt: now(), createdAt: now() };
    await ref.create(JSON.parse(JSON.stringify(lead)));
    return;
  }
  await ref.update({ tenants: FV.increment(1), monthlyRentMinor: FV.increment(t.rent.amountMinor), deskCodes: FV.arrayUnion(t.deskCode), updatedAt: now() });
}
