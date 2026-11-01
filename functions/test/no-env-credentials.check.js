// Guard: SMS (HostPinnacle) credentials come from Firebase secrets only. Fails if any source file reads HP_* / MYCHAMA_HP_* from the
// environment, and if any function that can reach an SMS sender forgets to bind the secrets.
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..", "src");
const files = []; (function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); f.isDirectory() ? walk(p) : p.endsWith(".ts") && files.push(p); } })(root);
let bad = 0; const fail = (m) => { console.error("FAIL", m); bad++; };
for (const f of files) {
  const t = fs.readFileSync(f, "utf8");
  if (/process\.env\.(MYCHAMA_)?HP_/.test(t) || /process\.env\[\s*["'`](MYCHAMA_)?HP_/.test(t) || /=\s*process\.env\s*;?\s*$/m.test(t) && /HP_SMS/.test(t)) fail(`${path.relative(root, f)} reads HostPinnacle credentials from the environment`);
}
const idx = fs.readFileSync(path.join(root, "index.ts"), "utf8");
for (const name of ["setupAccount", "paystackCallback"]) {
  const m = idx.match(new RegExp(`export const ${name} = on\\w+\\(\\{[\\s\\S]*?secrets:\\s*\\[([^\\]]*)\\]`));
  if (!m || !/HP_SECRETS/.test(m[1])) fail(`${name} does not bind ...HP_SECRETS`);
}
for (const [file, names] of [["lmm/index.ts", ["lmm_setupRecipient", "lmm_dailySweep"]], ["lmm/plan.ts", ["lmm_start", "lmm_pay"]]]) {
  const t = fs.readFileSync(path.join(root, file), "utf8");
  for (const n of names) { const m = t.match(new RegExp(`export const ${n} = on\\w+\\([\\s\\S]*?secrets:\\s*\\[([^\\]]*)\\]`)); if (!m || !/HP_SECRETS/.test(m[1])) fail(`${n} does not bind ...HP_SECRETS`); }
}
if (bad) process.exit(1); console.log("no-env-credentials: OK");
