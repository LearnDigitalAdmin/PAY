/* Static regressions for the W3-A text/constant changes.  Run: node functions/test/desk-static.check.js */
const fs = require("fs"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..", "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (["node_modules", "lib", "dist", ".git"].includes(e.name)) continue;
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel, out); else out.push(rel);
  }
  return out;
}
let failed = 0;
const ok = (n, f) => { try { f(); console.log("  ✓", n); } catch (e) { failed++; console.error("  ✗", n, "\n", e.message); } };
const idx = read("functions/src/index.ts");

ok("no 'cogvana' left in functions/src, src, public, docs, README, index.html", () => {
  const files = [...walk("functions/src"), ...walk("src"), ...walk("public"), ...walk("docs"), "README.md", "index.html"].filter((f) => !/\.(png|jpe?g|ico|woff2?|webp|svg)$/i.test(f));
  const hits = files.filter((f) => /cogvana/i.test(fs.readFileSync(path.join(root, f), "utf8")));
  assert.deepStrictEqual(hits, []);
});
ok("signup grant is the named constant PMS_SIGNUP_FREE_TOKENS = 50", () => {
  assert.match(idx, /const PMS_SIGNUP_FREE_TOKENS = 50;/);
  assert.match(idx, /firestoreUserData\.tokens = PMS_SIGNUP_FREE_TOKENS/);
  assert.doesNotMatch(idx, /tokens = 100/);
});
ok("the hard-coded 2.5 cut is gone from chargeCustomer and handleCyberCharge", () => {
  assert.doesNotMatch(idx, /commissionRate = 2\.5/); assert.doesNotMatch(idx, /netAfterPaystack \* 2\.5/); assert.doesNotMatch(idx, /commissionRate: 2\.5/);
  assert.match(idx, /getDeskConfig\(\)\)\.platformCutPct/);
});
ok("the legacy splitCodes cache is not used by the desk module", () => {
  for (const f of walk("functions/src/desk")) assert.doesNotMatch(fs.readFileSync(path.join(root, f), "utf8"), /["'`]splitCodes["'`]/);
});
console.log(failed ? `${failed} failed` : "all passed"); process.exit(failed ? 1 : 0);
