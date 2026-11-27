/* Pins rent fees to ONE table (rentFees.ts) and rent charges to the flat split.
 * Run:  cd functions && npm run build && node test/rent-flat-split.check.js   (exit 1 on failure) */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const src = (p) => fs.readFileSync(path.join(__dirname, "..", "src", p), "utf8");
const { conveniencePctForTier, rentFees } = require(path.join(__dirname, "..", "lib", "desk", "rentFees"));
let passed = 0, failed = 0;
const ok = (name, fn) => { try { fn(); passed++; console.log("  ✓", name); } catch (e) { failed++; console.error("  ✗", name, "\n", e); } };

ok("platform fee by plan (schedule v2): free 0.75, solo 0.5, business 0.4, pro 0.25, enterprise 0.15; retired starter/low and unknown pay the free rate", () => {
  const want = { free: 0.75, solo: 0.5, business: 0.4, pro: 0.25, professional: 0.25, enterprise: 0.15, starter: 0.75, low: 0.75 };
  for (const [t, pct] of Object.entries(want)) assert.strictEqual(conveniencePctForTier(t), pct, t);
  for (const t of ["", undefined, null, "toString", "__proto__", "constructor"]) assert.strictEqual(conveniencePctForTier(t), 0.75, String(t));
  assert.strictEqual(conveniencePctForTier("SOLO"), 0.5); assert.strictEqual(conveniencePctForTier(" Pro "), 0.25);
});
ok("the Starter plan has no row in the schedule", () => {
  const { CONVENIENCE_PCT_BY_TIER } = require(path.join(__dirname, "..", "lib", "desk", "rentFees"));
  assert.deepStrictEqual(Object.keys(CONVENIENCE_PCT_BY_TIER).sort(), ["business", "enterprise", "free", "pro", "professional", "solo"]);
});
ok("KES 10,000 rent: account holder receives 9,825 / 9,850 / 9,860 / 9,875 / 9,885 (free / solo / business / pro / enterprise)", () => {
  const net = (t) => rentFees(1_000_000, t).netPayoutMinor / 100;
  assert.deepStrictEqual(["free", "solo", "business", "pro", "enterprise"].map(net), [9825, 9850, 9860, 9875, 9885]);
  // PMS src/services/accounting/feeSchedule.ts is pinned to these SAME numbers in its own test
});
ok("KES 100,000 rent: the tenant surcharge is capped at 150, so the account holder's Paystack share is 1,350 (not 1,000)", () => {
  const f = rentFees(10_000_000, "solo");
  assert.deepStrictEqual([f.tenantFeeMinor, f.paystackEstimateMinor, f.landlordPaystackMinor, f.convenienceMinor, f.collectionCostMinor],
    [15_000, 150_000, 135_000, 50_000, 185_000]);
});
ok("collection cost is stored on the charge record and the transaction document (what PMS cuts from an agency's commission)", () => {
  const t = src("desk/rentCharge.ts");
  assert.ok(/collectionCostMinor: fees\.collectionCostMinor, feeVersion: RENT_FEE_SCHEDULE_VERSION/.test(t));
  assert.ok(/collectionCost: fees\.collectionCostMinor \/ 100/.test(t));
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
