/* PMS agent accounts: the plan + SMS payments the account holder made (pmsAccounting/billing.ts is pure).
 * Run:  cd functions && npm run build && node test/pms-billing.check.js   (exit 1 on failure) */
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const B = require(path.join(__dirname, "..", "lib", "pmsAccounting", "billing"));
let passed = 0, failed = 0;
const ok = (name, fn) => { try { fn(); passed++; console.log("  ✓", name); } catch (e) { failed++; console.error("  ✗", name, "\n", e); } };
const ts = (iso) => ({ toDate: () => new Date(iso) });

ok("a successful monthly plan payment: Paystack's real amount (kobo) wins over a stored amount", () => {
  const r = B.subscriptionRow("SUB_1", { status: "success", amount: 1, paystackResponse: { amount: 190000 }, completedAt: ts("2026-10-03T08:00:00Z"), planId: "business", planName: "Business", daysToAdd: 30 });
  assert.deepStrictEqual(r, { kind: "subscription", reference: "SUB_1", amount: 1900, paidAt: "2026-10-03T08:00:00.000Z", planId: "business", planName: "Business", periodMonths: 1 });
});
ok("an annual plan covers 12 months (so PMS spreads its cost over the year)", () => {
  assert.strictEqual(B.subscriptionRow("SUB_2", { status: "success", amount: 19000, completedAt: "2026-01-02T00:00:00Z", daysToAdd: 365 }).periodMonths, 12);
});
ok("pending, failed and malformed payments are never expenses", () => {
  assert.strictEqual(B.subscriptionRow("S", { status: "pending", amount: 1900, completedAt: "2026-10-03T00:00:00Z" }), null);
  assert.strictEqual(B.subscriptionRow("S", { status: "failed", amount: 1900 }), null);
  assert.strictEqual(B.subscriptionRow("S", { status: "success", amount: 0, completedAt: "2026-10-03T00:00:00Z" }), null);
  assert.strictEqual(B.subscriptionRow("S", { status: "success", amount: 100 }), null);     // no date
  assert.strictEqual(B.smsRow("M", { status: "pending", grossAmount: 70 }), null);
});
ok("SMS top-up: gross amount paid, tokens bought", () => {
  const r = B.smsRow("SMS_1", { status: "success", grossAmount: 350, tokens: 500, completedAt: ts("2026-10-09T10:00:00Z") });
  assert.deepStrictEqual([r.kind, r.amount, r.tokens, r.periodMonths], ["sms", 350, 500, 1]);
});
ok("merged newest first and capped", () => {
  const rows = [B.smsRow("a", { status: "success", grossAmount: 1, completedAt: "2026-01-01T00:00:00Z" }), null,
    B.smsRow("b", { status: "success", grossAmount: 1, completedAt: "2026-03-01T00:00:00Z" }), B.smsRow("c", { status: "success", grossAmount: 1, completedAt: "2026-02-01T00:00:00Z" })];
  assert.deepStrictEqual(B.mergeBilling(rows).map((r) => r.reference), ["b", "c", "a"]);
  assert.strictEqual(B.mergeBilling(rows, 2).length, 2);
});
ok("the callable identifies the caller from the sign-in only, and is read-only", () => {
  const t = fs.readFileSync(path.join(__dirname, "..", "src", "pmsAccounting", "index.ts"), "utf8");
  assert.ok(/if \(!req\.auth\) throw new HttpsError\("unauthenticated"/.test(t));
  assert.ok(!/req\.data/.test(t), "must not trust a client-supplied id");
  assert.ok(!/\.(set|update|delete|add)\(/.test(t), "must not write");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
