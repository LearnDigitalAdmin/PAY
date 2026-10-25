/* Landlord Watch service flows against an in-memory Firestore: lookup, masking, OTP unlock, connections, transcript quota,
 * KES 99 payment settlement. Run:  cd functions && npm run build && node test/landlord-watch-service.check.js */
const assert = require("assert");
const path = require("path");
process.env.MYCHAMA_ID_PEPPER = "test-pepper";
const admin = require("firebase-admin");
const lib = (p) => require(path.join(__dirname, "..", "lib", "landlordWatch", p));
const svc = lib("service");
const { settleTranscriptPayment, failTranscriptPayment } = lib("payments");
const { LwError } = lib("errors");

// ---------- tiny in-memory Firestore (deep merge, subcollections, where ==, transactions, FieldValue) ----------
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const kind = (v) => {
  if (!v || typeof v !== "object" || !(v instanceof admin.firestore.FieldValue)) return null;
  if (v.isEqual(admin.firestore.FieldValue.delete())) return "delete";
  if (v.isEqual(admin.firestore.FieldValue.serverTimestamp())) return "ts";
  if (typeof v.operand === "number") return "inc";
  return null;
};
function merge(cur, data, deep) {
  const out = { ...(cur || {}) };
  for (const [k, v] of Object.entries(data)) {
    const kd = kind(v);
    if (kd === "delete") delete out[k];
    else if (kd === "ts") out[k] = new Date().toISOString();
    else if (kd === "inc") out[k] = (Number(out[k]) || 0) + v.operand;
    else if (deep && v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && !v.toDate) out[k] = merge(out[k], v, true);
    else out[k] = v instanceof Date ? { toDate: () => v, _iso: v.toISOString() } : clone(v);
  }
  return out;
}
class Snap { constructor(path, d) { this.id = path.split("/").pop(); this.exists = d !== undefined; this._d = d; } data() { return this._d === undefined ? undefined : this._d; } }
class Q { constructor(docs) { this.docs = docs; this.size = docs.length; } forEach(f) { this.docs.forEach(f); } }
class Doc {
  constructor(db, p) { this.db = db; this.path = p; this.id = p.split("/").pop(); }
  collection(n) { return new Coll(this.db, `${this.path}/${n}`); }
  async get() { return new Snap(this.path, this.db.store.get(this.path)); }
  async set(d, o) { this.db.store.set(this.path, merge(o && o.merge ? this.db.store.get(this.path) : {}, d, !!(o && o.merge))); }
  async update(d) { if (!this.db.store.has(this.path)) throw new Error("NOT_FOUND"); this.db.store.set(this.path, merge(this.db.store.get(this.path), d, false)); }
  async delete() { this.db.store.delete(this.path); }
}
class Coll {
  constructor(db, p, f = []) { this.db = db; this.path = p; this.f = f; }
  doc(id) { return new Doc(this.db, `${this.path}/${id}`); }
  where(field, op, value) { assert.strictEqual(op, "=="); return new Coll(this.db, this.path, [...this.f, { field, value }]); }
  async get() {
    const docs = [];
    for (const [p, d] of this.db.store) {
      if (p.startsWith(this.path + "/") && !p.slice(this.path.length + 1).includes("/") && this.f.every((x) => d[x.field] === x.value)) docs.push({ id: p.split("/").pop(), exists: true, data: () => d });
    }
    return new Q(docs);
  }
}
class FakeDb {
  constructor() { this.store = new Map(); }
  collection(p) { return new Coll(this, p); }
  async runTransaction(fn) {
    const writes = [];
    const tx = { get: (r) => r.get(), set: (r, d, o) => writes.push(() => r.set(d, o)), update: (r, d) => writes.push(() => r.update(d)), delete: (r) => writes.push(() => r.delete()) };
    const out = await fn(tx);
    for (const w of writes) await w();
    return out;
  }
}

// ---------- fixtures ----------
const OWNER_PHONE = "+254711000000";
function seed(db) {
  db.store.set("propertyOwnerIds/PYP-0001", { ownerId: "PYP-0001", userId: "7", propertyId: "3" });
  db.store.set("users/7/properties/3", { name: "Sunrise Apartments", address: "Naivasha", maxUnits: 6, agentCommissionRate: 10, ownerId: "PYP-0001", ownerPhone: OWNER_PHONE });
  const tn = (id, name, rent) => db.store.set(`users/7/tenants/${id}`, { localId: id, propertyId: 3, name, phone: "+254722000" + id + "00", unitNumber: "U" + id, rentAmount: rent, isActive: true });
  tn(1, "Amina Wanjiru", 14000); tn(2, "Daniel Otieno", 18000);
  const inv = (id, tid, rent, total, paid, date) => db.store.set(`users/7/invoices/${id}`, { localId: id, propertyId: 3, tenantId: tid, billingMonth: "2026-10", rentAmount: rent, totalAmount: total, amountPaid: paid, dueDate: "2026-10-05", paidDate: date });
  inv(1, 1, 14000, 15000, 15000, "2026-10-04"); inv(2, 2, 18000, 20000, 0, null);
  db.store.set("users/7/invoices/1/payments/1", { amount: 15000, paymentDate: "2026-10-04" });
}
let sms; let clock; let pdfFails; let charges; let paystackVerify;
function mkDeps(db) {
  return {
    db, now: () => new Date(clock),
    otp: { now: () => clock, code: () => "123456", sendSms: async (phone, msg) => { sms.push({ phone, msg }); return true; } },
    pdf: async () => { if (pdfFails) throw new Error("chromium crashed"); return Buffer.from("%PDF-fake"); },
    storage: { save: async () => undefined, signedUrl: async (p) => `https://signed.example/${p}?sig=1` },
    paystack: { charge: async (payload) => { charges.push(payload); return { status: "pay_offline", displayText: "Enter your M-Pesa PIN" }; }, verify: async () => paystackVerify },
    checkPhone: (raw) => (/^\+?2547\d{8}$|^07\d{8}$/.test(String(raw)) ? { ok: true, e164: String(raw).startsWith("07") ? "+254" + String(raw).slice(1) : String(raw).startsWith("+") ? raw : "+" + raw } : { ok: false, message: "Enter a valid Safaricom number." }),
    settle: settleTranscriptPayment,
  };
}
const PMS = (phone = null, key = "u_land") => ({ key, channel: "pms", phone });
const CYBER = { key: "u_agent", channel: "cyber", phone: null };
const WA = (phone) => ({ key: "w_" + phone.slice(1), channel: "whatsapp", phone });
const ctx = (deps, actor, lang = "en") => ({ deps, actor, lang });
const rejects = async (fn, code, extra) => { try { await fn(); } catch (e) { assert.ok(e instanceof LwError, "not an LwError: " + e); assert.strictEqual(e.code, code); if (extra) for (const [k, v] of Object.entries(extra)) assert.strictEqual(e.extra[k], v); return; } assert.fail("expected " + code); };

let passed = 0, failed = 0;
const test = async (name, fn) => {
  const db = new FakeDb(); seed(db); sms = []; charges = []; pdfFails = false; paystackVerify = null; clock = Date.parse("2026-10-23T08:00:00Z");
  try { await fn(db, mkDeps(db)); passed++; console.log("  ✓", name); } catch (e) { failed++; console.error("  ✗", name, "\n", e); }
};

(async () => {
  await test("lookup: PMS sees general data, CYBER sees it masked, bad/unknown ids are handled", async (db, d) => {
    const a = await svc.lookupProperty(ctx(d, PMS()), { ownerId: " pyp-0001 " });
    assert.deepStrictEqual([a.found, a.property.name, a.property.address, a.property.ownerPhoneMasked], [true, "Sunrise Apartments", "Naivasha", "07•• ••• 000"]);
    const c = await svc.lookupProperty(ctx(d, CYBER), { ownerId: "PYP-0001" });
    assert.strictEqual(c.property.name, "S••• A•••"); assert.strictEqual(c.property.address, "••••••••");
    assert.deepStrictEqual(await svc.lookupProperty(ctx(d, PMS()), { ownerId: "PYP-9999" }), { found: false });
    await rejects(() => svc.lookupProperty(ctx(d, PMS()), { ownerId: "ABC" }), "LW_BAD_OWNER_ID");
  });

  await test("lookup is rate limited (20 per hour per actor)", async (db, d) => {
    for (let i = 0; i < 20; i++) await svc.lookupProperty(ctx(d, PMS()), { ownerId: "PYP-9999" });
    await rejects(() => svc.lookupProperty(ctx(d, PMS()), { ownerId: "PYP-9999" }), "LW_RATE_LIMITED");
  });

  await test("PMS must connect before reading; snapshot is 'tenant' level until unlocked", async (db, d) => {
    await rejects(() => svc.getSnapshot(ctx(d, PMS()), { ownerId: "PYP-0001" }), "LW_NOT_ALLOWED");
    const { connection } = await svc.connect(ctx(d, PMS()), { ownerId: "PYP-0001" });
    assert.strictEqual(connection.unlocked, false);
    const r = await svc.getSnapshot(ctx(d, PMS()), { ownerId: "PYP-0001", month: "2026-10" });
    assert.strictEqual(r.snapshot.mask.level, "tenant"); assert.strictEqual(r.snapshot.mask.reason, "locked"); assert.strictEqual(r.snapshot.mask.canUnlock, true);
    assert.strictEqual(r.snapshot.summary.billed.v, 35000); assert.strictEqual(r.snapshot.summary.commission.onCollected.v, 1400);
    assert.strictEqual(r.snapshot.tenants[0].name, "D••• O•••");
    const again = await svc.getSnapshot(ctx(d, PMS()), { ownerId: "PYP-0001", month: "2026-10", ifNoneMatch: r.etag });
    assert.deepStrictEqual(again, { notModified: true, etag: r.etag });
  });

  await test("OTP unlock: wrong code, cool-down, success -> open; one unlock covers every property with the same phone", async (db, d) => {
    db.store.set("propertyOwnerIds/PYP-0002", { ownerId: "PYP-0002", userId: "7", propertyId: "4" });
    db.store.set("users/7/properties/4", { name: "Second Plaza", maxUnits: 2, agentCommissionRate: 5, ownerId: "PYP-0002", ownerPhone: OWNER_PHONE });
    const c = ctx(d, PMS());
    await svc.connect(c, { ownerId: "PYP-0001" }); await svc.connect(c, { ownerId: "PYP-0002" });
    const sent = await svc.unlockSendOtp(c, { ownerId: "PYP-0001" });
    assert.strictEqual(sent.sentTo, "07•• ••• 000"); assert.strictEqual(sms[0].phone, OWNER_PHONE); assert.ok(sms[0].msg.includes("123456"));
    await rejects(() => svc.unlockSendOtp(c, { ownerId: "PYP-0001" }), "LW_OTP_COOLDOWN", { retryAfterSec: 60 });
    await rejects(() => svc.unlockVerifyOtp(c, { ownerId: "PYP-0001", code: "000000" }), "LW_OTP_WRONG", { attemptsLeft: 4 });
    const ok = await svc.unlockVerifyOtp(c, { ownerId: "PYP-0001", code: "123456" });
    assert.strictEqual(ok.level, "open");
    assert.strictEqual((await svc.getSnapshot(c, { ownerId: "PYP-0001" })).snapshot.tenants[0].name, "Daniel Otieno");
    assert.strictEqual((await svc.getSnapshot(c, { ownerId: "PYP-0002" })).snapshot.mask.level, "open");
    await rejects(() => svc.unlockVerifyOtp(c, { ownerId: "PYP-0001", code: "123456" }), "LW_OTP_EXPIRED"); // single use
    clock += 12 * 3_600_000 + 1000; // unlock expires after 12 h
    assert.strictEqual((await svc.getSnapshot(c, { ownerId: "PYP-0001" })).snapshot.mask.level, "tenant");
  });

  await test("5 wrong codes lock the code", async (db, d) => {
    const c = ctx(d, PMS()); await svc.connect(c, { ownerId: "PYP-0001" }); await svc.unlockSendOtp(c, { ownerId: "PYP-0001" });
    for (let i = 0; i < 4; i++) await rejects(() => svc.unlockVerifyOtp(c, { ownerId: "PYP-0001", code: "111111" }), "LW_OTP_WRONG");
    await rejects(() => svc.unlockVerifyOtp(c, { ownerId: "PYP-0001", code: "111111" }), "LW_OTP_LOCKED");
    await rejects(() => svc.unlockVerifyOtp(c, { ownerId: "PYP-0001", code: "123456" }), "LW_OTP_LOCKED");
  });

  await test("auto-unlock when the signed-in / WhatsApp phone is the owner phone (no OTP)", async (db, d) => {
    const c = ctx(d, PMS(OWNER_PHONE)); await svc.connect(c, { ownerId: "PYP-0001" });
    const r = await svc.getSnapshot(c, { ownerId: "PYP-0001" });
    assert.deepStrictEqual([r.snapshot.mask.level, r.snapshot.mask.reason, r.snapshot.mask.unlockedUntil], ["open", "auth_phone_match", null]);
    const w = ctx(d, WA(OWNER_PHONE)); await svc.connect(w, { ownerId: "PYP-0001" });
    assert.strictEqual((await svc.getSnapshot(w, { ownerId: "PYP-0001" })).snapshot.mask.level, "open");
    const other = ctx(d, WA("+254799999999")); await svc.connect(other, { ownerId: "PYP-0001" });
    assert.strictEqual((await svc.getSnapshot(other, { ownerId: "PYP-0001" })).snapshot.mask.level, "tenant");
  });

  await test("CYBER: everything masked before OTP; tenant PII stays masked after; 30 minute unlock; no connections", async (db, d) => {
    const c = ctx(d, CYBER);
    const pre = (await svc.getSnapshot(c, { ownerId: "PYP-0001" })).snapshot;
    assert.strictEqual(pre.mask.level, "full"); assert.strictEqual(pre.summary.billed.d, "KES ••,•••");
    assert.ok(!JSON.stringify(pre).includes("Daniel") && !JSON.stringify(pre).includes("35,000"));
    await svc.unlockSendOtp(c, { ownerId: "PYP-0001" });
    const v = await svc.unlockVerifyOtp(c, { ownerId: "PYP-0001", code: "123456" });
    assert.strictEqual(v.level, "tenant");
    assert.strictEqual(new Date(v.unlockedUntil).getTime() - clock, 30 * 60_000);
    const post = (await svc.getSnapshot(c, { ownerId: "PYP-0001" })).snapshot;
    assert.strictEqual(post.mask.level, "tenant"); assert.strictEqual(post.mask.reason, "channel_policy"); assert.strictEqual(post.mask.canUnlock, false);
    assert.strictEqual(post.summary.billed.v, 35000); assert.strictEqual(post.tenants[0].name, "D••• O•••");
    await rejects(() => svc.connect(c, { ownerId: "PYP-0001" }), "LW_NOT_ALLOWED");
  });

  await test("no owner phone on file: cannot unlock", async (db, d) => {
    db.store.set("users/7/properties/3", { ...db.store.get("users/7/properties/3"), ownerPhone: null });
    const c = ctx(d, PMS()); await svc.connect(c, { ownerId: "PYP-0001" });
    await rejects(() => svc.unlockSendOtp(c, { ownerId: "PYP-0001" }), "LW_NO_PHONE_ON_FILE");
    assert.strictEqual((await svc.getSnapshot(c, { ownerId: "PYP-0001" })).snapshot.mask.canUnlock, false);
  });

  await test("connections: list, disconnect", async (db, d) => {
    const c = ctx(d, PMS()); await svc.connect(c, { ownerId: "PYP-0001" });
    assert.strictEqual((await svc.listConnections(c)).connections[0].propertyName, "Sunrise Apartments");
    await svc.disconnect(c, { ownerId: "PYP-0001" });
    assert.strictEqual((await svc.listConnections(c)).connections.length, 0);
  });

  await test("transcript: first is FREE (OTP -> ready), second costs KES 99 and is paid via the webhook", async (db, d) => {
    const c = ctx(d, PMS(OWNER_PHONE)); await svc.connect(c, { ownerId: "PYP-0001" });
    assert.deepStrictEqual(await svc.transcriptQuota(c, { ownerId: "PYP-0001" }), { period: "2026-10", freeLimit: 1, freeUsed: 0, nextPriceKes: 0 });

    // Even an auto-unlocked landlord must enter an OTP to download.
    const t1 = await svc.transcriptStart(c, { ownerId: "PYP-0001", month: "2026-10" });
    assert.strictEqual(t1.state, "otp_pending"); assert.strictEqual(t1.priceKes, 0); assert.strictEqual(sms.length, 1);
    await rejects(() => svc.transcriptVerifyOtp(c, { requestId: t1.requestId, code: "999999" }), "LW_OTP_WRONG");
    const r1 = await svc.transcriptVerifyOtp(c, { requestId: t1.requestId, code: "123456" });
    assert.strictEqual(r1.state, "ready"); assert.ok(r1.url.includes(`landlord-watch/transcripts/PYP-0001/2026-10/${t1.requestId}.pdf`)); assert.strictEqual(r1.priceKes, 0);
    assert.strictEqual((await svc.transcriptQuota(c, { ownerId: "PYP-0001" })).freeUsed, 1);
    // Re-download within 24 h: no OTP, no charge.
    const again = await svc.transcriptStatus(c, { requestId: t1.requestId });
    assert.strictEqual(again.state, "ready"); assert.ok(again.url);
    assert.strictEqual((await svc.transcriptQuota(c, { ownerId: "PYP-0001" })).freeUsed, 1);

    // Second one this month: costs 99.
    clock += 120_000;
    const t2 = await svc.transcriptStart(c, { ownerId: "PYP-0001", month: "2026-09".replace("09", "10") });
    assert.strictEqual(t2.priceKes, 99);
    const v2 = await svc.transcriptVerifyOtp(c, { requestId: t2.requestId, code: "123456" });
    assert.strictEqual(v2.state, "payment_required"); assert.strictEqual(v2.priceKes, 99);
    await rejects(() => svc.transcriptPay(c, { requestId: t2.requestId, phone: "12345" }), "LW_PAYMENT_FAILED");
    const p2 = await svc.transcriptPay(c, { requestId: t2.requestId, phone: "0712345678" });
    assert.strictEqual(p2.state, "payment_pending"); assert.ok(p2.reference.startsWith(`LWT_${t2.requestId}_`));
    assert.strictEqual(charges[0].amount, 9900); assert.strictEqual(charges[0].currency, "KES");
    assert.strictEqual(charges[0].metadata.chargeType, "landlord_watch_transcript");
    assert.ok(!("split" in charges[0]) && !("subaccount" in charges[0]), "company revenue: no splits");
    assert.strictEqual(charges[0].mobile_money.phone, "+254712345678");

    // not paid yet -> status stays pending
    assert.strictEqual((await svc.transcriptStatus(c, { requestId: t2.requestId })).state, "payment_pending");

    // webhook: wrong amount is refused
    const bad = { amount: 5000, fees: 0 };
    await settleTranscriptPayment(db, p2.reference, bad, charges[0].metadata);
    assert.strictEqual((await svc.transcriptStatus(c, { requestId: t2.requestId })).state, "failed");
  });

  await test("webhook settles KES 99 exactly once, writes company revenue, and the next status call produces the PDF", async (db, d) => {
    const c = ctx(d, PMS(OWNER_PHONE)); await svc.connect(c, { ownerId: "PYP-0001" });
    db.store.set("lwQuota/PYP-0001_2026-10", { freeUsed: 1 });
    const t = await svc.transcriptStart(c, { ownerId: "PYP-0001", month: "2026-10" });
    await svc.transcriptVerifyOtp(c, { requestId: t.requestId, code: "123456" });
    const p = await svc.transcriptPay(c, { requestId: t.requestId, phone: "0712345678" });
    const data = { amount: 9900, fees: 150, reference: p.reference };
    await settleTranscriptPayment(db, p.reference, data, charges[0].metadata);
    await settleTranscriptPayment(db, p.reference, data, charges[0].metadata); // Paystack retries the webhook
    const rev = db.store.get(`platform_revenue/${p.reference}`);
    assert.strictEqual(rev.type, "landlord_watch_transcript"); assert.strictEqual(rev.grossAmount, 99); assert.strictEqual(rev.paystackFees, 1.5); assert.strictEqual(rev.netRevenue, 97.5);
    assert.strictEqual(db.store.get("platform_stats/totals").totalLandlordWatchTranscripts, 1);
    assert.strictEqual(db.store.get(`lwTranscripts/${t.requestId}`).state, "paid");
    const done = await svc.transcriptStatus(c, { requestId: t.requestId });
    assert.strictEqual(done.state, "ready"); assert.ok(done.url);
    assert.strictEqual((await svc.transcriptQuota(c, { ownerId: "PYP-0001" })).freeUsed, 1, "a paid transcript does not use the free allowance");
  });

  await test("a late webhook is caught by asking Paystack directly", async (db, d) => {
    const c = ctx(d, PMS(OWNER_PHONE)); await svc.connect(c, { ownerId: "PYP-0001" });
    db.store.set("lwQuota/PYP-0001_2026-10", { freeUsed: 1 });
    const t = await svc.transcriptStart(c, { ownerId: "PYP-0001", month: "2026-10" });
    await svc.transcriptVerifyOtp(c, { requestId: t.requestId, code: "123456" });
    const p = await svc.transcriptPay(c, { requestId: t.requestId, phone: "0712345678" });
    clock += 20_000; paystackVerify = { status: "success", data: { amount: 9900, fees: 0 } };
    assert.strictEqual((await svc.transcriptStatus(c, { requestId: t.requestId })).state, "ready");
    assert.ok(db.store.get(`platform_revenue/${p.reference}`));
  });

  await test("failed payment lets the user retry", async (db, d) => {
    const c = ctx(d, PMS(OWNER_PHONE)); await svc.connect(c, { ownerId: "PYP-0001" });
    db.store.set("lwQuota/PYP-0001_2026-10", { freeUsed: 1 });
    const t = await svc.transcriptStart(c, { ownerId: "PYP-0001", month: "2026-10" });
    await svc.transcriptVerifyOtp(c, { requestId: t.requestId, code: "123456" });
    const p = await svc.transcriptPay(c, { requestId: t.requestId, phone: "0712345678" });
    await failTranscriptPayment(db, p.reference, "cancelled by user");
    const s = await svc.transcriptStatus(c, { requestId: t.requestId });
    assert.strictEqual(s.state, "payment_required"); assert.strictEqual(s.error.code, "LW_PAYMENT_FAILED");
    assert.strictEqual((await svc.transcriptPay(c, { requestId: t.requestId, phone: "0712345678" })).state, "payment_pending");
  });

  await test("a free transcript whose generating call died is completed by the next status call", async (db, d) => {
    const c = ctx(d, PMS(OWNER_PHONE)); await svc.connect(c, { ownerId: "PYP-0001" });
    const t = await svc.transcriptStart(c, { ownerId: "PYP-0001", month: "2026-10" });
    await svc.transcriptVerifyOtp(c, { requestId: t.requestId, code: "123456" });
    // simulate a crash after the lock was taken: back to 'generating' with an old lock and no PDF
    const doc = db.store.get(`lwTranscripts/${t.requestId}`);
    db.store.set(`lwTranscripts/${t.requestId}`, { ...doc, state: "generating", storagePath: null, lockedAt: clock - 10 * 60_000 });
    assert.strictEqual((await svc.transcriptStatus(c, { requestId: t.requestId })).state, "ready");
    // a fresh lock (another call is still working) is left alone
    const t2 = await svc.transcriptStart(c, { ownerId: "PYP-0001", month: "2026-10" });
    db.store.set(`lwTranscripts/${t2.requestId}`, { ...db.store.get(`lwTranscripts/${t2.requestId}`), state: "generating", lockedAt: clock - 5_000 });
    assert.strictEqual((await svc.transcriptStatus(c, { requestId: t2.requestId })).state, "generating");
  });

  await test("a PDF failure does not burn the free transcript", async (db, d) => {
    const c = ctx(d, PMS(OWNER_PHONE)); await svc.connect(c, { ownerId: "PYP-0001" });
    const t = await svc.transcriptStart(c, { ownerId: "PYP-0001", month: "2026-10" });
    pdfFails = true;
    const r = await svc.transcriptVerifyOtp(c, { requestId: t.requestId, code: "123456" });
    assert.strictEqual(r.state, "failed");
    assert.strictEqual((await svc.transcriptQuota(c, { ownerId: "PYP-0001" })).freeUsed, 0);
  });

  await test("transcript requests are private to the actor that made them; months are validated", async (db, d) => {
    const c = ctx(d, PMS(OWNER_PHONE)); await svc.connect(c, { ownerId: "PYP-0001" });
    const t = await svc.transcriptStart(c, { ownerId: "PYP-0001", month: "2026-10" });
    await rejects(() => svc.transcriptStatus(ctx(d, PMS(null, "u_other")), { requestId: t.requestId }), "LW_NOT_FOUND");
    await rejects(() => svc.transcriptStart(c, { ownerId: "PYP-0001", month: "2027-01" }), "LW_BAD_MONTH");
    await rejects(() => svc.transcriptStart(c, { ownerId: "PYP-0001", month: "2026-03" }), "LW_BAD_MONTH"); // no data
    await rejects(() => svc.transcriptStart(c, { ownerId: "PYP-0001", month: "bad" }), "LW_BAD_MONTH");
  });

  await test("the agent's edited deductions flow into the snapshot (and bust the cache)", async (db, d) => {
    const c = ctx(d, PMS(OWNER_PHONE)); await svc.connect(c, { ownerId: "PYP-0001" });
    const first = await svc.getSnapshot(c, { ownerId: "PYP-0001", month: "2026-10" });
    assert.strictEqual(first.snapshot.summary.statement.source, "estimate");
    db.store.set("users/7/transcripts/3_2026-10", { propertyId: 3, billingMonth: "2026-10", status: "finalized", notes: null, contentKey: "v1", lastModified: "x",
      items: [{ description: "Collectable Rent", amount: 14000, isDeductible: false, sortOrder: 1 }, { description: "Roof repair", amount: 4000, isDeductible: true, sortOrder: 2 }] });
    const second = await svc.getSnapshot(c, { ownerId: "PYP-0001", month: "2026-10" });
    assert.strictEqual(second.snapshot.summary.statement.source, "agent");
    assert.strictEqual(second.snapshot.summary.net.payable.v, 10000);
    assert.notStrictEqual(second.etag, first.etag);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
