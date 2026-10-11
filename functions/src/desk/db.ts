// Shared Firestore handle and collection names for the desk module.
// CYBER, PAY and PMS share ONE Firebase project and ONE database, so desk's collections are read and written directly.
import * as admin from "firebase-admin";

/** Collection names — identical to DESK_COLLECTIONS in the desk kernel's contract.ts (only the ones PAY touches). */
export const DESK = {
  config: "desk_config",
  agents: "desk_agents",
  customers: "desk_customers",
  audit: "desk_audit",
  events: "desk_events",
  splitCodes: "desk_split_codes",
} as const;

/** The project's default Firestore (the same one index.ts calls `db`). */
export function deskDb(): admin.firestore.Firestore {
  if (!admin.apps.length) admin.initializeApp();
  return admin.firestore();
}

/** desk_customers document id for an entity key (the kernel replaces "/" so keys are valid ids). */
export const customerDocId = (entityKey: string): string => entityKey.replace(/\//g, "_");
