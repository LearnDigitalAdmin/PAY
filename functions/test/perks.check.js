/* Samuhia Perks backend: business rules, atomic ops, consent-gated SMS, access boundaries.
 * Run:  cd functions && npm run build && node test/perks.check.js   (exit 1 on failure) */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { FakeDb } = require("./fake-orderby");
const lib = (p) => require(path.join(__dirname, "..", "lib", "perks", p));
const R = lib("rules"), { handleOperator, handleCustomer } = lib("handlers"), { PerksError } = lib("types");

let passed = 0, failed = 0, n = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log("  ✓", name); } catch (e) { failed++; console.error("  ✗", name, "\n", e); } };
const rejects = async (fn, code, re) => { try { await fn(); } catch (e) { assert(e instanceof PerksError, "expected PerksError, got " + e); if (code) assert.strictEqual(e.code, code); if (re) assert(re.test(e.message), e.message); return; } assert.fail("expected rejection"); };

const sent = [];
let failNext = false;
let pid = 0;
const send = async (phone, message, link) => { if (failNext) { failNext = false; return { success: false, error: "gateway down" }; } sent.push({ phone, message, link }); return { success: true, providerId: "P" + (++pid) }; };
const fresh = () => { sent.length = 0; return new FakeDb(); };
const key = () => `key-${++n}-abcdefgh`;
const op = (db, action, p) => handleOperator(db, send, "op1", action, p);
const sale = (db, phone, items, extra = {}) => op(db, "recordSale", { phone, items, idempotencyKey: key(), ...extra });
const svc = (price, itemName = "Printing") => ({ itemName, itemType: "SERVICE", price });
const prod = (price, itemName = "USB cables") => ({ itemName, itemType: "PRODUCT", price });
const bal = (db, phone) => (db.read(`perks_customers/${R.customerId(phone)}`) || {}).pointsBalance;

(async () => {
  await test("points table: services 7 and products 4 per KES 100, floored", () => {
    const s = { servicesPointsRate: 7, productsPointsRate: 4 };
    for (const [amt, want] of [[100, 7], [200, 14], [350, 24], [500, 35]]) assert.strictEqual(R.pointsFor(amt, R.rateFor("SERVICE", s)), want);
    for (const [amt, want] of [[100, 4], [200, 8], [350, 14], [500, 20]]) assert.strictEqual(R.pointsFor(amt, R.rateFor("PRODUCT", s)), want);
  });
  await test("phone normalisation", () => {
    for (const v of ["0712345678", "0112345678", "+254712345678", "254712 345 678"]) assert(/^\+254[17]\d{8}$/.test(R.toE164(v)));
    assert.throws(() => R.toE164("0612345678"));
  });
  await test("mixed sale: per-item points, non-eligible earns nothing, total correct", async () => {
    const db = fresh();
    const r = await sale(db, "0712345678", [svc(100), prod(200), svc(300, "Phone flashing")], { nonEligibleAmount: 200 });
    assert.strictEqual(r.transaction.pointsEarned, 7 + 8 + 21);
    assert.strictEqual(r.transaction.eligibleAmount, 600);
    assert.strictEqual(r.transaction.totalAmount, 800);
    assert.strictEqual(bal(db, "+254712345678"), 36);
    const led = db.list("perks_ledger"); assert.strictEqual(led.length, 1);
    assert.strictEqual(db.read(led[0]).balanceAfter, 36);
  });
  await test("validation: price must be a positive whole KES, phone valid", async () => {
    const db = fresh();
    await rejects(() => sale(db, "0712345678", [svc(0)]), "invalid-argument");
    await rejects(() => sale(db, "0712345678", [svc(10.5)]), "invalid-argument");
    await rejects(() => sale(db, "123", [svc(100)]), "invalid-argument");
    await rejects(() => op(db, "recordSale", { phone: "0712345678", items: [svc(100)] }), "invalid-argument", /request id/);
    assert.strictEqual(db.list("perks_tx").length, 0);
  });
  await test("idempotency: the same request id records once", async () => {
    const db = fresh(), k = "same-request-12345";
    const a = await op(db, "recordSale", { phone: "0712345678", items: [svc(100)], idempotencyKey: k });
    const b = await op(db, "recordSale", { phone: "0712345678", items: [svc(100)], idempotencyKey: k });
    assert.strictEqual(a.duplicate, false); assert.strictEqual(b.duplicate, true);
    assert.strictEqual(db.list("perks_tx").length, 1); assert.strictEqual(bal(db, "+254712345678"), 7);
  });
  await test("referral: KES 50 does not qualify, KES 51 does; 50/30 paid exactly once", async () => {
    const db = fresh();
    const a = await sale(db, "0711111111", [svc(100)]);
    const code = a.customer.referralCode;
    await sale(db, "0722222222", [svc(50)], { referralCode: code });
    let ref = db.read("perks_referrals/254722222222"); assert.strictEqual(ref.status, "PENDING");
    assert.strictEqual(bal(db, "+254711111111"), 7);
    await sale(db, "0722222222", [svc(51)]);
    ref = db.read("perks_referrals/254722222222"); assert.strictEqual(ref.status, "REWARDED");
    assert.strictEqual(bal(db, "+254711111111"), 7 + 50);
    assert.strictEqual(bal(db, "+254722222222"), 3 + 3 + 30);
    await sale(db, "0722222222", [svc(500)]);
    assert.strictEqual(bal(db, "+254711111111"), 57, "no second reward");
    assert.strictEqual(db.list("perks_ledger").filter((p) => db.read(p).type === "REFERRAL").length, 2);
  });
  await test("referral on a first sale above KES 50 rewards immediately", async () => {
    const db = fresh();
    const a = await sale(db, "0711111111", [svc(100)]);
    await sale(db, "0722222222", [svc(200)], { referralCode: a.customer.referralCode });
    assert.strictEqual(bal(db, "+254711111111"), 7 + 50); assert.strictEqual(bal(db, "+254722222222"), 14 + 30);
  });
  await test("referral rules: no self-referral, unknown code, first visit only, one referrer", async () => {
    const db = fresh();
    const a = await sale(db, "0711111111", [svc(100)]), b = await sale(db, "0722222222", [svc(100)]);
    await rejects(() => sale(db, "0711111111", [svc(100)], { referralCode: a.customer.referralCode }), "failed-precondition");
    await rejects(() => sale(db, "0733333333", [svc(100)], { referralCode: "NOPE99" }), "not-found");
    await rejects(() => sale(db, "0722222222", [svc(100)], { referralCode: a.customer.referralCode }), "failed-precondition", /first visit/);
    await op(db, "registerReferral", { inviteePhone: "0744444444", code: a.customer.referralCode });
    await rejects(() => op(db, "registerReferral", { inviteePhone: "0744444444", code: b.customer.referralCode }), "already-exists");
    await sale(db, "0744444444", [svc(300)]);
    assert.strictEqual(db.read("perks_referrals/254744444444").status, "REWARDED");
  });
  await test("redemption: operator-only rules, minimum 100, never above balance, 100 pts = KES 20", async () => {
    const db = fresh();
    await sale(db, "0712345678", [svc(2000)]); // 140 pts
    await rejects(() => op(db, "redeem", { phone: "0712345678", points: 99, idempotencyKey: key() }), "failed-precondition", /Minimum/);
    await rejects(() => op(db, "redeem", { phone: "0712345678", points: 141, idempotencyKey: key() }), "failed-precondition", /enough/);
    const k = key(), r = await op(db, "redeem", { phone: "0712345678", points: 100, idempotencyKey: k });
    assert.strictEqual(r.redemption.valueKes, 20); assert.strictEqual(bal(db, "+254712345678"), 40);
    const again = await op(db, "redeem", { phone: "0712345678", points: 100, idempotencyKey: k });
    assert.strictEqual(again.duplicate, true); assert.strictEqual(bal(db, "+254712345678"), 40);
    assert.strictEqual(R.redemptionValueKes(150, { pointsValue: 20, pointsValueUnit: 100 }), 30);
    assert.strictEqual(R.redemptionValueKes(1000, { pointsValue: 20, pointsValueUnit: 100 }), 200);
  });
  await test("reversal: ledger adjustment, never deleted, blocked if points were spent", async () => {
    const db = fresh();
    const s = await sale(db, "0712345678", [svc(2000)]);
    await op(db, "reverseSale", { transactionId: s.transaction.id, reason: "wrong amount" });
    assert.strictEqual(bal(db, "+254712345678"), 0); assert.strictEqual(db.read(`perks_tx/${s.transaction.id}`).status, "REVERSED");
    assert(db.list("perks_ledger").some((p) => db.read(p).type === "REVERSAL"));
    await rejects(() => op(db, "reverseSale", { transactionId: s.transaction.id, reason: "again" }), "failed-precondition");
    const s2 = await sale(db, "0712345678", [svc(2000)]);
    await op(db, "redeem", { phone: "0712345678", points: 100, idempotencyKey: key() });
    await rejects(() => op(db, "reverseSale", { transactionId: s2.transaction.id, reason: "oops" }), "failed-precondition", /spent/);
    await rejects(() => op(db, "reverseSale", { transactionId: s2.transaction.id, reason: "" }), "invalid-argument");
  });
  await test("vouchers: single use, status guarded, points vouchers credit the ledger", async () => {
    const db = fresh();
    await sale(db, "0712345678", [svc(100)]);
    const v = await op(db, "createVoucher", { type: "DISCOUNT", value: 50 });
    await op(db, "assignVoucher", { voucherId: v.id, phone: "0712345678" });
    await rejects(() => op(db, "assignVoucher", { voucherId: v.id, phone: "0712345678" }), "failed-precondition");
    await op(db, "setVoucherStatus", { voucherId: v.id, status: "REDEEMED" });
    await rejects(() => op(db, "setVoucherStatus", { voucherId: v.id, status: "REDEEMED" }), "failed-precondition");
    await rejects(() => op(db, "setVoucherStatus", { voucherId: v.id, status: "VOID" }), "failed-precondition");
    const p = await op(db, "createVoucher", { type: "POINTS", value: 25 });
    await op(db, "assignVoucher", { voucherId: p.id, phone: "0712345678" });
    assert.strictEqual(bal(db, "+254712345678"), 7 + 25); assert.strictEqual(db.read(`perks_vouchers/${p.id}`).status, "REDEEMED");
    const bulk = await op(db, "bulkVouchers", { type: "DISCOUNT", value: 20, count: 3 }); assert.strictEqual(bulk.created, 3);
  });
  await test("SMS: campaign advert only with marketing consent, opt-out pointer (no STOP keyword), retry works", async () => {
    const db = fresh();
    const k = await op(db, "saveCampaign", { name: "Samuhia Perks", advert: "Enjoy more rewards at Samuhia Cyber.", destinationUrl: "https://perks.samuhia.co.ke" });
    await op(db, "setActiveCampaign", { id: k.id });
    await sale(db, "0712345678", [svc(100)]);
    assert(sent.length >= 2, "welcome + sale"); assert(sent.every((m) => !/https?:/.test(m.message)), "no advert without consent");
    await op(db, "setConsent", { phone: "0712345678", marketing: true });
    sent.length = 0; await sale(db, "0712345678", [svc(100)]);
    assert(/Enjoy more rewards/.test(sent[0].message) && /perks\.samuhia\.co\.ke/.test(sent[0].message) && /Opt out: perks\.samuhia\.co\.ke/.test(sent[0].message) && !/STOP|Reply/i.test(sent[0].message));
    const logs = db.list("perks_smsLog").map((p) => db.read(p)); assert(logs.some((l) => l.campaignId === k.id) && logs.some((l) => l.campaignId === null));
    assert(logs.every((l) => l.estimatedCost === 0.2));
    failNext = true; await sale(db, "0712345678", [svc(100)]);
    const failed = db.list("perks_smsLog").map((p) => db.read(p)).find((l) => l.status === "FAILED"); assert(failed);
    const r = await op(db, "retrySms", { id: failed.id }); assert.strictEqual(r.status, "SENT");
    await rejects(() => op(db, "retrySms", { id: failed.id }), "failed-precondition");
    await op(db, "setCampaignActive", { id: k.id, active: false });
    assert.strictEqual(db.read("perks_settings/main").activeCampaignId, "");
    await rejects(() => op(db, "setActiveCampaign", { id: k.id }), "failed-precondition");
  });
  await test("templates: placeholders checked, adverts/links refused", async () => {
    const db = fresh();
    await op(db, "saveTemplate", { id: "sale", body: "Got KES {{amount}}, balance {{pointsBalance}} pts." });
    await rejects(() => op(db, "saveTemplate", { id: "sale", body: "Hi {{secret}}" }), "invalid-argument");
    await rejects(() => op(db, "saveTemplate", { id: "sale", body: "Visit https://example.com now" }), "invalid-argument", /Campaigns/);
    await sale(db, "0712345678", [svc(100)]);
    assert(sent.some((m) => /Got KES 100, balance 7 pts\./.test(m.message)));
  });
  await test("settings and the reward draw: draw needs a console-only approval flag", async () => {
    const db = fresh();
    await rejects(() => op(db, "updateSettings", { patch: { drawProductionApproved: true } }), "invalid-argument");
    await op(db, "updateSettings", { patch: { referralDrawEnabled: true } });
    await rejects(() => op(db, "runDraw", {}), "failed-precondition", /legal/);
    const s = await op(db, "updateSettings", { patch: { servicesPointsRate: 8 } });
    assert.strictEqual(s.servicesPointsRate, 8);
    const r = await sale(db, "0712345678", [svc(100)]); assert.strictEqual(r.transaction.pointsRateSnapshot.services, 8);
    await rejects(() => op(db, "updateSettings", { patch: { servicesPointsRate: 5000 } }), "invalid-argument");
  });
  await test("customer access: own account only, phone comes from the token, no redeem action", async () => {
    const db = fresh();
    await sale(db, "0712345678", [svc(100)]); await sale(db, "0723456789", [svc(300)]);
    const mine = await handleCustomer(db, { uid: "u1", phone: "+254712345678" }, "summary", {});
    assert.strictEqual(mine.customer.pointsBalance, 7); assert(!("authUid" in mine.customer));
    assert(mine.tx.every((t) => t.phone === "+254712345678"));
    await rejects(() => handleCustomer(db, { uid: "u2", phone: "+254712345678" }, "summary", {}), "permission-denied");
    await rejects(() => handleCustomer(db, { uid: "u1", phone: "+254712345678" }, "redeem", { points: 100 }), "invalid-argument");
    assert.deepStrictEqual(await handleCustomer(db, { uid: "u9", phone: "+254799999999" }, "summary", {}), { registered: false });
    await handleCustomer(db, { uid: "u1", phone: "+254712345678" }, "setMarketing", { value: true });
    assert.strictEqual(db.read("perks_customers/254712345678").marketingConsent, true);
    assert(db.list("perks_consentLog").length >= 1);
  });
  await test("delivery reports: webhook updates the log row; failure re-opens retry; late DELIVERED fixes it", async () => {
    const { handleHpWebhook } = require(path.join(__dirname, "..", "lib", "sms", "webhook"));
    const { registerSmsProduct } = require(path.join(__dirname, "..", "lib", "sms", "registry"));
    const { recordDispatch } = require(path.join(__dirname, "..", "lib", "sms", "dispatch"));
    const { perksDlr } = lib("dlr");
    const db = fresh();
    registerSmsProduct("perks", (ev, d) => perksDlr(db, ev, d));
    await sale(db, "0712345678", [svc(100)]);
    const row = () => db.list("perks_smsLog").map((p) => db.read(p)).find((l) => l.templateId === "sale");
    const l0 = row(); assert(l0.providerMessageId && l0.delivery === "UNKNOWN");
    // mirror what hpSms does after an accepted send (the stub sender bypasses it)
    await recordDispatch(db, { product: "perks", ref: `perks_smsLog/${l0.id}`, mobile: "254712345678", message: l0.message, raw: { status: "success", transactionId: l0.providerMessageId } });
    const hit = (q) => handleHpWebhook(db, { method: "GET", query: { t: "tok", ...q }, body: {}, headers: {} }, "tok");
    assert.strictEqual((await hit({ msgid: l0.providerMessageId, mobile: "254712345678", status: "UNDELIV", errorcode: "13", description: "Absent subscriber" })).status, 200);
    assert.strictEqual(row().status, "FAILED"); assert.strictEqual(row().delivery, "UNDELIVERED"); assert(/Absent subscriber/.test(row().error));
    const r = await op(db, "retrySms", { id: l0.id }); assert.strictEqual(r.status, "SENT");
    await hit({ msgid: l0.providerMessageId, mobile: "254712345678", status: "DELIVRD", donetime: "2026-11-22 10:15:00" });
    assert.strictEqual(row().delivery, "DELIVERED"); assert(row().deliveredAt > 0);
  });
  await test("createCustomer: idempotent, welcome SMS once, usable for a first sale, unknown phone rejected", async () => {
    const db = fresh();
    const a = await op(db, "createCustomer", { phone: "0712345678" });
    assert.strictEqual(a.created, true); assert(a.customer.referralCode);
    assert(sent.some((m) => /Welcome to Samuhia Perks/.test(m.message) && m.message.includes(a.customer.referralCode)));
    const n = sent.length, b = await op(db, "createCustomer", { phone: "+254712345678" });
    assert.strictEqual(b.created, false); assert.strictEqual(sent.length, n, "no second welcome");
    await rejects(() => op(db, "createCustomer", { phone: "12" }), "invalid-argument");
    const s = await sale(db, "0712345678", [svc(100)]); assert.strictEqual(s.customer.referralCode, a.customer.referralCode);
    assert.strictEqual(db.list("perks_customers").length, 1);
  });
  await test("list: newest first, since filter, limit up to 1000, unknown collection refused", async () => {
    const db = fresh();
    await sale(db, "0712345678", [svc(100)]); await sale(db, "0712345678", [svc(200)]);
    const all = (await op(db, "list", { collection: "tx", limit: 1000 })).items; assert.strictEqual(all.length, 2); assert(all[0].createdAt >= all[1].createdAt);
    const none = (await op(db, "list", { collection: "tx", since: Date.now() + 60_000 })).items; assert.strictEqual(none.length, 0);
    const some = (await op(db, "list", { collection: "tx", since: Date.now() - 60_000 })).items; assert.strictEqual(some.length, 2);
    await rejects(() => op(db, "list", { collection: "authOtp" }), "invalid-argument");
  });
  await test("static: portable folder, credentials from the bundle only, SMS functions bind secrets", () => {
    const dir = path.join(__dirname, "..", "src", "perks");
    for (const f of fs.readdirSync(dir)) {
      const t = fs.readFileSync(path.join(dir, f), "utf8");
      assert(!/process\.env/.test(t), f + " reads the environment");
      if (f !== "deps.ts") assert(!/from\s+["']\.\.\//.test(t), f + " imports outside perks/ (only deps.ts may)");
    }
    const idx = fs.readFileSync(path.join(dir, "index.ts"), "utf8");
    assert(/export const perks_op = onCall\(\{[^}]*secrets: SECRETS/.test(idx), "perks_op must bind SECRETS");
    assert(/export \* from "\.\/perks"/.test(fs.readFileSync(path.join(__dirname, "..", "src", "index.ts"), "utf8")));
    const otp = fs.readFileSync(path.join(__dirname, "..", "src", "auth", "otp.ts"), "utf8");
    assert(/product === "perks"/.test(otp) && /Samuhia Perks verification code/.test(otp) && /Samuhia Payments verification code/.test(otp), "OTP keeps payments text and adds a perks variant");
    assert((otp.match(/cleanPhone\(req\.data\?\.phone, perks\)/g) || []).length === 2, "both send and verify use the perks-aware phone check");
  });
  console.log(`\nperks: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
