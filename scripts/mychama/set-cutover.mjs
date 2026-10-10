#!/usr/bin/env node
// TRACK B — writes the cutover timestamp the V2 reconcile sweep keys on:  mychamaConfig/cutover { cutoverAt }  (PLOT project).
// Intents created at/after cutoverAt belong to reconcileMyChamaIntentsV2 (new key); older ones stay with the legacy sweep.
//   node scripts/mychama/set-cutover.mjs --project <plot-project-id>            # shows current value, writes nothing
//   node scripts/mychama/set-cutover.mjs --project <plot-project-id> --apply    # cutoverAt = now
//   node scripts/mychama/set-cutover.mjs --project <plot-project-id> --clear --apply   # rollback: V2 sweep goes idle
import { createRequire } from "node:module";
const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
const a = process.argv.slice(2);
const has = (n) => a.includes(`--${n}`);
const project = a[a.indexOf("--project") + 1];
if (!project || project.startsWith("--")) { console.error("ERROR: --project <plot-project-id> is required (this is the PLOT/PAY project, NOT mychama1)."); process.exit(1); }
if (project === "mychama1") { console.error("ERROR: mychama1 is the Chama project; the cutover doc lives in the plot project."); process.exit(1); }
admin.initializeApp({ projectId: project });
const ref = admin.firestore().doc("mychamaConfig/cutover");
const cur = (await ref.get()).data();
console.log("current:", cur ? JSON.stringify(cur) + `  (${new Date(cur.cutoverAt).toISOString()})` : "(none)");
if (!has("apply")) { console.log("dry run — pass --apply to write."); process.exit(0); }
if (has("clear")) { await ref.delete(); console.log("cleared."); }
else { const at = Date.now(); await ref.set({ cutoverAt: at, setAt: new Date(at).toISOString() }); console.log(`cutoverAt = ${at} (${new Date(at).toISOString()})`); }
