/* Compliance reports on WhatsApp (Landlord Watch bot actions). Run:  cd functions && npm run build && node test/compliance-bot.check.js */
const assert = require("assert");
const path = require("path");
process.env.MYCHAMA_ID_PEPPER = "test-pepper";
const { FakeDb } = require("./compliance-fake-firestore");
const lib = (p) => require(path.join(__dirname, "..", "lib", p));
const { REPORT_ACTIONS } = lib("compliance/botActions");
const { actorFromBot } = lib("landlordWatch/actors");
const { LwError } = lib("landlordWatch/errors");
const OWNER = "+254712345678", STRANGER = "+254799111222";
let passed = 0, failed = 0, clock, charges, pdfCalls;
const ok = async (n, fn) => { try { await fn(); passed++; console.log("  ✓", n); } catch (e) { failed++; console.error("  ✗", n, "\n", e); } };
const code = async (fn) => { try { await fn(); } catch (e) { assert.ok(e instanceof LwError, "not an LwError: " + e); return e.code; } return "NO_ERROR"; };

function world(tier = "business", ownerPhone = OWNER) {
  const db = new FakeDb(); charges = []; pdfCalls = 0; clock = Date.parse("2026-11-03T08:00:00Z");
  db.store.set("users/7", { name: "Wanjiru", tier });
  db.store.set("users/7/properties/3", { name: "Sunrise Apartments", address: "Naivasha", ownerId: "PYP-0001", ownerPhone, agentCommissionRate: 10 });
  db.store.set("propertyOwnerIds/PYP-0001", { userId: "7", propertyId: "3" });
  for (const a of [OWNER, STRANGER]) db.store.set(`lwActors/w_${a.slice(1)}`, { connections: { "PYP-0001": { connectedAt: null } } });
  db.store.set("users/7/tenants/1", { localId: 1, propertyId: 3, name: "Amina", unitNumber: "U1", rentAmount: 14000, isActive: true });
  db.store.set("users/7/invoices/1", { localId: 1, propertyId: 3, tenantId: 1, billingMonth: "2026-10", rentAmount: 14000, totalAmount: 15000, amountPaid: 15000 });
  db.store.set("users/7/invoices/1/payments/1", { amount: 15000, paymentDate: "2026-10-04" });
  const deps = {
    db, now: () => new Date(clock), pdf: async () => { pdfCalls++; return Buffer.from("%PDF-fake"); },
    storage: { save: async () => undefined, signedUrl: async (p, ttl) => `https://signed.example/${p}?ttl=${ttl}` },
    paystack: { charge: async (p) => { charges.push(p); return { status: "pay_offline", displayText: "Enter your M-Pesa PIN" }; }, verify: async () => null },
    checkPhone: (raw) => (/^(\+254|0)7\d{8}$/.test(String(raw)) ? { ok: true, e164: "+254" + String(raw).slice(-9) } : { ok: false, message: "Enter a valid Safaricom number." }),
  };
  return { db, deps };
}
const as = (deps, phone) => ({ deps, actor: actorFromBot(phone), lang: "en" });
const run = (w, phone, action, data) => REPORT_ACTIONS[action](as(w.deps, phone), data);

(async () => {
  await ok("the owner (phone matches the property) orders, checks out free on Business, and gets a bot-shaped request with a link", async () => {
    const w = world();
    const q = await run(w, OWNER, "reportQuote", { ownerId: "PYP-0001" });
    assert.strictEqual(q.priceKes, 0); assert.strictEqual(q.freeIncluded, true);
    const o = await run(w, OWNER, "reportOrder", { ownerId: "PYP-0001", month: "2026-10", kind: "mri_monthly" });
    assert.deepStrictEqual([o.state, o.priceKes, o.ownerId, o.month, o.kind], ["payment_required", 0, "PYP-0001", "2026-10", "mri_monthly"]);
    assert.ok(/^[a-f0-9]{16}$/.test(o.requestId)); assert.strictEqual(o.url, undefined);
    let s = await run(w, OWNER, "reportStatus", { orderId: o.requestId });
    assert.strictEqual(s.state, "payment_required"); assert.strictEqual(pdfCalls, 0);                       // nothing before checkout
    const c = await run(w, OWNER, "reportCheckout", { orderId: o.requestId });
    assert.strictEqual(c.state, "paid");
    s = await run(w, OWNER, "reportStatus", { orderId: o.requestId });
    assert.strictEqual(s.state, "ready"); assert.ok(s.url.startsWith("https://signed.example/")); assert.ok(s.fileName.endsWith(".pdf"));
    assert.ok(Math.abs(Date.parse(s.expiresAt) - (clock + 7 * 86_400_000)) < 1000, "available again for 7 days, not for the 15-minute link");
  });
  await ok("an owner who is not unlocked (different phone, no code) is told to unlock; a stranger who never connected is refused", async () => {
    const w = world();
    assert.strictEqual(await code(() => run(w, STRANGER, "reportOrder", { ownerId: "PYP-0001", month: "2026-10", kind: "mri_monthly" })), "LW_LOCKED");
    assert.strictEqual(await code(() => run(w, "+254722000111", "reportQuote", { ownerId: "PYP-0001" })), "LW_NOT_ALLOWED");     // not connected
    assert.strictEqual(await code(() => run(w, OWNER, "reportQuote", { ownerId: "not an id" })), "LW_BAD_OWNER_ID");
    assert.strictEqual(await code(() => run(w, OWNER, "reportQuote", { ownerId: "PYP-9999" })), "LW_NOT_FOUND");
    assert.strictEqual(w.db.store.has("complianceReports"), false);
  });
  await ok("nobody else can read, pay for or download your order; losing the unlock cuts access to an existing order", async () => {
    const w = world();
    const o = await run(w, OWNER, "reportOrder", { ownerId: "PYP-0001", month: "2026-10", kind: "annual_summary" });
    assert.strictEqual(await code(() => run(w, STRANGER, "reportStatus", { orderId: o.requestId })), "LW_NOT_FOUND");       // someone else's order does not even exist for you
    w.db.store.set("lwActors/w_254722000111", { connections: { "PYP-0001": { connectedAt: null } } });
    assert.strictEqual(await code(() => run(w, "+254722000111", "reportCheckout", { orderId: o.requestId, phone: OWNER })), "LW_NOT_FOUND");
    assert.strictEqual(await code(() => run(w, OWNER, "reportStatus", { orderId: "ffffffffffffffff" })), "LW_NOT_FOUND");
    assert.strictEqual(await code(() => run(w, OWNER, "reportStatus", { orderId: "x" })), "LW_NOT_FOUND");
    w.db.store.set("users/7/properties/3", { ...w.db.store.get("users/7/properties/3"), ownerPhone: "+254733000999" });      // the owner phone on file changed: no longer unlocked
    assert.strictEqual(await code(() => run(w, OWNER, "reportStatus", { orderId: o.requestId })), "LW_LOCKED");
  });
  await ok("Starter: KES 200 with an M-Pesa prompt to the number the owner chose; the link comes only after payment settles", async () => {
    const w = world("starter");
    const o = await run(w, OWNER, "reportOrder", { ownerId: "PYP-0001", month: "2026-10", kind: "mri_monthly" });
    assert.strictEqual(o.priceKes, 200);
    assert.strictEqual(await code(() => run(w, OWNER, "reportCheckout", { orderId: o.requestId, phone: "12345" })), "LW_PAYMENT_FAILED");
    const c = await run(w, OWNER, "reportCheckout", { orderId: o.requestId, phone: "+254722000111" });
    assert.strictEqual(c.state, "payment_pending"); assert.strictEqual(charges.length, 1); assert.strictEqual(charges[0].amount, 20000); assert.strictEqual(charges[0].mobile_money.phone, "+254722000111");
    const s = await run(w, OWNER, "reportStatus", { orderId: o.requestId });
    assert.strictEqual(s.state, "payment_pending"); assert.strictEqual(s.url, undefined); assert.strictEqual(pdfCalls, 0);
    const { settleReportPayment } = lib("compliance/payments");
    await settleReportPayment(w.db, charges[0].reference, { amount: 20000, fees: 300 }, { orderId: o.requestId });
    const done = await run(w, OWNER, "reportStatus", { orderId: o.requestId });
    assert.strictEqual(done.state, "ready"); assert.ok(done.url);
  });
  await ok("a 'free' order whose allowance was used meanwhile reports the new price instead of failing, and charges nothing", async () => {
    const w = world();
    const a = await run(w, OWNER, "reportOrder", { ownerId: "PYP-0001", month: "2026-10", kind: "mri_monthly" });
    const b = await run(w, OWNER, "reportOrder", { ownerId: "PYP-0001", month: "2026-10", kind: "annual_summary" });
    assert.strictEqual(a.priceKes + b.priceKes, 0);
    await run(w, OWNER, "reportCheckout", { orderId: a.requestId });                          // takes the allowance
    const c = await run(w, OWNER, "reportCheckout", { orderId: b.requestId });
    assert.deepStrictEqual([c.state, c.priceKes], ["payment_required", 200]); assert.strictEqual(charges.length, 0);
    const paid = await run(w, OWNER, "reportCheckout", { orderId: b.requestId, phone: OWNER });
    assert.strictEqual(paid.state, "payment_pending"); assert.strictEqual(charges.length, 1);
  });
  await ok("the list shows the owner's own reports, newest first, and never a download link", async () => {
    const w = world();
    const a = await run(w, OWNER, "reportOrder", { ownerId: "PYP-0001", month: "2026-10", kind: "mri_monthly" });
    await run(w, OWNER, "reportCheckout", { orderId: a.requestId }); await run(w, OWNER, "reportStatus", { orderId: a.requestId });
    const l = await run(w, OWNER, "reportList", { ownerId: "PYP-0001" });
    assert.strictEqual(l.items.length, 1); assert.strictEqual(l.items[0].state, "ready"); assert.strictEqual(l.items[0].url, undefined); assert.ok(l.items[0].expiresAt);
  });
  await ok("a property with nothing synced to report on is refused before anyone pays", async () => {
    const w = world();
    w.db.store.delete("users/7/tenants/1"); w.db.store.delete("users/7/invoices/1");
    assert.strictEqual(await code(() => run(w, OWNER, "reportOrder", { ownerId: "PYP-0001", month: "2026-10", kind: "mri_monthly" })), "LW_REPORT_NO_DATA");
    assert.strictEqual(await code(() => run(w, OWNER, "reportOrder", { ownerId: "PYP-0001", month: "2026-99", kind: "mri_monthly" })), "LW_BAD_MONTH");
    assert.strictEqual(await code(() => run(w, OWNER, "reportOrder", { ownerId: "PYP-0001", month: "2026-10", kind: "nope" })), "LW_BAD_MONTH");
  });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
