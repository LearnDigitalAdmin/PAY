/* Desk money kernel port — the kernel's vectors, exact.
 * Run:  cd functions && npm run build && node test/desk-money.check.js   (exit 1 on failure) */
const assert = require("assert");
const path = require("path");
const lib = (p) => require(path.join(__dirname, "..", "lib", "desk", p));
const M = lib("money");
const { DEFAULT_DESK_CONFIG: cfg, mergeConfig } = lib("config");
const R = lib("rent");

const RF = lib("rentFees");
let passed = 0, failed = 0;
const ok = (name, fn) => { try { fn(); passed++; console.log("  ✓", name); } catch (e) { failed++; console.error("  ✗", name, "\n", e); } };

ok("floorPct2 never overpays and survives float artefacts", () => {
  assert.strictEqual(M.floorPct2(71.03), 71.03);
  assert.strictEqual(M.floorPct2(71.039999), 71.03);
  assert.strictEqual(M.floorPct2(0.375 * 100 / 100), 0.37);
});
ok("toBps", () => { assert.strictEqual(M.toBps(97.5), 9750); assert.strictEqual(M.toBps(71.03), 7103); assert.strictEqual(M.toBps(0.45), 45); });
ok("service 97.5: gross 20000 fee 300 -> agent 19207", () => {
  const plan = M.servicePlan(cfg);
  assert.strictEqual(plan.agentSharePct, 97.5);
  assert.strictEqual(M.settledAmounts({ grossMinor: 20000, feeMinor: 300, agentSharePct: plan.agentSharePct }).agentMinor, 19207);
});
ok("SMS first purchase: gross 15000, 214 credits, cost 20 -> share 71.03", () => {
  const p = M.smsPlan({ grossMinor: 15000, credits: 214, firstPurchaseEligible: true }, cfg);
  assert.deepStrictEqual(p, { agentSharePct: 71.03, rule: "sms_first_purchase" });
});
ok("SMS standard: gross 50000, 714 credits -> agent within 2 minor units of 15737", () => {
  const p = M.smsPlan({ grossMinor: 50000, credits: 714, firstPurchaseEligible: false }, cfg);
  assert.strictEqual(p.rule, "sms_standard");
  const expectedFee = Math.round(50000 * cfg.expectedPaystackFeePct / 100);
  const s = M.settledAmounts({ grossMinor: 50000, feeMinor: expectedFee, agentSharePct: p.agentSharePct });
  assert.ok(Math.abs(s.agentMinor - 15737) <= 2, `agent ${s.agentMinor}`);
});
ok("SMS: first-purchase rule needs eligibility AND gross under the threshold; no margin -> 0", () => {
  assert.strictEqual(M.smsPlan({ grossMinor: 25000, credits: 300, firstPurchaseEligible: true }, cfg).rule, "sms_standard");
  assert.deepStrictEqual(M.smsPlan({ grossMinor: 1000, credits: 500, firstPurchaseEligible: true }, cfg), { agentSharePct: 0, rule: "no_margin" });
});
ok("subscription: senior 30% on gross 99900 fee 1499 -> 29520", () => {
  const plan = M.sharePlan("senior", "subscription", cfg);
  assert.strictEqual(plan.agentSharePct, 30);
  assert.strictEqual(M.settledAmounts({ grossMinor: 99900, feeMinor: 1499, agentSharePct: 30 }).agentMinor, 29520);
  assert.strictEqual(M.sharePlan("clerk", "report", cfg).agentSharePct, 25);
});
ok("rent 800000 at 1.5% -> landlord 98.5, agent 0.6, platform 0.9", () => {
  const take = M.rentTake(800000, 1.5, cfg);
  assert.strictEqual(take, 12000);
  const p = M.rentPlan({ rentMinor: 800000, takeMinor: take }, cfg);
  assert.deepStrictEqual([p.landlordSharePct, p.agentSharePct, p.platformSharePct], [98.5, 0.6, 0.9]);
});
ok("rent 2000000 at 2% is capped at KES 250 -> landlord 98.75, agent 0.5", () => {
  const take = M.rentTake(2000000, 2, cfg);
  assert.strictEqual(take, 25000);
  const p = M.rentPlan({ rentMinor: 2000000, takeMinor: take }, cfg);
  assert.strictEqual(p.landlordSharePct, 98.75); assert.strictEqual(p.agentSharePct, 0.5);
});
ok("rent tier table: ENTERPRISE 0.7 PRO 1.2 BUSINESS 1.6 SOLO 2.0; unknown tiers use SOLO; case-insensitive", () => {
  assert.deepStrictEqual({ ...R.RENT_TAKE_RATE_BY_TIER }, { ENTERPRISE: 0.7, PRO: 1.2, BUSINESS: 1.6, SOLO: 2.0 });
  for (const t of ["free", "low", "starter", "", undefined, null, "toString", "__proto__"]) assert.strictEqual(R.rentRateForTier(t), 2.0, String(t));
  assert.strictEqual(R.rentRateForTier("pro"), 1.2); assert.strictEqual(R.rentRateForTier(" Enterprise "), 0.7);
});
ok("planRentSplit: owner desk -> three-way; anyone else -> two-way with the same take", () => {
  const owner = R.planRentSplit({ rentMinor: 800000, tier: "business", ownerDesk: true }, cfg);
  const other = R.planRentSplit({ rentMinor: 800000, tier: "business", ownerDesk: false }, cfg);
  assert.strictEqual(owner.takeMinor, 12800); assert.strictEqual(other.takeMinor, 12800);   // 1.6% of 8000.00
  assert.strictEqual(owner.threeWay, true); assert.strictEqual(other.threeWay, false);
  assert.strictEqual(other.agentSharePct, 0); assert.strictEqual(other.landlordSharePct, 98.4);
  assert.strictEqual(owner.landlordSharePct, 98.4); assert.strictEqual(owner.agentSharePct, 0.64);
  const capped = R.planRentSplit({ rentMinor: 2000000, tier: "solo", ownerDesk: false }, cfg);
  assert.strictEqual(capped.takeMinor, 25000); assert.strictEqual(capped.landlordSharePct, 98.75);
});
ok("settledAmounts rejects a fee above the gross and non-integers", () => {
  assert.throws(() => M.settledAmounts({ grossMinor: 100, feeMinor: 101, agentSharePct: 10 }), RangeError);
  assert.throws(() => M.settledAmounts({ grossMinor: 10.5, feeMinor: 1, agentSharePct: 10 }), RangeError);
});
ok("DEFAULT_DESK_CONFIG equals the kernel's defaults; mergeConfig deep-merges", () => {
  assert.strictEqual(cfg.creditCostMinor, 20); assert.strictEqual(cfg.platformCutPct, 2.5);
  assert.strictEqual(cfg.expectedPaystackFeePct, 1.5); assert.strictEqual(cfg.smsShareOfMarginPct, 45);
  assert.strictEqual(cfg.firstPurchaseThresholdMinor, 20000); assert.strictEqual(cfg.rentDeskSharePct, 40); assert.strictEqual(cfg.rentTakeCapMinor, 25000);
  assert.deepStrictEqual(cfg.subShareByRank, { clerk: 25, senior: 30, lead: 30, admin: 30, internal: 0 });
  const m = mergeConfig({ platformCutPct: 3, subShareByRank: { clerk: 20 } });
  assert.strictEqual(m.platformCutPct, 3); assert.strictEqual(m.subShareByRank.clerk, 20); assert.strictEqual(m.subShareByRank.senior, 30);
});

ok("rent fees: 50000 -> tenant pays 50150, landlord deducted 700 (600 + 100), net 49300", () => {
  const f = RF.rentFees(5000000);
  assert.deepStrictEqual([f.tenantFeeMinor, f.chargeMinor, f.landlordPaystackMinor, f.convenienceMinor, f.deductionsMinor, f.netPayoutMinor],
    [15000, 5015000, 60000, 10000, 70000, 4930000]);
});
ok("rent fees: surcharge is min(150, 0.5%); small rent 10000 -> 50 / 100 / 20", () => {
  const f = RF.rentFees(1000000);
  assert.deepStrictEqual([f.tenantFeeMinor, f.landlordPaystackMinor, f.convenienceMinor, f.netPayoutMinor], [5000, 10000, 2000, 988000]);
});
ok("rent fees: money always adds up, Paystack estimate capped at 3000", () => {
  for (const r of [100, 101, 999, 12345, 800000, 3333333, 40000000, 99999999]) {
    const f = RF.rentFees(r);
    assert.strictEqual(f.chargeMinor, r + f.tenantFeeMinor); assert.strictEqual(f.netPayoutMinor, r - f.deductionsMinor);
    assert.strictEqual(f.chargeMinor - f.netPayoutMinor, f.tenantFeeMinor + f.deductionsMinor); assert.ok(f.netPayoutMinor > 0 && f.tenantFeeMinor <= 15000);
  }
  assert.strictEqual(RF.rentFees(40000000).paystackEstimateMinor, 300000);
  assert.throws(() => RF.rentFees(0)); assert.throws(() => RF.rentFees(1.5));
});

ok("rent fees: platform cut by plan — enterprise 0.2, pro 0.4, business 0.65, everything else 0.95", () => {
  const cut = (tier) => RF.rentFees(1000000, tier).convenienceMinor;   // KES 10,000 rent
  assert.deepStrictEqual(["enterprise", "pro", "business", "solo", "starter", "free", "", undefined === 1 ? 0 : "weird"].map(cut), [2000, 4000, 6500, 9500, 9500, 9500, 9500, 9500]);
  assert.strictEqual(cut("PRO"), 4000); assert.strictEqual(cut(" Business "), 6500);
  const f = RF.rentFees(1000000, "business");   // tenant 50, landlord Paystack 100, cut 65 -> deduction 165, net 9,835
  assert.deepStrictEqual([f.landlordPaystackMinor, f.convenienceMinor, f.deductionsMinor, f.netPayoutMinor, f.conveniencePct], [10000, 6500, 16500, 983500, 0.65]);
  assert.strictEqual(RF.rentFees(1000000).conveniencePct, 0.2);   // no tier = the enterprise baseline
});
ok("phones: Safaricom only; 701234567 (leading 0 lost) and every spelling format to 2547XXXXXXXX", () => {
  const P = require(path.join(__dirname, "..", "lib", "phone", "safaricom"));
  for (const raw of ["0701234567", 701234567, "701234567", "+254 701-234-567", "254701234567", "+254 (0) 701234567"]) assert.strictEqual(P.checkSafaricomPhone(raw).e164, "+254701234567", String(raw));
  for (const raw of ["0700000000", "0709999999", "0745123456", "0757000000", "0768000000", "0799999999", "0110000000", "0115999999", "0119000000", "0143000000", "0182999999"]) assert.ok(P.checkSafaricomPhone(raw).ok, raw);
  for (const raw of ["0730000000", "0744000000", "0747000000", "0750000000", "0756000000", "0767000000", "0116000000", "0117000000", "0144000000", "0183000000", "0100000000"]) assert.strictEqual(P.checkSafaricomPhone(raw).reason, "not_safaricom", raw);
  assert.strictEqual(P.checkSafaricomPhone("12345").reason, "invalid");
  assert.strictEqual(P.toMsisdn(701234567), "254701234567");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
