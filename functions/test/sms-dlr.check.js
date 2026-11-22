/* Shared HostPinnacle delivery tracking: parser, dispatch records, webhook security/idempotency, product routing.
 * Run:  cd functions && npm run build && node test/sms-dlr.check.js */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { FakeDb } = require("./fake-orderby");
const L = (p) => require(path.join(__dirname, "..", "lib", "sms", p));
const { parseCallback, normalizeStatus, extractProviderIds, normalizeMobile } = L("parse");
const { recordDispatch, applyDlr } = L("dispatch");
const { handleHpWebhook } = L("webhook");
const { registerSmsProduct } = L("registry");

let passed = 0, failed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log("  ✓", name); } catch (e) { failed++; console.error("  ✗", name, "\n", e); } };
const call = (db, over = {}) => handleHpWebhook(db, { method: "GET", query: {}, body: {}, headers: {}, ...over, query: { t: "secret", ...(over.query || {}) } }, "secret", 1_700_000_000_000);

(async () => {
  await test("status normalisation covers the usual SMPP/portal words", () => {
    const t = { DELIVRD: "DELIVERED", delivered: "DELIVERED", UNDELIV: "UNDELIVERED", EXPIRED: "EXPIRED", REJECTD: "REJECTED", failed: "FAILED", ENROUTE: "SENT", "Delivered to handset": "DELIVERED", "": "UNKNOWN", WHAT: "UNKNOWN" };
    for (const [k, v] of Object.entries(t)) assert.strictEqual(normalizeStatus(k), v, k);
    assert.strictEqual(normalizeMobile("0712 345 678"), "254712345678"); assert.strictEqual(normalizeMobile("+254712345678"), "254712345678");
  });
  await test("parser: query-style, JSON object, JSON array, nested wrapper, mixed-case keys, inbound ignored", () => {
    const a = parseCallback({ query: { msgId: "A1", MOBILE: "0712345678", Status: "DELIVRD", ErrorCode: "000" } }).events[0];
    assert.deepStrictEqual([a.providerId, a.mobile, a.status, a.code], ["A1", "254712345678", "DELIVERED", "000"]);
    assert.strictEqual(parseCallback({ body: { messageid: "B1", msisdn: "254722222222", dlrstatus: "FAILED", reason: "DND" } }).events[0].description, "DND");
    const arr = parseCallback({ body: [{ transactionId: 1, to: "0733333333", status: "DELIVERED" }, { transactionId: 2, to: "0744444444", status: "UNDELIVERED" }] });
    assert.strictEqual(arr.events.length, 2); assert.strictEqual(arr.events[1].status, "UNDELIVERED");
    assert.strictEqual(parseCallback({ body: { response: { reports: [{ guid: "G", mobile: "0711111111", status: "EXPIRED" }] } } }).events[0].status, "EXPIRED");
    const inb = parseCallback({ body: { from: "254799999999", message: "hello" } }); assert.strictEqual(inb.events.length, 0); assert.strictEqual(inb.inbound, 1);
    assert.strictEqual(parseCallback({ body: { random: "x" } }).events.length, 0);
    assert.strictEqual(parseCallback({ body: { id: "T", status: "DELIVRD", donetime: "1700000000" } }).events[0].at, 1_700_000_000_000);
  });
  await test("provider ids are found anywhere in a send response", () => {
    assert.deepStrictEqual(extractProviderIds({ status: "success", transactionId: "123" }), ["123"]);
    assert.deepStrictEqual(extractProviderIds({ response: { status: "success", data: [{ msgId: "a" }, { msgId: "b" }] } }).sort(), ["a", "b"]);
    assert.deepStrictEqual(extractProviderIds({ status: "success" }), []);
  });
  await test("dispatch record never stores the message body (OTP safety) and supports id-less sends", async () => {
    const db = new FakeDb();
    await recordDispatch(db, { product: "auth", mobile: "+254712345678", message: "Your code is 482913", raw: { status: "success", transactionId: "T9" } }, 1000);
    const [p] = db.list("sms_dispatch"); const d = db.read(p);
    assert.strictEqual(d.providerId, "T9"); assert.strictEqual(d.msgLen, 19); assert(!JSON.stringify(d).includes("482913"));
    assert(d.expireAt > d.createdAt);
    await recordDispatch(db, { product: "x", mobile: "0722222222", message: "m", raw: { status: "success" } }, 2000);
    assert.strictEqual(db.list("sms_dispatch").length, 2);
  });
  await test("webhook security: fails closed without token, rejects bad/missing token, rejects other methods", async () => {
    const db = new FakeDb();
    assert.strictEqual((await handleHpWebhook(db, { method: "GET", query: { t: "x" }, body: {}, headers: {} }, "")).status, 503);
    assert.strictEqual((await handleHpWebhook(db, { method: "GET", query: { t: "wrong" }, body: {}, headers: {} }, "secret")).status, 401);
    assert.strictEqual((await handleHpWebhook(db, { method: "GET", query: {}, body: {}, headers: {} }, "secret")).status, 401);
    assert.strictEqual((await handleHpWebhook(db, { method: "DELETE", query: { t: "secret" }, body: {}, headers: {} }, "secret")).status, 405);
    assert.strictEqual((await handleHpWebhook(db, { method: "POST", query: {}, body: {}, headers: { "x-webhook-token": "secret" } }, "secret")).status, 200);
    assert.strictEqual(db.list("sms_dlr_inbox").length, 1, "only authenticated requests are stored");
    assert(!JSON.stringify(db.read(db.list("sms_dlr_inbox")[0])).includes("secret"), "token never persisted");
  });
  await test("delivery flow: match by provider id, idempotent replay, never downgrade DELIVERED, late DELIVERED upgrades a failure", async () => {
    const db = new FakeDb();
    await recordDispatch(db, { product: "lmm", mobile: "0712345678", message: "rent due", raw: { transactionId: "M1" } }, 1000);
    const id = db.list("sms_dispatch")[0];
    assert.strictEqual((await call(db, { query: { msgid: "M1", status: "UNDELIV", errorcode: "13" } })).status, 200);
    assert.strictEqual(db.read(id).delivery, "UNDELIVERED"); assert.strictEqual(db.read(id).dlrCode, "13");
    await call(db, { query: { msgid: "M1", status: "UNDELIV", errorcode: "13" } });
    assert.strictEqual(db.list("sms_dlr_events").length, 1, "replay is one event");
    await call(db, { query: { msgid: "M1", status: "DELIVRD" } });
    assert.strictEqual(db.read(id).delivery, "DELIVERED");
    await call(db, { query: { msgid: "M1", status: "FAILED" } });
    assert.strictEqual(db.read(id).delivery, "DELIVERED", "never downgraded");
    const inbox = db.list("sms_dlr_inbox").map((p) => db.read(p)); assert(inbox.every((i) => typeof i.events === "number"));
  });
  await test("fallback match by mobile when the callback has no id; unmatched events are kept, not lost", async () => {
    const db = new FakeDb();
    await recordDispatch(db, { product: "x", mobile: "0712345678", message: "a", raw: { status: "success" } }, 1000);
    await call(db, { query: { mobile: "254712345678", status: "DELIVRD" } });
    assert.strictEqual(db.read(db.list("sms_dispatch")[0]).delivery, "DELIVERED");
    const r = await applyDlr(db, { providerId: "nope", mobile: null, status: "DELIVERED", rawStatus: "", code: null, description: null, at: 1, rawTime: null });
    assert.strictEqual(r.matched, false);
    await call(db, { query: { msgid: "ghost", status: "DELIVRD" } });
    assert(db.list("sms_dlr_inbox").length >= 2);
  });
  await test("product routing: handler runs once per status change, handler errors never fail the webhook", async () => {
    const db = new FakeDb(); const seen = [];
    registerSmsProduct("alpha", async (ev, d) => { seen.push([ev.status, d.ref]); });
    registerSmsProduct("boom", async () => { throw new Error("handler bug"); });
    await recordDispatch(db, { product: "alpha", ref: "alpha_log/1", mobile: "0711111111", message: "m", raw: { transactionId: "A" } });
    await recordDispatch(db, { product: "boom", ref: "x/1", mobile: "0722222222", message: "m", raw: { transactionId: "B" } });
    await call(db, { query: { msgid: "A", status: "DELIVRD" } }); await call(db, { query: { msgid: "A", status: "DELIVRD" } });
    assert.deepStrictEqual(seen, [["DELIVERED", "alpha_log/1"]]);
    assert.strictEqual((await call(db, { query: { msgid: "B", status: "DELIVRD" } })).status, 200);
  });
  await test("static: every HostPinnacle sender is tracked, webhook binds the secrets bundle", () => {
    const src = path.join(__dirname, "..", "src"), rd = (f) => fs.readFileSync(path.join(src, f), "utf8");
    assert(/setDispatchTracker|dispatchTracker/.test(rd("hpSms.ts")), "hpSms must call the tracker");
    assert(/trackDispatch/.test(rd("mychama/sms.ts")), "MyChama senders must be tracked");
    assert(/export const hpSmsWebhook = onRequest\(\{[^}]*secrets: BUNDLE_SECRETS/.test(rd("sms/index.ts")), "webhook must bind secrets");
    assert(!/process\.env/.test(rd("sms/webhook.ts") + rd("sms/index.ts")), "no env credentials");
    assert(/export \* from "\.\/sms"/.test(rd("index.ts")));
  });
  console.log(`\nsms-dlr: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
