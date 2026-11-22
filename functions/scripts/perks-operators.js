// Sets who may use the Perks operator screens: Firestore doc perks_config/operators = { uids: [...] }. Safe to re-run.
//   cd functions && node scripts/perks-operators.js                 -> show the list
//   cd functions && node scripts/perks-operators.js add <uid>       -> allow a Firebase Auth uid
//   cd functions && node scripts/perks-operators.js remove <uid>    -> remove it
// Find the uid in Firebase Console > Authentication. Needs: gcloud auth application-default login  and  GOOGLE_CLOUD_PROJECT=plot-9fd6e
const admin = require("firebase-admin");
admin.initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT || "plot-9fd6e" });
(async () => {
  const [cmd, uid] = process.argv.slice(2);
  const ref = admin.firestore().doc("perks_config/operators");
  const cur = ((await ref.get()).data() || {}).uids || [];
  let next = cur;
  if (cmd === "add" || cmd === "remove") {
    if (!uid || !/^[A-Za-z0-9]{10,64}$/.test(uid)) throw new Error("give a Firebase Auth uid, e.g. node scripts/perks-operators.js add AbC123...");
    next = cmd === "add" ? [...new Set([...cur, uid])] : cur.filter((u) => u !== uid);
    await ref.set({ uids: next, updatedAt: Date.now() }, { merge: true });
  } else if (cmd) throw new Error("usage: perks-operators.js [add|remove <uid>]");
  console.log("perks_config/operators uids:", next);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
