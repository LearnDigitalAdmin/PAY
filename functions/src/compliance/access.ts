// Who may order and download reports for a property through Landlord Watch: a connected owner whose details are unlocked.
import type * as admin from "firebase-admin";
import { getUnlock, readConnections, type Actor } from "../landlordWatch/actors";
import { resolveOwner } from "../landlordWatch/data";
import { CrError } from "./errors";
import type { Principal } from "./service";

type Db = admin.firestore.Firestore;

export async function watchPrincipal(db: Db, actor: Actor, ownerId: string, nowMs: number): Promise<{ pr: Principal; propertyId: string }> {
  const ref = await resolveOwner(db, ownerId);
  if (!ref) throw new CrError("CR_NOT_FOUND", "No property found for that owner ID.");
  if (actor.channel === "cyber") throw new CrError("CR_NOT_ALLOWED", "Reports are not available on CYBER.");
  if (!(await readConnections(db, actor))[ownerId]) throw new CrError("CR_NOT_ALLOWED", "Connect this property first.");
  if (!(await getUnlock(db, actor, ref.ownerPhone, nowMs)).unlocked) throw new CrError("CR_NOT_ALLOWED", "Unlock this property with your phone code first.");
  return { pr: { channel: "watch", actorKey: actor.key, landlordUid: ref.userId, ownerId }, propertyId: ref.propertyId };
}
