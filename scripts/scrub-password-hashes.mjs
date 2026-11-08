// One-time cleanup: remove the legacy `passwordHash` field from every users/{uid} document.
//   Dry run (default):  node scripts/scrub-password-hashes.mjs
//   Apply:              node scripts/scrub-password-hashes.mjs --apply
// Needs Application Default Credentials for the project (gcloud auth application-default login) or GOOGLE_APPLICATION_CREDENTIALS.
// Run it AFTER the PMS release that stops using the cloud hash has reached your users: an older app version needs the field to
// sign in on a NEW device (it shows "Invalid account data" without it). Offline sign-in on a device that already has the account
// is not affected, because every device keeps its own local hash. Safe to re-run.
import { createRequire } from "node:module";
const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");

const apply = process.argv.includes("--apply");
admin.initializeApp(process.env.GCLOUD_PROJECT ? { projectId: process.env.GCLOUD_PROJECT } : undefined);
const db = admin.firestore();

let found = 0, cleared = 0, last = null;
for (;;) {
  let q = db.collection("users").orderBy("passwordHash").limit(400);          // only documents that HAVE the field
  if (!apply && last) q = q.startAfter(last);                                  // dry run does not delete, so it must page
  const snap = await q.get();
  if (snap.empty) break;
  found += snap.size;
  if (apply) {
    const batch = db.batch();
    snap.docs.forEach((d) => batch.update(d.ref, { passwordHash: admin.firestore.FieldValue.delete() }));
    await batch.commit();
    cleared += snap.size;
    console.log(`cleared ${cleared}`);
  } else {
    last = snap.docs[snap.docs.length - 1];
  }
}
console.log(apply ? `Done: removed passwordHash from ${cleared} user documents.` : `Dry run: ${found} user documents still carry passwordHash. Re-run with --apply to remove it.`);
