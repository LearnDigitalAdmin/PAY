// Creates lmm_config/standalone (the on/off and pause switches for standalone Lipa Mdogo Mdogo). Safe to re-run.
//   cd functions && node scripts/lmmx-seed.js              -> creates it OFF if missing, shows the state
//   cd functions && node scripts/lmmx-seed.js --enable     -> switch standalone ON
//   cd functions && node scripts/lmmx-seed.js --disable    -> switch it OFF (existing money still pays out)
//   cd functions && node scripts/lmmx-seed.js --pause      -> pause ALL standalone payouts   (--resume to undo)
// Needs application-default credentials:  gcloud auth application-default login   and  GOOGLE_CLOUD_PROJECT=plot-9fd6e
const admin = require("firebase-admin");
admin.initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT || "plot-9fd6e" });
(async () => {
  const ref = admin.firestore().collection("lmm_config").doc("standalone");
  const a = process.argv.slice(2);
  const snap = await ref.get();
  if (!snap.exists) await ref.set({ enabled: false, payoutsPaused: false, createdAt: Date.now() });
  const patch = {};
  if (a.includes("--enable")) patch.enabled = true; if (a.includes("--disable")) patch.enabled = false;
  if (a.includes("--pause")) patch.payoutsPaused = true; if (a.includes("--resume")) patch.payoutsPaused = false;
  if (Object.keys(patch).length) await ref.set({ ...patch, updatedAt: Date.now() }, { merge: true });
  const d = (await ref.get()).data();
  console.log("lmm_config/standalone:", { enabled: d.enabled, payoutsPaused: d.payoutsPaused });
})().catch((e) => { console.error(e); process.exit(1); });
