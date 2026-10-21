/* Run: cd functions && npm run build && node test/rent-settlement.check.js */
const assert = require("assert"); const path = require("path");
const S = require(path.join(__dirname, "..", "lib", "desk", "rentSettlement"));
let p = 0, f = 0; const ok = (n, fn) => { try { fn(); p++; console.log("  ✓", n); } catch (e) { f++; console.error("  ✗", n, "\n", e); } };
const d = (x) => S.fmtDate(S.settlementDate(new Date(x)));
ok("Mon 12:00 EAT -> Wed", () => assert.strictEqual(d("2026-10-12T09:00:00Z"), "14/10/2026"));
ok("Thu -> Mon (weekend skipped)", () => assert.strictEqual(d("2026-10-22T09:00:00Z"), "26/10/2026"));
ok("Fri -> Tue", () => assert.strictEqual(d("2026-10-23T09:00:00Z"), "27/10/2026"));
ok("Sat payment counts as Monday -> Wed", () => assert.strictEqual(d("2026-10-24T09:00:00Z"), "28/10/2026"));
ok("Mashujaa Day Tue 20 Oct is skipped: Mon 19 Oct -> Thu 22", () => assert.strictEqual(d("2026-10-19T09:00:00Z"), "22/10/2026"));
ok("Easter 2026: Wed 1 Apr -> Tue 7 Apr (Good Friday 3, Easter Monday 6)", () => assert.strictEqual(d("2026-04-01T09:00:00Z"), "07/04/2026"));
ok("Idd-ul-Fitr Fri 20 Mar 2026 skipped: Thu 19 Mar -> Tue 24 Mar", () => assert.strictEqual(d("2026-03-19T09:00:00Z"), "24/03/2026"));
ok("holiday on a Sunday moves to Monday (25 Dec 2022 Sun -> 26 & 27 Dec)", () => { const h = S.kenyaHolidays(2022); assert.ok(h.has("2022-12-26") && h.has("2022-12-27")); });
ok("late-evening UTC is already next day in Nairobi (Fri 21:30Z = Sat 00:30 EAT)", () => assert.strictEqual(S.fmtDateTime(new Date("2026-10-23T21:30:00Z")), "24/10/2026 00:30"));
ok("extra (moon-sighted) holidays are honoured", () => assert.strictEqual(S.fmtDate(S.settlementDate(new Date("2027-03-08T09:00:00Z"), ["2027-03-10"])), "11/03/2027"));
const facts = { rentMinor: 5000000, tenantFeeMinor: 15000, chargeMinor: 5015000, deductionsMinor: 70000, netPayoutMinor: 4930000, arrearsMinor: 0,
  unit: "A12", paidAt: new Date("2026-10-12T09:05:00Z"), settlesOn: S.settlementDate(new Date("2026-10-12T09:05:00Z")), tenantName: "Tess Wanjiru", reference: "INV_T1_1760000000000" };
ok("landlord SMS", () => assert.strictEqual(S.landlordRentSms(facts),
  "Confirmed KES 50,000 paid for unit A12 at 12/10/2026 12:05. Arrears: KES 0. Expected settlement: KES 49,300 on 14/10/2026. Transaction cost: KES 700."));
ok("tenant SMS: fully paid vs balance", () => {
  assert.match(S.tenantRentSms(facts), /Transaction fee: KES 150\. Total paid: KES 50,150\. Your invoice is fully paid\./);
  assert.match(S.tenantRentSms({ ...facts, arrearsMinor: 2000000 }), /Balance due: KES 20,000\./);
});
console.log(`\n${p} passed, ${f} failed`); process.exit(f ? 1 : 0);
