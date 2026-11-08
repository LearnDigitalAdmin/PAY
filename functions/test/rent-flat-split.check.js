/* Pins rent fees to ONE table (rentFees.ts) and rent charges to the flat split.
 * Run:  cd functions && npm run build && node test/rent-flat-split.check.js   (exit 1 on failure) */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const src = (p) => fs.readFileSync(path.join(__dirname, "..", "src", p), "utf8");
const { conveniencePctForTier, rentFees } = require(path.join(__dirname, "..", "lib", "desk", "rentFees"));
let passed = 0, failed = 0;
const ok = (name, fn) => { try { fn(); passed++; console.log("  ✓", name); } catch (e) { failed++; console.error("  ✗", name, "\n", e); } };

ok("platform fee by plan: free/starter/solo 0.95, business 0.65, pro 0.4, enterprise 0.2; unknown 0.95", () => {
  const want = { free: 0.95, starter: 0.95, solo: 0.95, business: 0.65, pro: 0.4, professional: 0.4, enterprise: 0.2 };
  for (const [t, pct] of Object.entries(want)) assert.strictEqual(conveniencePctForTier(t), pct, t);
  for (const t of ["", "SOLO", " Pro ", undefined, null, "toString", "__proto__"]) assert.ok([0.95, 0.4].includes(conveniencePctForTier(t)), String(t));
  assert.strictEqual(conveniencePctForTier("toString"), 0.95); assert.strictEqual(conveniencePctForTier("__proto__"), 0.95);
});
ok("KES 10,000 rent: landlord receives 9,805 / 9,835 / 9,860 / 9,880 (starter / business / pro / enterprise)", () => {
  const net = (t) => rentFees(1_000_000, t).netPayoutMinor / 100;
  assert.deepStrictEqual(["starter", "business", "pro", "enterprise"].map(net), [9805, 9835, 9860, 9880]);
});
ok("no fee is capped: KES 100,000 rent at solo takes the full 0.95%", () => {
  assert.strictEqual(rentFees(10_000_000, "solo").convenienceMinor, 95_000);
});
ok("the legacy rent-take table, its KES 250 cap path and ./desk/rent are gone from src", () => {
  for (const f of fs.readdirSync(path.join(__dirname, "..", "src"), { recursive: true }).filter((n) => String(n).endsWith(".ts"))) {
    const t = src(String(f));
    assert.ok(!/RENT_TAKE_RATE_BY_TIER|rentRateForTier|planRentSplit|from "\.\/desk\/rent"|from "\.\/rent"/.test(t), `${f} still references the legacy rent table`);
  }
  assert.ok(!fs.existsSync(path.join(__dirname, "..", "src", "desk", "rent.ts")));
});
ok("setupAccount's subaccount percentage comes from the same table (fallback only)", () => {
  const t = src("index.ts");
  assert.ok(/const commissionRate = conveniencePctForTier\(userTier\);/.test(t));
  assert.ok(/percentage_charge: commissionRate/.test(t));
});
ok("a rent charge is always a flat split: split_code set, no subaccount or percentage on the charge itself", () => {
  const t = src("desk/rentCharge.ts");
  assert.ok(/split_code: splitCode/.test(t));
  const m = t.match(/split_code: splitCode[\s\S]{0,300}/)[0];
  assert.ok(!/percentage_charge|transaction_charge|bearer/.test(t), "rent charges must not carry a percentage or bearer");
  assert.ok(m.length > 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
