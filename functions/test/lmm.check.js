/* Lipa Mos Mos: fee maths, transfer fees and splitting, sealing, name cut, reminders, message lengths.
 * Run:  cd functions && npm run build && node test/lmm.check.js   (exit 1 on failure) */
const assert = require("assert");
const path = require("path");
const lib = (p) => require(path.join(__dirname, "..", "lib", "lmm", p));
const F = lib("fees"), C = lib("config"), D = lib("dear"), S = lib("seal"), R = lib("reminders"), T = lib("sms"), RC = lib("recipient");
let passed = 0, failed = 0;
const ok = (name, fn) => { try { fn(); passed++; console.log("  ✓", name); } catch (e) { failed++; console.error("  ✗", name, "\n", e); } };
const KES = (n) => n * 100;

ok("tenant surcharge: 2.5% normally, 5% under KES 100; rent credited EXACTLY what was chosen", () => {
  const a = F.chargeFor(KES(1000)); assert.deepStrictEqual([a.creditMinor, a.chargeMinor, a.surchargeBps], [KES(1000), KES(1025), 250]);
  const b = F.chargeFor(KES(99)); assert.deepStrictEqual([b.chargeMinor, b.surchargeBps], [KES(104), 500]);   // 99 + 5% = 103.95 -> 104
  const c = F.chargeFor(KES(100)); assert.strictEqual(c.surchargeBps, 250);
  const d = F.chargeFor(KES(10)); assert.deepStrictEqual([d.chargeMinor, d.surchargeBps], [KES(11), 500]);   // 10.5 -> 11
});
ok("only whole shillings between the minimum and maximum are accepted", () => {
  for (const bad of [0, 999, 1050, 15_000_100, -1000, 12.5, NaN, "1000"]) assert.throws(() => F.chargeFor(bad), RangeError, String(bad));
  assert.ok(F.isValidCredit(KES(10)) && F.isValidCredit(KES(150000)));
});
ok("Samuhia keeps about 0.96% of the credited rent (never below 0.9%) after Paystack's 1.5% of the bigger charge", () => {
  for (const credit of [KES(1000), KES(5000), KES(25000), KES(100000)]) {
    const c = F.chargeFor(credit), fee = Math.round(c.chargeMinor * 0.015), kept = F.keptMinor(c, fee);
    assert.ok(kept / credit > 0.009 && kept / credit < 0.0101, `${credit}: ${kept / credit}`);
  }
});
ok("a small instalment still leaves Samuhia a positive amount", () => {
  for (const kes of [10, 20, 50, 99]) { const c = F.chargeFor(KES(kes)); assert.ok(F.keptMinor(c, Math.round(c.chargeMinor * 0.015)) > 0, String(kes)); }
});
ok("transfer fee tiers: <=10,000 -> 95, <40,000 -> 183, <=900,000 -> 257, above -> refused", () => {
  assert.strictEqual(F.transferFeeMinor(KES(300)), KES(95)); assert.strictEqual(F.transferFeeMinor(KES(10000)), KES(95));
  assert.strictEqual(F.transferFeeMinor(KES(10000) + 1), KES(183)); assert.strictEqual(F.transferFeeMinor(KES(39999)), KES(183)); assert.strictEqual(F.transferFeeMinor(KES(39999.99)), KES(183));
  assert.strictEqual(F.transferFeeMinor(KES(40000)), KES(257)); assert.strictEqual(F.transferFeeMinor(KES(900000)), KES(257));
  assert.throws(() => F.transferFeeMinor(KES(900000) + 1), RangeError); assert.throws(() => F.transferFeeMinor(0), RangeError);
});
ok("a settlement must cover its own fee and the minimum; the landlord receives gross minus the fee", () => {
  assert.throws(() => F.planTransfers(KES(299), "kepss"), RangeError);
  const [t] = F.planTransfers(KES(25000), "kepss"); assert.deepStrictEqual([t.grossMinor, t.feeMinor, t.sendMinor], [KES(25000), KES(183), KES(24817)]);
  assert.throws(() => F.planTransfers(KES(900001), "kepss"), RangeError);
});
ok("M-PESA wallet settlements above KES 150,000 are split evenly, each part within the limit and paying its own fee", () => {
  const one = F.planTransfers(KES(150000), "mobile_money"); assert.strictEqual(one.length, 1);
  const parts = F.planTransfers(KES(400000), "mobile_money");
  assert.strictEqual(parts.length, 3); assert.strictEqual(parts.reduce((s, p) => s + p.grossMinor, 0), KES(400000));
  assert.ok(parts.every((p) => p.grossMinor <= C.LMM.WALLET_MAX_TRANSFER_MINOR && p.sendMinor === p.grossMinor - p.feeMinor));
  assert.strictEqual(F.planTransfers(KES(400000), "kepss").length, 1, "banks take it in one");
  const odd = F.planTransfers(KES(150000) + 1, "mobile_money"); assert.strictEqual(odd.reduce((s, p) => s + p.grossMinor, 0), KES(150000) + 1);
});

ok("Dear {first name}: cut at the first space, tidy, safe", () => {
  assert.strictEqual(D.dearLine("John Doe"), "Dear John,"); assert.strictEqual(D.dearLine("  mary   wanjiku "), "Dear Mary,");
  assert.strictEqual(D.dearLine(""), "Dear Tenant,"); assert.strictEqual(D.dearLine(undefined), "Dear Tenant,"); assert.strictEqual(D.dearLine("O'Brien Pat"), "Dear O'Brien,");
  assert.strictEqual(D.firstName("J0hn\nDoe"), "Jhn");
});

ok("seals: any change to the recipient or the settlement breaks them", () => {
  const k = "unit-test-key", r = { landlordId: "L1", recipientCode: "RCP_abc", type: "kepss", bankCode: "068", fp: S.fingerprint(k, "068", "1234567890") };
  const seal = S.sealRecipient(k, r);
  assert.ok(S.sameSeal(seal, S.sealRecipient(k, r)));
  for (const [f, v] of [["landlordId", "L2"], ["recipientCode", "RCP_xyz"], ["type", "mobile_money"], ["bankCode", "070"], ["fp", S.fingerprint(k, "068", "9999999999")]]) assert.ok(!S.sameSeal(seal, S.sealRecipient(k, { ...r, [f]: v })), f);
  assert.ok(!S.sameSeal(seal, S.sealRecipient("other-key", r)), "a different key never validates");
  const s = { id: "p_1", planId: "p", landlordId: "L1", recipientCode: "RCP_abc", grossMinor: KES(5000), sendMinors: [KES(4817)], paymentRefs: ["a", "b"] };
  const ss = S.sealSettlement(k, s);
  for (const [f, v] of [["grossMinor", KES(9000)], ["recipientCode", "RCP_evil"], ["sendMinors", [KES(9000)]], ["paymentRefs", ["a"]], ["landlordId", "L9"]]) assert.ok(!S.sameSeal(ss, S.sealSettlement(k, { ...s, [f]: v })), f);
  assert.ok(S.sameSeal(ss, S.sealSettlement(k, { ...s, paymentRefs: ["b", "a"] })), "ref order does not matter");
  assert.ok(!S.sameSeal(undefined, seal) && !S.sameSeal("short", seal));
});
ok("the account fingerprint ignores spaces and bank-code case, but not digits", () => {
  const k = "k"; assert.strictEqual(S.fingerprint(k, "mpesa", "0712 345 678"), S.fingerprint(k, "MPESA", "0712345678")); assert.notStrictEqual(S.fingerprint(k, "MPESA", "0712345678"), S.fingerprint(k, "MPESA", "0712345679"));
});

ok("recipient types: wallet, till and bank map correctly; Airtel and Paybill are refused", () => {
  assert.deepStrictEqual(RC.recipientSpec({ settlementType: "mpesa", bankCode: "MPESA", accountNumber: "0712345678" }), { ok: true, type: "mobile_money", bankCode: "MPESA", accountNumber: "0712345678" });
  assert.strictEqual(RC.recipientSpec({ settlementType: "till", bankCode: "x", accountNumber: "123456" }).type, "mobile_money_business");
  assert.strictEqual(RC.recipientSpec({ settlementType: "bank", bankCode: "068", accountNumber: "123" }).type, "kepss");
  assert.strictEqual(RC.recipientSpec({ settlementType: "airtel-ke", bankCode: "ATL", accountNumber: "0733" }).ok, false);
  assert.strictEqual(RC.recipientSpec({ settlementType: "paybill", bankCode: "x", accountNumber: "1" }).ok, false);
  assert.strictEqual(RC.recipientSpec({ settlementType: "bank", bankCode: "068", accountNumber: "" }).ok, false);
});

ok("reminders: quiet period per frequency, spacing, a cap of 3, silent when nothing is owed", () => {
  const day = 86_400_000, now = 100 * day, base = { frequency: "weekly", status: "active", remainingMinor: KES(5000), createdAt: now - 30 * day, lastPaymentAt: now - 9 * day, lastSmsAt: 0, missedCount: 0 };
  assert.deepStrictEqual(R.missedReminder(base, now), { send: true, days: 9 });
  assert.strictEqual(R.missedReminder({ ...base, lastPaymentAt: now - 5 * day }, now).send, false, "weekly waits 8 days");
  assert.strictEqual(R.missedReminder({ ...base, frequency: "daily", lastPaymentAt: now - 2 * day }, now).send, true);
  assert.strictEqual(R.missedReminder({ ...base, frequency: "biweekly", lastPaymentAt: now - 14 * day }, now).send, false);
  assert.strictEqual(R.missedReminder({ ...base, lastSmsAt: now - 2 * day }, now).send, false, "no SMS closer than the spacing");
  assert.strictEqual(R.missedReminder({ ...base, lastSmsAt: now - 8 * day }, now).send, true);
  assert.strictEqual(R.missedReminder({ ...base, missedCount: 3 }, now).send, false);
  assert.strictEqual(R.missedReminder({ ...base, remainingMinor: 0 }, now).send, false); assert.strictEqual(R.missedReminder({ ...base, status: "paused" }, now).send, false);
  assert.strictEqual(R.missedReminder({ ...base, lastPaymentAt: 0, createdAt: now - 1 * day }, now).send, false, "a new plan is not 'missed'");
});
ok("milestones: only the highest newly reached one, never repeated", () => {
  assert.strictEqual(R.newMilestone(10, []), null); assert.strictEqual(R.newMilestone(30, []), 25); assert.strictEqual(R.newMilestone(80, []), 75);
  assert.strictEqual(R.newMilestone(80, [25, 50, 75]), null); assert.strictEqual(R.newMilestone(100, [25, 50, 75]), 100); assert.strictEqual(R.newMilestone(60, [25]), 50);
});

ok("every SMS starts 'Dear {first name},', stays under 144 characters, even with the longest realistic values", () => {
  const long = "Christopher Wanjiru-Kamau";
  const msgs = [
    T.lmmText.started({ name: long, targetMinor: KES(1_250_000) }), T.lmmText.missed({ name: long, days: 15, balanceMinor: KES(1_250_000) }),
    T.lmmText.milestone({ name: long, pct: 50, paidMinor: KES(1_250_000), leftMinor: KES(1_250_000) }), T.lmmText.milestone({ name: long, pct: 100, paidMinor: KES(1_250_000), leftMinor: 0 }),
    T.lmmText.landlordPaid({ name: long, paidMinor: KES(1_250_000), leftMinor: KES(1_250_000) }), T.lmmText.landlordPaid({ name: long, paidMinor: KES(1_250_000), leftMinor: 0 }),
  ];
  for (const m of msgs) { assert.ok(m.length <= 144, `${m.length}: ${m}`); assert.ok(m.startsWith("Dear Christopher,"), m); }
  assert.ok(T.lmmText.started({ name: "John Doe", targetMinor: KES(25000) }).startsWith("Dear John,"));
  assert.strictEqual(T.fit144("x".repeat(300)).length, 144); assert.ok(!/[^\x20-\x7E]/.test(T.fit144("Hi 😀 café")));
});

ok("hard limits live in code and match the spec", () => {
  assert.strictEqual(C.LMM.ALERT_MOBILE, "254791286165"); assert.strictEqual(C.LMM.SETTLE_DAY, 5);
  assert.strictEqual(C.LMM.SURCHARGE_BPS, 250); assert.strictEqual(C.LMM.SMALL_SURCHARGE_BPS, 500); assert.ok(Object.isFrozen === Object.isFrozen);
  assert.deepStrictEqual(C.FREQUENCIES, ["daily", "weekly", "biweekly"]);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
