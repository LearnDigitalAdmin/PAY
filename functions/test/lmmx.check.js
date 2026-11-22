/* LMMX (standalone Lipa Mdogo Mdogo) end to end against an in-memory Firestore and a mocked Paystack/SMS. No network, no emulator.
 * Run:  cd functions && npm run build && node test/lmmx.check.js   (exit 1 on failure) */
process.env.PAYSTACK_SECRET_KEY = "sk_test_x"; process.env.LMM_SEAL_KEY = "seal-key-for-tests";
process.env.HP_SMS_USERID = "u"; process.env.HP_SMS_APIKEY = "k"; process.env.HP_SMS_PASSWORD = "p"; process.env.HP_SMS_SENDERID = "s";
process.env.LMMX_HASH_PEPPER = "hash-pepper-test"; process.env.LMMX_OTP_PEPPER = "otp-pepper-test"; process.env.LMMX_QUOTE_KEY = "quote-key-test"; process.env.LMMX_BOT_KEY = "test-bot-key";
process.env.LMMX_FIELD_KEY = Buffer.alloc(32, 7).toString("base64");
const assert = require("assert"); const path = require("path"); const crypto = require("crypto"); const axios = require("axios");
const { FakeDb, install } = require("./lmm-fake-firestore");
const db = new FakeDb(); install(db);
const L = (p) => require(path.join(__dirname, "..", "lib", "lmmx", p));
const C = L("contract"), cr = L("crypto"), otp = L("otp"), tenants = L("tenants"), pay = L("payments"), settle = L("settle"), chg = L("changes"), store = L("store"), authz = L("authz"), idx = L("index"), cyc = L("cycles");

let passed = 0, failed = 0; const queue = [];
const ok = (name, fn) => queue.push([name, fn]);
const sms = [], transfers = [], charges = new Map(), recipients = new Map(), splits = [];
const resetMocks = () => { sms.length = 0; transfers.length = 0; charges.clear(); recipients.clear(); splits.length = 0; };
axios.post = async (url, body) => {
  if (url.includes("hostpinnacle")) { const p = new URLSearchParams(body); sms.push({ mobile: p.get("mobile"), msg: p.get("msg") }); return { data: { status: "success" } }; }
  if (url.endsWith("/transferrecipient")) { const code = "RCP_t" + (recipients.size + 1); recipients.set(code, { type: body.type, bank_code: body.bank_code, account_number: body.account_number }); return { data: { status: true, data: { recipient_code: code } } }; }
  if (url.endsWith("/split")) { splits.push(body); return { data: { status: true, data: { split_code: "SPL_t" + splits.length } } }; }
  if (url.endsWith("/charge")) { charges.set(body.reference, { amount: body.amount, status: "pending", split: body.split_code }); return { data: { status: true, data: { status: "pay_offline", display_text: "Enter PIN" } } }; }
  if (url.endsWith("/transfer")) { transfers.push(body); return { data: { status: true, data: { status: "pending", transfer_code: "TRF_" + transfers.length } } }; }
  throw new Error("unexpected POST " + url);
};
axios.get = async (url) => {
  let m = url.match(/\/transaction\/verify\/(.+)$/);
  if (m) { const c = charges.get(decodeURIComponent(m[1])); if (!c) throw new Error("404"); return { data: { status: true, data: { status: c.status, reference: decodeURIComponent(m[1]), amount: c.amount, currency: "KES", fees: Math.round(c.amount * 0.015) } } }; }
  m = url.match(/\/transferrecipient\/(.+)$/);
  if (m) { const r = recipients.get(decodeURIComponent(m[1])); if (!r) throw new Error("404"); return { data: { status: true, data: { recipient_code: decodeURIComponent(m[1]), type: r.type, active: true, details: { account_number: r.account_number, bank_code: r.bank_code } } } }; }
  if (url.includes("/bank/resolve")) return { data: { status: true, data: { account_name: "JOHN KAMAU MWANGI" } } };
  throw new Error("unexpected GET " + url);
};

const DESK = { uid: "D1", deskCode: "COG-0012", rank: "clerk", isTop: false, phone: "+254700000012", ip: "1.2.3.4" };
const DESK2 = { uid: "D2", deskCode: "COG-0013", rank: "clerk", isTop: false, phone: "+254700000013", ip: "1.2.3.4" };
const TOP = { uid: "T1", deskCode: "COG-0000", rank: "internal", isTop: true, phone: "+254700000000", ip: "1.2.3.4", reason: "testing the top desk path" };
const world = () => {
  db.store.clear(); resetMocks();
  db.seed("lmm_config/standalone", { enabled: true });
  db.seed("agents/D1", { paymentInfo: { accountId: "ACCT_desk1" } }); db.seed("agents/D2", { paymentInfo: { accountId: "ACCT_desk2" } });
  db.seed("desk_agents/D1", { agentId: "D1", agentCode: "COG-0012", status: "active", rank: "clerk", phone: "+254700000012" });
  db.seed("desk_agents/D2", { agentId: "D2", agentCode: "COG-0013", status: "active", rank: "clerk", phone: "+254700000013" });
};
const input = (o = {}) => ({
  profile: { fullName: "Mary Wanjiru", phone: "0712345678", idType: "national_id", idNumber: "12345678", unitNumber: "A4", propertyName: "Sunrise" }, rentMinor: 1_000_000, dueDay: 5, frequency: "weekly",
  recipient: { channel: "till", accountNumber: "654321", accountName: "John Kamau Mwangi", contactName: "John Kamau", contactPhone: "0722111222" }, idempotencyKey: "idem-" + Math.random().toString(36).slice(2, 12), ...o,
});
const tenantSms = () => sms.filter((s) => s.mobile === "254712345678").map((s) => s.msg);
const codeFrom = (msg) => (msg.match(/LMM(\d{4})/) || [])[1];
const setup = async (o = {}, desk = DESK) => { const r = await tenants.createTenant(desk, input(o)); const ph = "254" + String((o.profile || input().profile).phone).slice(1); const code = codeFrom(sms.filter((s) => s.mobile === ph).pop().msg); return { r, code, id: r.tenantId }; };
const activate = async (o = {}, desk = DESK) => { const s = await setup(o, desk); await tenants.confirmSetup({ tenantId: s.id, otp: s.code, via: "desk", desk }); return s; };
const rej = async (p, code) => { try { await p; } catch (e) { const got = e.lmmx || (e.details && e.details.lmmx); assert.strictEqual(got, code, `expected ${code}, got ${got} ${e.message}`); return; } assert.fail(`expected ${code}`); };
const backdate = (tid) => { const t = db.store.get(`lmm_tenants/${tid}`); t.landlordNoticeAt = 1; const r = db.store.get(`lmmx_recipients/${t.activeRecipientId}`); r.verifiedAt = 1; };
const payAndCredit = async (tid, creditMinor, { tamper = 0 } = {}) => {
  const t = db.store.get(`lmm_tenants/${tid}`);
  const q = await pay.makeQuote(t, creditMinor); const out = await pay.startPayment(t, q.quoteId, "0712345678");
  const c = charges.get(out.reference); c.status = "success"; c.amount += tamper;
  const res = await pay.creditPayment(out.reference, c.amount);
  db.store.get(`lmmx_payments/${out.reference}`).createdAt = 1;   // let the next prompt through
  return { q, out, res };
};

// ------------------------------------------------------------------------------------------------------------- fee engine
ok("fee rows match the contract table (till, rent KES 10,000)", () => {
  const rows = [[10_000, 10_600, 225], [50_000, 52_300, 750], [250_000, 260_200, 2812], [500_000, 517_900, 3750], [1_000_000, 1_035_700, 7500]];
  for (const [x, g, d] of rows) { const q = C.quoteInstalment({ creditMinor: x, rentMinor: 1_000_000, channel: "till" }); assert.strictEqual(q.chargeMinor, g); assert.strictEqual(q.deskShareMinor, d); }
});
ok("pricing v2.1: lowered service bands, 75% desk share, and the safe transfer reserve (x1.2 + KES 5) is unchanged; the credit is never reduced", () => {
  assert.deepStrictEqual(C.LMMX.SERVICE_BANDS.map((b) => b.bps), [400, 300, 200, 150, 100]);
  assert.strictEqual(C.LMMX.DESK_SHARE_BPS, 7_500); assert.strictEqual(C.LMMX.TRANSFER_UPLIFT_BPS, 12_000); assert.strictEqual(C.LMMX.TRANSFER_BUFFER_MINOR, 500); assert.strictEqual(C.LMMX.COLLECTION_BPS, 150);
  for (const x of [1_000, 9_900, 10_000, 49_900, 50_000, 199_900, 200_000, 499_900, 500_000, 1_500_000]) {
    const q = C.quoteInstalment({ creditMinor: x, rentMinor: 1_500_000, channel: "till" });
    assert.strictEqual(q.creditMinor, x); assert.strictEqual(q.deskShareMinor + q.platformShareMinor, q.serviceFeeMinor); assert.ok(q.platformShareMinor >= 0 && q.deskShareMinor <= q.serviceFeeMinor);
  }
  // a reserve that never undershoots Paystack's listed cost x 1.2 (till KES 80 -> at least KES 96 + 5)
  assert.ok(C.transferReserveMinor(200_000, "till") >= 9_600 + 500);
});
ok("the charge always covers credit + reserve + service after Paystack's 1.5% (2000 random cases, 3 channels)", () => {
  for (let i = 0; i < 2000; i++) {
    const ch = ["phone", "till", "bank"][i % 3], rent = (1000 + Math.floor(Math.random() * 149_000)) * 100;
    const x = Math.min(rent, (10 + Math.floor(Math.random() * Math.floor(rent / 100))) * 100);
    const q = C.quoteInstalment({ creditMinor: x, rentMinor: rent, channel: ch, remainingRentMinor: rent });
    assert.ok(C.quoteCoversCosts(q), JSON.stringify({ x, rent, ch })); assert.strictEqual(q.chargeMinor % 100, 0);
  }
});
ok("over a whole cycle the reserve is exactly the transfer cost and credits add up to the rent", () => {
  for (const ch of ["phone", "till", "bank"]) for (const step of [10_000, 130_000, 333_300]) {
    const R = 1_000_000; let left = R, col = 0;
    while (left > 0) { let x = Math.min(step, left); if (left - x > 0 && left - x < 1000) x = left; const q = C.quoteInstalment({ creditMinor: x, rentMinor: R, channel: ch, reserveCollectedMinor: col, remainingRentMinor: left }); col += q.transferReserveMinor; left -= x; }
    assert.strictEqual(col, C.transferReserveMinor(R, ch)); assert.strictEqual(left, 0);
  }
});
ok("OTP text, phone normalising, due dates", () => {
  assert.deepStrictEqual(C.parseLmmxCode("lmm 4683"), { kind: "otp", code: "4683" }); assert.deepStrictEqual(C.parseLmmxCode("LMC-7391"), { kind: "cancel", code: "7391" }); assert.strictEqual(C.parseLmmxCode("hi LMM4683"), null);
  assert.strictEqual(C.normalizeKePhone("0101716473"), "+254101716473"); assert.strictEqual(C.firstDueDate("2026-11-15", 5), "2026-12-05"); assert.strictEqual(C.firstDueDate("2026-11-15", 28), "2026-11-28");
});
ok("bot signature test vector from the contract", () => {
  const m = C.botSigMessage("lmmx_bot_lookup", 1700000000000, "n0nce-abc123", { phone: "+254712345678", idNumber: "12345678", ts: 1, nonce: "x", sig: "y" });
  assert.strictEqual(crypto.createHmac("sha256", "test-bot-key").update(m).digest("hex"), "da588a8808fbc5628fc90532e2fb078e1d10b7307ae6ed15b9b252cb121851f7");
});
ok("field encryption round-trips and a tampered ciphertext fails", () => {
  const t = cr.enc("0712345678"); assert.strictEqual(cr.dec(t), "0712345678"); assert.notStrictEqual(t, cr.enc("0712345678"));
  const parts = t.split("."); parts[3] = Buffer.from("zzzz").toString("base64url"); assert.throws(() => cr.dec(parts.join(".")));
  assert.notStrictEqual(cr.H("phone", "+254712345678"), cr.H("id", "+254712345678"));
});

// ------------------------------------------------------------------------------------------------------------- onboarding and OTP
ok("create sends M1: details + LMM code + the one-tap bot link, within 280 characters; nothing goes to the landlord yet", async () => {
  world(); const s = await setup();
  const m = tenantSms().pop() || "";
  assert.strictEqual(s.r.status, "awaiting_confirmation"); assert.match(s.code, /^\d{4}$/);
});
ok("M1 content", async () => {
  world(); const r = await tenants.createTenant(DESK, input()); const m = tenantSms().pop();
  assert.match(m, /LMM\d{4} valid 30 min/); assert.match(m, /wa\.me\/254101716473\?text=LMM\d{4}/); assert.ok(m.length <= 280, String(m.length)); assert.ok(!sms.some((x) => x.mobile === "254722111222"));
  assert.ok(db.store.get(`lmm_tenants/${r.tenantId}`).nameEnc.startsWith("v1."), "name is stored encrypted");
});
ok("no money and no cycle before the tenant confirms", async () => {
  world(); const s = await setup(); const t = db.store.get(`lmm_tenants/${s.id}`);
  await rej(pay.makeQuote(t, 10_000), "LMMX_E_STATE"); assert.strictEqual(db.list("lmmx_cycles").length, 0);
});
ok("the desk completes setup by typing the code: tenant becomes active, pay record is sealed, first cycle exists, M2 to tenant and M3 to landlord", async () => {
  world(); const s = await setup(); await tenants.confirmSetup({ tenantId: s.id, otp: s.code, via: "desk", desk: DESK });
  const t = db.store.get(`lmm_tenants/${s.id}`); assert.strictEqual(t.status, "active");
  const pr = db.store.get(`lmm_pay_records/${s.id}`); assert.strictEqual(pr.termsSig, tenants.termsSigOf(pr.termsHash));
  assert.strictEqual(db.list("lmmx_cycles").length, 1);
  assert.ok(tenantSms().some((m) => /is ready/.test(m) && /wa\.me\/254101716473/.test(m)));
  const l = sms.find((x) => x.mobile === "254722111222"); assert.ok(l && /plot\.samuhia\.co\.ke/.test(l.msg), "landlord gets the subtle link");
  await rej(tenants.confirmSetup({ tenantId: s.id, otp: s.code, via: "desk", desk: DESK }), "LMMX_E_STATE");
});
ok("a wrong code is refused; 5 wrong tries lock the code, even the right one", async () => {
  world(); const s = await setup();
  for (let i = 0; i < 5; i++) await rej(tenants.confirmSetup({ tenantId: s.id, otp: "0000" === s.code ? "1111" : "0000", via: "desk", desk: DESK }), "LMMX_E_OTP_INVALID");
  await rej(tenants.confirmSetup({ tenantId: s.id, otp: s.code, via: "desk", desk: DESK }), "LMMX_E_OTP_LOCKED");
});
ok("a code for one set of terms cannot confirm another (payload binding)", async () => {
  world(); const s = await setup(); db.store.get(`lmm_tenants/${s.id}`).rent.amountMinor = 2_000_000;   // terms changed after the code was sent
  await rej(tenants.confirmSetup({ tenantId: s.id, otp: s.code, via: "desk", desk: DESK }), "LMMX_E_OTP_INVALID");
});
ok("an expired code is refused", async () => {
  world(); const s = await setup(); db.store.get(`lmmx_otps/${s.id}_setup_-`).expiresAt = 1;
  await rej(tenants.confirmSetup({ tenantId: s.id, otp: s.code, via: "desk", desk: DESK }), "LMMX_E_OTP_EXPIRED");
});
ok("resend: at most 3 sends an hour and the old code stops working", async () => {
  world(); const s = await setup(); await tenants.resendSetupOtp(DESK, s.id); const c2 = codeFrom(tenantSms().pop());
  if (c2 !== s.code) await rej(tenants.confirmSetup({ tenantId: s.id, otp: s.code, via: "desk", desk: DESK }), "LMMX_E_OTP_INVALID");
  await tenants.resendSetupOtp(DESK, s.id); await rej(tenants.resendSetupOtp(DESK, s.id), "LMMX_E_RATE");
});
ok("the bot path: only the tenant's own WhatsApp number can confirm", async () => {
  world(); const s = await setup();
  const bot = async (phone, text) => idx.lmmx_bot_confirmCode.run({ data: signed("lmmx_bot_confirmCode", { phone, text }) });
  assert.strictEqual((await bot("+254799999999", `LMM${s.code}`)).result, "not_found");
  assert.strictEqual((await bot("+254712345678", `LMM${s.code}`)).result, "setup_confirmed");
  assert.strictEqual(db.store.get(`lmm_tenants/${s.id}`).status, "active");
});
const signed = (op, payload) => { const ts = Date.now(), nonce = "n-" + crypto.randomBytes(8).toString("hex"); const sig = crypto.createHmac("sha256", "test-bot-key").update(C.botSigMessage(op, ts, nonce, payload)).digest("hex"); return { ...payload, ts, nonce, sig }; };
ok("bot requests: replay, bad signature and stale timestamp are refused", async () => {
  world(); const d = signed("lmmx_bot_joinInfo", {}); await idx.lmmx_bot_joinInfo.run({ data: d });
  await rej(idx.lmmx_bot_joinInfo.run({ data: d }), "LMMX_E_SIG");
  await rej(idx.lmmx_bot_joinInfo.run({ data: { ...signed("lmmx_bot_joinInfo", {}), sig: "00" } }), "LMMX_E_SIG");
  const old = signed("lmmx_bot_joinInfo", {}); old.ts -= 10 * 60_000; await rej(idx.lmmx_bot_joinInfo.run({ data: old }), "LMMX_E_SIG");
});
ok("one active tenant per phone and per ID; a desk cannot register itself or use its own phone as landlord", async () => {
  world(); await activate(); await rej(tenants.createTenant(DESK, input()), "LMMX_E_DUPLICATE");
  await rej(tenants.createTenant(DESK, input({ profile: { ...input().profile, phone: "0700000012", idNumber: "99999999" } })), "LMMX_E_RECIPIENT_BLOCKED");
  await rej(tenants.createTenant(DESK, input({ profile: { ...input().profile, phone: "0733333333", idNumber: "88888888" }, recipient: { ...input().recipient, contactPhone: "0700000012" } })), "LMMX_E_RECIPIENT_BLOCKED");
});
ok("a desk sees only its own tenants; COG-0000 sees all; the answer for someone else's is 'not found'", async () => {
  world(); const s = await activate();
  await rej(tenants.getTenantView(DESK2, s.id), "LMMX_E_NOT_FOUND"); assert.strictEqual((await tenants.getTenantView(DESK, s.id)).tenantId, s.id); assert.strictEqual((await tenants.getTenantView(TOP, s.id)).tenantId, s.id);
  assert.strictEqual((await tenants.listTenants(DESK2, {})).tenants.length, 0); assert.strictEqual((await tenants.listTenants(DESK, {})).tenants.length, 1);
  assert.strictEqual((await tenants.listTenants(TOP, { q: "0712345678" })).tenants.length, 1);
});
ok("dedupe returns only the account number and flags, bound to the asking desk", async () => {
  world(); await activate(); const R = L("recipients");
  const c = await R.checkRecipient(DESK, { channel: "till", accountNumber: "654321", enteredName: "John Kamau Mwangi" });
  assert.deepStrictEqual(Object.keys(c).sort(), ["accountNumber", "exists", "nameMatchesEntered", "reusable", "reuseToken"]); assert.strictEqual(c.accountNumber, "654321");
  assert.strictEqual((await R.checkRecipient(DESK, { channel: "till", accountNumber: "111111", enteredName: "x y" })).exists, false);
  const second = input({ profile: { fullName: "Peter Otieno", phone: "0733000111", idType: "national_id", idNumber: "22222222" }, recipient: { ...input().recipient, reuseToken: c.reuseToken } });
  const r = await tenants.createTenant(DESK, second); assert.ok(r.tenantId);
  await rej(tenants.createTenant(DESK2, input({ profile: { fullName: "Anne Njeri", phone: "0733000222", idType: "national_id", idNumber: "33333333" }, recipient: { ...input().recipient, reuseToken: c.reuseToken } })), "LMMX_E_VALIDATION");
});

// ------------------------------------------------------------------------------------------------------------- money
ok("pay: signed quote, desk share on a flat split, credit once; a replayed webhook credits nothing; the landlord payout is exactly the credit", async () => {
  world(); const s = await activate(); backdate(s.id);
  const t = db.store.get(`lmm_tenants/${s.id}`);
  const q = await pay.makeQuote(t, 250_000); assert.strictEqual(q.chargeMinor, 260_200);
  const out = await pay.startPayment(t, q.quoteId, "0712345678"); assert.ok(charges.get(out.reference).split, "the charge carries the desk's flat split");
  assert.strictEqual(splits[0].subaccounts[0].share, 2812);
  const c = charges.get(out.reference); c.status = "success";
  assert.strictEqual(await pay.creditPayment(out.reference, c.amount), "credited"); assert.strictEqual(await pay.creditPayment(out.reference, c.amount), "ignored");
  const cy = db.list("lmmx_cycles").map((p) => db.store.get(p))[0]; assert.strictEqual(cy.creditedMinor, 250_000);
  assert.strictEqual(db.read(`lmm_tenants/${s.id}`).cur.remainingMinor, 750_000);
});
ok("a tampered quote, an expired quote and a paid amount that differs from the quote are all refused", async () => {
  world(); const s = await activate(); const t = db.store.get(`lmm_tenants/${s.id}`);
  const q = await pay.makeQuote(t, 100_000);
  await rej(pay.startPayment(t, q.quoteId.slice(0, -3) + "abc", "0712345678"), "LMMX_E_QUOTE");
  const r = await payAndCredit(s.id, 100_000, { tamper: -100 }); assert.strictEqual(r.res, "rejected"); assert.strictEqual(db.read(`lmmx_payments/${r.out.reference}`).status, "rejected");
  assert.strictEqual(db.list("lmmx_cycles").map((p) => db.store.get(p))[0].creditedMinor, 0);
});
ok("amount rules: whole shillings, minimum KES 10, never more than the balance", async () => {
  world(); const s = await activate(); const t = db.store.get(`lmm_tenants/${s.id}`);
  await rej(pay.makeQuote(t, 5_050), "LMMX_E_AMOUNT"); await rej(pay.makeQuote(t, 500), "LMMX_E_AMOUNT"); await rej(pay.makeQuote(t, 1_100_000), "LMMX_E_AMOUNT");
});
ok("fully paid: payout waits for the first-payout safety window, then pays EXACTLY the rent, once", async () => {
  world(); const s = await activate();
  await payAndCredit(s.id, 1_000_000); await new Promise((r) => setTimeout(r, 30));
  db.store.get(db.list("lmmx_cycles")[0]).lastAvailableOn = "2026-01-01";   // Paystack's T+2 has passed
  assert.strictEqual(await settle.settleCycle(db.list("lmmx_cycles")[0].split("/")[1]), "held:first_payout_window");
  assert.strictEqual(transfers.length, 0);
  backdate(s.id); const cid = db.list("lmmx_cycles")[0].split("/")[1];
  const first = await settle.settleCycle(cid); assert.ok(first.startsWith("queued:"), first);
  assert.strictEqual(transfers.length, 1); assert.strictEqual(transfers[0].amount, 1_000_000, "uncut");
  assert.ok(String(await settle.settleCycle(cid)).startsWith("none") || (await settle.settleCycle(cid)).startsWith("held"), "no second transfer"); assert.strictEqual(transfers.length, 1);
  await settle.onTransferEvent("transfer.success", { reference: transfers[0].reference, amount: 1_000_000, recipient: { recipient_code: transfers[0].recipient } });
  const cy = db.read(`lmmx_cycles/${cid}`); assert.strictEqual(cy.status, "settled"); assert.strictEqual(cy.settledMinor, 1_000_000);
  assert.ok(sms.some((x) => x.mobile === "254722111222" && /was sent to you/.test(x.msg)));
});
ok("due date with a partial credit: pays what is in, marks partial, and the top-up is ONE later transfer", async () => {
  world(); const s = await activate(); backdate(s.id); const cid = db.list("lmmx_cycles")[0].split("/")[1];
  await payAndCredit(s.id, 400_000); await new Promise((r) => setTimeout(r, 30));
  assert.ok((await settle.settleCycle(cid)).startsWith("held:not_due"));
  db.store.get(`lmmx_cycles/${cid}`).dueDate = "2026-01-01";   // the due date has come
  const r = await settle.settleCycle(cid); assert.ok(r.startsWith("queued:"), r); assert.strictEqual(transfers[0].amount, 400_000);
  await settle.onTransferEvent("transfer.success", { reference: transfers[0].reference, amount: 400_000 });
  let cy = db.read(`lmmx_cycles/${cid}`); assert.strictEqual(cy.status, "partial_settled"); assert.strictEqual(cy.legRentMinor, 600_000);
  await payAndCredit(s.id, 600_000); await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(transfers.length, 2, "the top-up went out once (queued by the credit itself)"); assert.strictEqual(transfers[1].amount, 600_000);
  await settle.onTransferEvent("transfer.success", { reference: transfers[1].reference, amount: 600_000 });
  cy = db.read(`lmmx_cycles/${cid}`); assert.strictEqual(cy.status, "settled"); assert.strictEqual(cy.settledMinor, 1_000_000);
});
ok("a tampered pay record freezes the tenant and sends nothing", async () => {
  world(); const s = await activate(); await payAndCredit(s.id, 1_000_000); await new Promise((r) => setTimeout(r, 30)); backdate(s.id); db.store.get(db.list("lmmx_cycles")[0]).lastAvailableOn = "2026-01-01";
  db.store.get(`lmm_pay_records/${s.id}`).termsHash = "f".repeat(64);
  const r = await settle.settleCycle(db.list("lmmx_cycles")[0].split("/")[1]); assert.strictEqual(r, "held:tamper"); assert.strictEqual(transfers.length, 0); assert.strictEqual(db.read(`lmm_tenants/${s.id}`).frozen, true);
});
ok("payouts pause when the kill switch is on; a frozen tenant cannot pay", async () => {
  world(); const s = await activate(); await payAndCredit(s.id, 1_000_000); await new Promise((r) => setTimeout(r, 30)); backdate(s.id); db.store.get(db.list("lmmx_cycles")[0]).lastAvailableOn = "2026-01-01";
  db.seed("lmm_config/standalone", { enabled: true, payoutsPaused: true }); store.clearFlagCache();
  assert.strictEqual(await settle.settleCycle(db.list("lmmx_cycles")[0].split("/")[1]), "held:paused");
  db.seed("lmm_config/standalone", { enabled: true }); store.clearFlagCache(); db.store.get(`lmm_tenants/${s.id}`).frozen = true;
  await rej(pay.makeQuote(db.store.get(`lmm_tenants/${s.id}`), 100_000), "LMMX_E_FROZEN");
});

// ------------------------------------------------------------------------------------------------------------- changes
const newAcct = (o = {}) => ({ channel: "till", accountNumber: "777888", accountName: "Peter Otieno", contactName: "Peter Otieno", contactPhone: "0722333444", ...o });
ok("payout change by a regular desk: tenant code, 48h cooling-off with the old account live, landlord notices, cancel code works", async () => {
  world(); const s = await activate(); const t0 = db.store.get(`lmm_tenants/${s.id}`); const oldR = t0.activeRecipientId;
  const rq = await chg.requestChange(DESK, { tenantId: s.id, kind: "recipient", recipient: newAcct(), idempotencyKey: "chg-key-0001" }); assert.strictEqual(rq.status, "awaiting_tenant_otp");
  const code = codeFrom(tenantSms().pop()); assert.ok(code);
  const done = await chg.confirmChange({ changeId: rq.changeId, otp: code, via: "desk", desk: DESK }); assert.strictEqual(done.status, "cooling_off");
  assert.ok(done.applyAfter - Date.now() > 47 * 3_600_000); assert.strictEqual(db.store.get(`lmm_tenants/${s.id}`).activeRecipientId, oldR, "old account stays live");
  assert.ok(sms.some((x) => x.mobile === "254722111222" && /different account/.test(x.msg)) && sms.some((x) => x.mobile === "254722333444"));
  const cancel = (tenantSms().pop().match(/LMC(\d{4})/) || [])[1]; assert.ok(cancel);
  await chg.cancelChangeByCode({ changeId: rq.changeId, code: cancel, via: "bot", tenantId: s.id });
  assert.strictEqual(db.read(`lmmx_changes/${rq.changeId}`).status, "cancelled");
});
ok("the sweep applies a confirmed change only after the cooling-off, and re-seals the pay record", async () => {
  world(); const s = await activate(); const rq = await chg.requestChange(DESK, { tenantId: s.id, kind: "recipient", recipient: newAcct(), idempotencyKey: "chg-key-0002" });
  await chg.confirmChange({ changeId: rq.changeId, otp: codeFrom(tenantSms().pop()), via: "desk", desk: DESK });
  assert.strictEqual(await chg.applyDueChanges(), 0);
  db.store.get(`lmmx_changes/${rq.changeId}`).applyAfter = 1; assert.strictEqual(await chg.applyDueChanges(), 1);
  const t = db.store.get(`lmm_tenants/${s.id}`); const pr = db.store.get(`lmm_pay_records/${s.id}`); assert.strictEqual(pr.recipientId, t.activeRecipientId); assert.strictEqual(pr.termsSig, tenants.termsSigOf(pr.termsHash));
});
ok("a regular desk cannot use the top-desk path; a rent change needs the tenant's code and applies", async () => {
  world(); const s = await activate();
  await rej(chg.requestChange(TOP, { tenantId: s.id, kind: "rent", rentMinor: 1_200_000, idempotencyKey: "chg-key-0003" }), "LMMX_E_VALIDATION");
  const rq = await chg.requestChange(DESK, { tenantId: s.id, kind: "rent", rentMinor: 1_200_000, idempotencyKey: "chg-key-0004" });
  await rej(chg.confirmChange({ changeId: rq.changeId, otp: "0000", via: "desk", desk: DESK }), "LMMX_E_OTP_INVALID");
  await chg.confirmChange({ changeId: rq.changeId, otp: codeFrom(tenantSms().pop()), via: "desk", desk: DESK });
  assert.strictEqual(db.read(`lmm_tenants/${s.id}`).rent.amountMinor, 1_200_000); assert.strictEqual(db.read(`lmm_pay_records/${s.id}`).rentMinor, 1_200_000);
});
ok("a COG-0000 change applies at once with no code, tells the tenant and both landlords, and is audited", async () => {
  world(); const s = await activate(); sms.length = 0;
  await chg.topUpdate(TOP, { tenantId: s.id, recipient: newAcct(), reason: "landlord asked in person" });
  const t = db.store.get(`lmm_tenants/${s.id}`); assert.strictEqual(db.store.get(`lmmx_recipients/${t.activeRecipientId}`).accountNumber, "777888");
  assert.ok(sms.some((x) => x.mobile === "254712345678" && /support updated/.test(x.msg)));
  assert.ok(db.list("lmmx_audit").some((p) => db.store.get(p).action === "top_update"));
});
ok("tenant due-day rules: once per cycle, 1 to 28, not within 5 days of the due date", async () => {
  world(); const s = await activate(); const cid = db.list("lmmx_cycles")[0].split("/")[1];
  const t = () => db.store.get(`lmm_tenants/${s.id}`);
  db.store.get(`lmmx_cycles/${cid}`).dueDate = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
  await rej(chg.setDueDay(t(), 31), "LMMX_E_VALIDATION"); const r = await chg.setDueDay(t(), 10); assert.strictEqual(r.dueDay, 10);
  await rej(chg.setDueDay(t(), 12), "LMMX_E_STATE");
  const s2 = await activate({ profile: { ...input().profile, phone: "0744000111", idNumber: "55555555" } }); const cid2 = db.list("lmmx_cycles").find((p) => p.includes(s2.id)).split("/")[1];
  db.store.get(`lmmx_cycles/${cid2}`).dueDate = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  await rej(chg.setDueDay(db.store.get(`lmm_tenants/${s2.id}`), 10), "LMMX_E_STATE");
});

// ------------------------------------------------------------------------------------------------------------- access rules
const topReq = (o = {}) => ({ auth: { uid: "T1", token: { email: "boss@samuhia.co.ke", email_verified: true, auth_time: Math.floor(Date.now() / 1000) - 60, ...o } }, rawRequest: { headers: {} } });
ok("top desk: needs COG-0000, a verified samuhia.co.ke email, a recent sign-in and a written reason (a missing reason is refused)", async () => {
  world(); db.seed("desk_agents/T1", { agentId: "T1", agentCode: "COG-0000", status: "active", rank: "internal" });
  assert.strictEqual((await authz.requireTop(topReq(), "writing a proper reason")).deskCode, "COG-0000");
  await rej(authz.requireTop(topReq(), ""), "LMMX_E_VALIDATION"); await rej(authz.requireTop(topReq(), "short"), "LMMX_E_VALIDATION");
  await rej(authz.requireTop(topReq({ auth_time: Math.floor(Date.now() / 1000) - 3600 }), "writing a proper reason"), "LMMX_E_NEEDS_REAUTH");
  await rej(authz.requireTop(topReq({ email: "boss@gmail.com" }), "writing a proper reason"), "LMMX_E_FORBIDDEN"); await rej(authz.requireTop(topReq({ email_verified: false }), "writing a proper reason"), "LMMX_E_FORBIDDEN");
  db.seed("desk_agents/T1", { agentId: "T1", agentCode: "COG-0012", status: "active", rank: "clerk" }); await rej(authz.requireTop(topReq(), "writing a proper reason"), "LMMX_E_FORBIDDEN");
  await rej(idx.lmmx_top_freeze.run(topReq()), "LMMX_E_FORBIDDEN");
});
ok("desks: an inactive agent and a frozen desk are refused; a missing sign-in is refused", async () => {
  world(); await rej(authz.requireDesk({ rawRequest: { headers: {} } }), "LMMX_E_AUTH");
  db.seed("desk_agents/D3", { agentId: "D3", agentCode: "COG-0014", status: "suspended" }); await rej(authz.requireDesk({ auth: { uid: "D3", token: {} }, rawRequest: { headers: {} } }), "LMMX_E_FORBIDDEN");
  db.seed("lmmx_locks/deskfreeze_COG-0012", { at: 1 }); await rej(authz.requireDesk({ auth: { uid: "D1", token: {} }, rawRequest: { headers: {} } }), "LMMX_E_FROZEN");
});
ok("tenant sign-in: the verified phone AND the linked uid must match; the link needs the right ID and gives one generic answer", async () => {
  world(); const s = await activate(); const T = (uid, phone) => ({ auth: { uid, token: { otp_phone: phone } }, rawRequest: { headers: {} } });
  await rej(authz.requireTenant(T("U1", "0712345678")), "LMMX_E_AUTH");
  await rej(tenants.tenantLink(T("U1", "0712345678"), "+254712345678", { idType: "national_id", idNumber: "99999999" }, "1.1.1.1"), "LMMX_E_NOT_FOUND");
  const r = await tenants.tenantLink(T("U1", "0712345678"), "+254712345678", { idType: "national_id", idNumber: "12345678" }, "1.1.1.1"); assert.deepStrictEqual(r.kinds, ["lmm"]);
  assert.strictEqual((await authz.requireTenant(T("U1", "0712345678"))).tenantId, s.id);
  await rej(authz.requireTenant(T("U2", "0712345678")), "LMMX_E_AUTH"); await rej(authz.requireTenant(T("U1", "0799999999")), "LMMX_E_AUTH");
  await rej(tenants.tenantLink(T("U2", "0712345678"), "+254712345678", { idType: "national_id", idNumber: "12345678" }, "1.1.1.1"), "LMMX_E_NOT_FOUND");
});


// ------------------------------------------------------------------------------------------------------------- top desk needs no codes
const sweep = L("sweep"), topM = L("top");
const seedTop = () => db.seed("desk_agents/T1", { agentId: "T1", agentCode: "COG-0000", status: "active", rank: "internal", phone: "+254700000000" });
ok("COG-0000 creates a tenant with NO code: active at once, no LMM code SMS, landlord and tenant still welcomed", async () => {
  world(); seedTop(); const r = await tenants.createTenant(TOP, input());
  assert.strictEqual(r.status, "active"); const t = db.store.get(`lmm_tenants/${r.tenantId}`); assert.strictEqual(t.status, "active");
  assert.ok(!sms.some((s) => /LMM\d{4}/.test(s.msg)), "no code was texted"); assert.strictEqual(db.store.get(`lmm_pay_records/${r.tenantId}`).setupOtpVia, "top");
  assert.ok(tenantSms().some((m) => /is ready/.test(m))); assert.ok(sms.some((x) => x.mobile === "254722111222" && /plot\.samuhia\.co\.ke/.test(x.msg)));
  assert.strictEqual(db.list("lmmx_cycles").length, 1);
});
ok("a regular desk still needs the tenant's code (nothing relaxed for them)", async () => {
  world(); const r = await tenants.createTenant(DESK, input()); assert.strictEqual(r.status, "awaiting_confirmation"); assert.ok(tenantSms().some((m) => /LMM\d{4}/.test(m)));
});
ok("COG-0000 changes rent and the payout account from the desk screen at once: no code, no cooling-off, tenant and landlords told", async () => {
  world(); seedTop(); const s = await activate();
  const rent = await idx.lmmx_desk_requestChange.run({ ...topReq(), data: { tenantId: s.id, kind: "rent", rentMinor: 1_200_000, idempotencyKey: "top-key-0001" } });
  assert.deepStrictEqual([rent.status, rent.requiresTenantOtp], ["applied", false]); assert.strictEqual(db.read(`lmm_tenants/${s.id}`).rent.amountMinor, 1_200_000);
  sms.length = 0;
  const acct = await idx.lmmx_desk_requestChange.run({ ...topReq(), data: { tenantId: s.id, kind: "recipient", recipient: newAcct(), idempotencyKey: "top-key-0002" } });
  assert.strictEqual(acct.status, "applied"); const t = db.store.get(`lmm_tenants/${s.id}`); assert.strictEqual(db.store.get(`lmmx_recipients/${t.activeRecipientId}`).accountNumber, "777888");
  assert.ok(!sms.some((x) => /LMM\d{4}|LMC\d{4}/.test(x.msg)), "no codes were texted"); assert.ok(sms.some((x) => x.mobile === "254722111222") && sms.some((x) => x.mobile === "254722333444"));
  assert.ok(db.list("lmmx_audit").some((p) => db.store.get(p).action === "top_update"));
  assert.strictEqual(db.list("lmmx_changes").length, 0, "no pending change was created");
});
ok("a regular desk is NOT let through the top path", async () => {
  world(); const s = await activate(); db.seed("desk_agents/D1", { agentId: "D1", agentCode: "COG-0012", status: "active", rank: "clerk", phone: "+254700000012" });
  const r = await idx.lmmx_desk_requestChange.run({ auth: { uid: "D1", token: {} }, rawRequest: { headers: {} }, data: { tenantId: s.id, kind: "rent", rentMinor: 1_200_000, idempotencyKey: "reg-key-0001" } });
  assert.strictEqual(r.status, "awaiting_tenant_otp"); assert.strictEqual(db.read(`lmm_tenants/${s.id}`).rent.amountMinor, 1_000_000);
});
ok("a top-desk tenant held for review is activated without a code when COG-0000 approves the landlord account", async () => {
  world(); seedTop(); const r = await tenants.createTenant(TOP, input({ recipient: { channel: "bank", bankCode: "063", accountNumber: "0123456789", accountName: "Totally Different Person", contactName: "Some One", contactPhone: "0722111222" } }));
  assert.strictEqual(r.status, "draft"); assert.ok(r.needsReview); const rid = db.store.get(`lmm_tenants/${r.tenantId}`).activeRecipientId; sms.length = 0;
  await topM.reviewDecision(TOP, { recipientId: rid, decision: "approve" });
  assert.strictEqual(db.read(`lmm_tenants/${r.tenantId}`).status, "active"); assert.ok(!sms.some((x) => /LMM\d{4}/.test(x.msg)), "no code");
});

// ------------------------------------------------------------------------------------------------------------- reminders and milestones (parity with legacy)
const rtenantBase = (o = {}) => ({ tenantId: "LMTREMINDER1", nameEnc: cr.enc("Mary Wanjiru"), phoneEnc: cr.enc("+254712345678"), status: "active", frequency: "weekly", createdAt: Date.now() - 20 * 86_400_000, lastPaymentAt: 0, lastSmsAt: 0, missedCount: 0, ...o });
const rtenant = rtenantBase;
const rcycle = (o = {}) => ({ cycleId: "LMTREMINDER1_202612", dueDate: "2026-12-05", payByDate: "2026-12-03", rentMinor: 1_000_000, creditedMinor: 0, settledMinor: 0, status: "open", ...o });
const kinds = (t, c, today, nowMs = Date.now()) => sweep.planReminders(t, c, today, nowMs).map((r) => r.kind);
ok("reminders: 5-day warning, pay-by day, due day, overdue every 3 days, nothing once the rent is covered", () => {
  assert.deepStrictEqual(kinds(rtenant(), rcycle(), "2026-11-30"), ["warn"]); assert.deepStrictEqual(kinds(rtenant(), rcycle(), "2026-12-03"), ["warn", "payby"]);
  assert.deepStrictEqual(kinds(rtenant(), rcycle(), "2026-12-05"), ["due"]); assert.deepStrictEqual(kinds(rtenant(), rcycle(), "2026-12-09"), ["overdue"]);
  assert.deepStrictEqual(kinds(rtenant(), rcycle({ creditedMinor: 1_000_000, status: "funded" }), "2026-12-03"), []);
  const k1 = sweep.planReminders(rtenant(), rcycle(), "2026-12-09", 0)[0].key, k2 = sweep.planReminders(rtenant(), rcycle(), "2026-12-10", 0)[0].key, k3 = sweep.planReminders(rtenant(), rcycle(), "2026-12-12", 0)[0].key;
  assert.strictEqual(k1, k2); assert.notStrictEqual(k1, k3);
});
ok("missed-instalment reminder follows the legacy rules: after the plan's quiet period, not within 3 days of another SMS, at most 3, never in the last week", () => {
  const far = "2026-11-10"; const now = Date.parse("2026-11-10T08:00:00Z"); const rtenant = (o = {}) => rtenantBase({ createdAt: now - 20 * 86_400_000, ...o });   // times relative to the fixed "now", so the test does not drift
  assert.deepStrictEqual(kinds(rtenant(), rcycle(), far, now), ["missed"]);
  assert.deepStrictEqual(kinds(rtenant({ lastSmsAt: now - 86_400_000 }), rcycle(), far, now), [], "an SMS went out yesterday");
  assert.deepStrictEqual(kinds(rtenant({ missedCount: 3 }), rcycle(), far, now), [], "3 already sent");
  assert.deepStrictEqual(kinds(rtenant({ lastPaymentAt: now - 86_400_000 }), rcycle(), far, now), [], "paid yesterday");
  assert.deepStrictEqual(kinds(rtenant({ status: "paused" }), rcycle(), far, now), []);
  assert.ok(!kinds(rtenantBase({ createdAt: Date.parse("2026-12-02T08:00:00Z") - 20 * 86_400_000 }), rcycle(), "2026-12-02", Date.parse("2026-12-02T08:00:00Z")).includes("missed"), "the last-week warnings take over");
  assert.ok(sweep.planReminders(rtenant(), rcycle(), far, now)[0].text.includes("Lipa Mdogo Mdogo"));
});
ok("milestones: one SMS each at 25/50/75 of the rent per cycle, 100 only recorded; a payment resets the missed count", async () => {
  world(); const s = await activate(); const t0 = db.store.get(`lmm_tenants/${s.id}`); t0.missedCount = 2;
  await payAndCredit(s.id, 250_000); await new Promise((r) => setTimeout(r, 30));
  assert.ok(tenantSms().some((m) => /25%/.test(m)), "25% message"); assert.strictEqual(db.read(`lmm_tenants/${s.id}`).missedCount, 0);
  const n25 = tenantSms().filter((m) => /paid 25%/.test(m)).length; await payAndCredit(s.id, 10_000);
  assert.strictEqual(tenantSms().filter((m) => /paid 25%/.test(m)).length, n25, "not repeated");
  await payAndCredit(s.id, 500_000); assert.ok(tenantSms().some((m) => /paid 75%/.test(m)), "75% message (760,000 of 1,000,000 is past 75%)");
  const cy = db.list("lmmx_cycles").map((p) => db.store.get(p))[0]; assert.ok(cy.milestonesSent.includes(25) && cy.milestonesSent.includes(50));
});
ok("no user-facing 'Lipa Mos Mos' is left in the legacy messages", () => {
  const fs = require("fs"); for (const f of ["lmm/plan.js", "lmm/sms.js", "lmm/index.js", "lmm/settle.js"]) { const src = fs.readFileSync(path.join(__dirname, "..", "lib", f), "utf8"); assert.ok(!/["`'][^"`'\n]*Lipa Mos Mos[^"`'\n]*["`']/.test(src.replace(/\/\/.*$/gm, "")), f); }
});


// ------------------------------------------------------------------------------------------------------------- pay my landlord now / withdraw
const pouts = L("payouts"), sweepM = L("sweep");
const OPS = "254791286165";
const wdCode = () => (tenantSms().filter((m) => /LMW\d{4}/.test(m)).pop().match(/LMW(\d{4})/) || [])[1];
const firstCycle = () => db.list("lmmx_cycles").map((p) => db.store.get(p))[0];
const DAY = 86_400_000;
/** an active plan that is 15 days old (past the 2-week wait), with a balance of `credit` paid in as one instalment */
const age = (id, days = 15) => { const t = db.store.get(`lmm_tenants/${id}`); const at = Date.now() - days * DAY; t.consentAt = at; t.activeSeal = tenants.activationSealOf(id, at); db.store.get(`lmm_pay_records/${id}`).setupCompletedAt = at; };
const funded = async (credit = 200_000) => { world(); const s = await activate(); age(s.id); await payAndCredit(s.id, credit); await new Promise((r) => setTimeout(r, 30)); return s; };
ok("withdraw: the number must be the phone on record; the code goes to that phone; nothing moves until the right code", async () => {
  const s = await funded(); const t = () => db.store.get(`lmm_tenants/${s.id}`);
  await rej(pouts.startWithdraw(t(), "0799999999", "tenant"), "LMMX_E_VALIDATION"); assert.ok(!tenantSms().some((m) => /LMW\d{4}/.test(m)));
  const st = await pouts.startWithdraw(t(), "0712345678", "tenant");
  assert.strictEqual(st.availableMinor, 200_000); assert.strictEqual(st.feeMinor, C.withdrawBreakdown(200_000).feeMinor); assert.strictEqual(st.netMinor, 200_000 - st.feeMinor);
  const m = tenantSms().pop(); assert.match(m, /LMW\d{4} valid 30 min/); assert.match(m, /wa\.me\/254101716473\?text=LMW\d{4}/); assert.ok(m.length <= 280);
  assert.strictEqual(firstCycle().creditedMinor, 200_000, "no money moved yet"); assert.strictEqual(db.list("lmmx_settlements").length, 0);
  await rej(pouts.confirmWithdraw(t(), "0000" === wdCode() ? "1111" : "0000", "tenant"), "LMMX_E_OTP_INVALID"); assert.strictEqual(firstCycle().creditedMinor, 200_000);
});
ok("withdraw confirm: takes everything available in one step, queues ONE sealed transfer to the tenant's own wallet after a quiet hour, tells the company phone", async () => {
  const s = await funded(); const t = () => db.store.get(`lmm_tenants/${s.id}`); await pouts.startWithdraw(t(), "0712345678", "tenant"); const code = wdCode(); sms.length = 0;
  const w = await pouts.confirmWithdraw(t(), code, "tenant");
  assert.strictEqual(w.requestedMinor, 200_000); assert.strictEqual(w.netMinor, 200_000 - w.feeMinor);
  const cy = firstCycle(); assert.strictEqual(cy.creditedMinor, 0); assert.strictEqual(cy.withdrawnMinor, 200_000); assert.strictEqual(cy.balSeal, L("cycles").cycleSeal(cy)); assert.strictEqual(cy.status, "open");
  const st = db.list("lmmx_settlements").map((p) => db.store.get(p))[0]; assert.strictEqual(st.reason, "withdraw"); assert.strictEqual(st.amountMinor, w.netMinor); assert.ok(st.notBefore > Date.now() + 59 * 60_000);
  assert.ok(sms.some((x) => x.mobile === OPS && /WITHDRAWAL REQUEST/.test(x.msg) && x.msg.includes(s.id)), "company phone told"); assert.ok(tenantSms().some((m) => /within 24 hours/.test(m)));
  const ws = db.store.get(`lmmx_recipients/${st.recipientId}`); assert.strictEqual(ws.kind, "wallet"); assert.strictEqual(ws.accountNumber, "0712345678");
  await settle.sendSettlement(st.id); assert.strictEqual(transfers.length, 0, "still inside the quiet hour");
  db.store.get(`lmmx_settlements/${st.id}`).notBefore = 1; await settle.sendSettlement(st.id);
  assert.strictEqual(transfers.length, 1); assert.strictEqual(transfers[0].amount, w.netMinor); assert.strictEqual(transfers[0].recipient, st.recipientCode);
  await settle.sendSettlement(st.id); assert.strictEqual(transfers.length, 1, "the same transfer is never sent twice (a duplicate is refused or ignored)");
  await settle.onTransferEvent("transfer.success", { reference: transfers[0].reference, amount: w.netMinor, recipient: { recipient_code: st.recipientCode } });
  assert.strictEqual(db.read(`lmmx_settlements/${st.id}`).status, "paid"); assert.ok(tenantSms().some((m) => /was sent to your M-PESA/.test(m))); assert.ok(sms.some((x) => x.mobile === OPS && /SENT/.test(x.msg)));
});
ok("withdraw: the code is single use, a second request while one is on its way is refused, nothing is overdrawn", async () => {
  const s = await funded(); const t = () => db.store.get(`lmm_tenants/${s.id}`); await pouts.startWithdraw(t(), "0712345678", "tenant"); const code = wdCode();
  const both = await Promise.allSettled([pouts.confirmWithdraw(t(), code, "tenant"), pouts.confirmWithdraw(t(), code, "tenant")]);
  assert.strictEqual(both.filter((r) => r.status === "fulfilled").length, 1, "only one of two simultaneous confirmations goes through"); assert.strictEqual(db.list("lmmx_settlements").length, 1);
  assert.ok(firstCycle().creditedMinor >= 0 && firstCycle().creditedMinor - firstCycle().settledMinor - firstCycle().inflightMinor >= 0);
  await rej(pouts.startWithdraw(t(), "0712345678", "tenant"), "LMMX_E_STATE");   // already on its way (and nothing left anyway)
});
ok("below KES 50 (or nothing) there is nothing to withdraw or pay out", async () => {
  const s = await funded(3_000); const t = () => db.store.get(`lmm_tenants/${s.id}`);
  await rej(pouts.startWithdraw(t(), "0712345678", "tenant"), "LMMX_E_AMOUNT"); await rej(pouts.requestLandlordPayout(t(), "tenant"), "LMMX_E_AMOUNT");
});
ok("frozen tenants and paused payouts cannot start either, and a withdrawal frozen during its quiet hour waits", async () => {
  const s = await funded(); const t = () => db.store.get(`lmm_tenants/${s.id}`);
  db.seed("lmm_config/standalone", { enabled: true, payoutsPaused: true }); store.clearFlagCache(); await rej(pouts.startWithdraw(t(), "0712345678", "tenant"), "LMMX_E_DISABLED"); await rej(pouts.requestLandlordPayout(t(), "tenant"), "LMMX_E_DISABLED");
  db.seed("lmm_config/standalone", { enabled: true }); store.clearFlagCache();
  await pouts.startWithdraw(t(), "0712345678", "tenant"); await pouts.confirmWithdraw(t(), wdCode(), "tenant"); const id = db.list("lmmx_settlements")[0].split("/")[1];
  db.store.get(`lmmx_settlements/${id}`).notBefore = 1; t().frozen = true; await settle.sendSettlement(id); assert.strictEqual(transfers.length, 0, "support froze the account");
  t().frozen = false; await settle.sendSettlement(id); assert.strictEqual(transfers.length, 1);
  t().frozen = true; await rej(pouts.startWithdraw(t(), "0712345678", "tenant"), "LMMX_E_FROZEN");
});
ok("tamper-proof: editing the balance in the database freezes the tenant and pays nothing; editing a queued withdrawal blocks it", async () => {
  let s = await funded(); const t = () => db.store.get(`lmm_tenants/${s.id}`);
  firstCycle().creditedMinor = 900_000;   // someone edits Firestore
  await rej(pouts.startWithdraw(t(), "0712345678", "tenant"), "LMMX_E_TAMPER"); assert.strictEqual(t().frozen, true); assert.strictEqual(transfers.length, 0);
  s = await funded(); firstCycle().withdrawnMinor = 5;   // any money field, even one that looks harmless
  await rej(pouts.requestLandlordPayout(t(), "tenant"), "LMMX_E_TAMPER");
  s = await funded(); db.store.get(db.list("lmmx_cycles")[0]).creditedMinor = 1_000_000; backdate(s.id);
  assert.strictEqual(await settle.settleCycle(db.list("lmmx_cycles")[0].split("/")[1]), "held:tamper"); assert.strictEqual(transfers.length, 0);
  s = await funded(); const cy = firstCycle(); cy.balSeal = "0".repeat(64); const p2 = await payAndCredit(s.id, 10_000).catch((e) => e); assert.ok(p2.res === "rejected" || p2 instanceof Error, "a tampered cycle refuses a new credit");
  s = await funded(); await pouts.startWithdraw(t(), "0712345678", "tenant"); await pouts.confirmWithdraw(t(), wdCode(), "tenant"); const sid = db.list("lmmx_settlements")[0].split("/")[1];
  db.store.get(`lmmx_settlements/${sid}`).amountMinor += 100; db.store.get(`lmmx_settlements/${sid}`).notBefore = 1; await settle.sendSettlement(sid);
  assert.strictEqual(transfers.length, 0); assert.strictEqual(db.read(`lmmx_settlements/${sid}`).status, "blocked");
});
ok("withdraw: if the transfer fails 3 times the credit goes back to the tenant, sealed", async () => {
  const s = await funded(); const t = () => db.store.get(`lmm_tenants/${s.id}`); await pouts.startWithdraw(t(), "0712345678", "tenant"); await pouts.confirmWithdraw(t(), wdCode(), "tenant");
  const sid = db.list("lmmx_settlements")[0].split("/")[1]; db.store.get(`lmmx_settlements/${sid}`).notBefore = 1;
  for (let i = 0; i < 3; i++) { await settle.sendSettlement(sid); const st = db.store.get(`lmmx_settlements/${sid}`); if (st.status !== "locked") break; await settle.onTransferEvent("transfer.failed", { reference: st.reference, amount: st.amountMinor, recipient: { recipient_code: st.recipientCode } }); }
  const st = db.read(`lmmx_settlements/${sid}`); assert.strictEqual(st.status, "failed"); const cy = firstCycle(); assert.strictEqual(cy.creditedMinor, 200_000); assert.strictEqual(cy.withdrawnMinor, 0); assert.strictEqual(cy.balSeal, L("cycles").cycleSeal(cy));
});
ok("withdrawals count against the same daily outflow cap as landlord payouts", async () => {
  const s = await funded(); const t = () => db.store.get(`lmm_tenants/${s.id}`); await pouts.startWithdraw(t(), "0712345678", "tenant"); const code = wdCode();
  const day = L("settle").dayKey(); db.seed(`lmm_counters/out_${day}`, { outMinor: 1_999_999_00 });
  await rej(pouts.confirmWithdraw(t(), code, "tenant"), "LMMX_E_DISABLED"); assert.strictEqual(firstCycle().creditedMinor, 200_000, "nothing was taken");
  db.seed(`lmm_counters/out_${day}`, { outMinor: 0 }); await pouts.startWithdraw(t(), "0712345678", "tenant"); await pouts.confirmWithdraw(t(), wdCode(), "tenant");
  assert.ok(db.read(`lmm_counters/out_${day}`).outMinor > 0, "counted");
});
ok("a tenant's own wallet is never offered to a desk as a landlord account", async () => {
  const s = await funded(); const t = () => db.store.get(`lmm_tenants/${s.id}`); await pouts.startWithdraw(t(), "0712345678", "tenant"); await pouts.confirmWithdraw(t(), wdCode(), "tenant");
  const c = await L("recipients").checkRecipient(DESK2, { channel: "phone", accountNumber: "0712345678", enteredName: "Mary Wanjiru" }); assert.strictEqual(c.exists, false);
});
ok("pay my landlord now: asks for everything available, every normal safety check still applies, then pays EXACTLY what was credited", async () => {
  const s = await funded(200_000); const t = () => db.store.get(`lmm_tenants/${s.id}`); sms.length = 0;
  const r = await pouts.requestLandlordPayout(t(), "tenant"); assert.strictEqual(r.requestedMinor, 200_000); assert.match(r.message, /safety check/);
  assert.ok(sms.some((x) => x.mobile === OPS && /payout request/.test(x.msg))); assert.strictEqual(transfers.length, 0); assert.strictEqual(firstCycle().payoutRequested, true);
  backdate(s.id); await sweepM.settlementWorker();
  assert.strictEqual(transfers.length, 1); assert.strictEqual(transfers[0].amount, 200_000, "uncut"); assert.strictEqual(transfers[0].recipient, db.store.get(`lmmx_recipients/${t().activeRecipientId}`).recipientCode);
  await settle.onTransferEvent("transfer.success", { reference: transfers[0].reference, amount: 200_000 }); assert.strictEqual(db.list("lmmx_settlements").map((p) => db.store.get(p))[0].status, "paid");
});
ok("tenant summary and bot lookup show what is available and the withdrawal fee", async () => {
  const s = await funded(); const t = db.store.get(`lmm_tenants/${s.id}`);
  const b = await pouts.summaryBalance(t); assert.strictEqual(b.availableMinor, 200_000); assert.strictEqual(b.withdrawFeeMinor, C.withdrawBreakdown(200_000).feeMinor); assert.strictEqual(b.payoutPending, false);
  const lk = await idx.lmmx_bot_lookup.run({ data: signed("lmmx_bot_lookup", { phone: "+254712345678", idNumber: "12345678" }) }); assert.strictEqual(lk.standalone.availableMinor, 200_000);
});
ok("bot: a withdrawal code only works from the tenant's own WhatsApp number; the bot cannot change account settings", async () => {
  const s = await funded(); const t = () => db.store.get(`lmm_tenants/${s.id}`);
  await idx.lmmx_bot_withdrawStart.run({ data: signed("lmmx_bot_withdrawStart", { phone: "+254712345678", idNumber: "12345678" }) }); const code = wdCode();
  await rej(idx.lmmx_bot_withdrawStart.run({ data: signed("lmmx_bot_withdrawStart", { phone: "+254799999999", idNumber: "12345678" }) }), "LMMX_E_NOT_FOUND");
  const bot = (phone, text) => idx.lmmx_bot_confirmCode.run({ data: signed("lmmx_bot_confirmCode", { phone, text }) });
  assert.strictEqual((await bot("+254799999999", `LMW${code}`)).result, "not_found"); assert.strictEqual(db.list("lmmx_settlements").length, 0);
  const ok1 = await bot("+254712345678", `lmw ${code}`); assert.strictEqual(ok1.result, "withdraw_requested"); assert.strictEqual(db.list("lmmx_settlements").length, 1); assert.strictEqual((await bot("+254712345678", `LMW${code}`)).result, "invalid");
  const exportsList = Object.keys(idx).filter((k) => k.startsWith("lmmx_bot_")); for (const k of exportsList) assert.ok(!/setDueDay|setPlan|updateTenant|requestChange|profile|name|idNumber/i.test(k), "bot has no account-settings ops: " + k);
  void t;
});

// ------------------------------------------------------------------------------------------------------------- withdrawal-only rules: 15% fee, 2 weeks, instalment cap, 72 hours
ok("withdrawal fees: 15% service fee (whole shilling, rounded up) plus the normal M-PESA fee, shown separately and deducted from what is sent", async () => {
  assert.deepStrictEqual(C.withdrawBreakdown(200_000), { serviceFeeMinor: 30_000, transferFeeMinor: 5_300, feeMinor: 35_300, netMinor: 164_700 });
  assert.strictEqual(C.withdrawBreakdown(5_050 + 50).serviceFeeMinor, 800, "15% of KES 51 is KES 7.65: rounded up to KES 8");
  const s = await funded(); const t = () => db.store.get(`lmm_tenants/${s.id}`);
  const st = await pouts.startWithdraw(t(), "0712345678", "tenant"); assert.deepStrictEqual([st.serviceFeeMinor, st.transferFeeMinor, st.feeMinor, st.netMinor], [30_000, 5_300, 35_300, 164_700]);
  assert.match(tenantSms().pop(), /15% service fee/);
  const w = await pouts.confirmWithdraw(t(), wdCode(), "tenant"); assert.deepStrictEqual([w.serviceFeeMinor, w.netMinor], [30_000, 164_700]); assert.match(w.message, /service fee/);
  const stl = db.list("lmmx_settlements").map((p) => db.store.get(p))[0]; assert.strictEqual(stl.amountMinor, 164_700); assert.strictEqual(stl.grossMinor, 200_000);
  assert.ok(db.list("lmmx_ledger").map((p) => db.store.get(p)).some((r) => r.type === "withdraw_service" && r.amountMinor === 30_000), "the service fee is booked");
  assert.strictEqual((await pouts.summaryBalance(t())).withdrawFeeMinor, 0, "nothing left, so no fee quoted");
});
ok("2-week rule: a plan under 14 days old cannot withdraw (it can still pay the landlord now); after 14 days it can", async () => {
  world(); const s = await activate(); const t = () => db.store.get(`lmm_tenants/${s.id}`); await payAndCredit(s.id, 200_000); await new Promise((r) => setTimeout(r, 30));
  await rej(pouts.startWithdraw(t(), "0712345678", "tenant"), "LMMX_E_STATE"); try { await pouts.startWithdraw(t(), "0712345678", "tenant"); } catch (e) { assert.match(e.message, /2 weeks/); assert.match(e.message, /Pay my landlord now/); }
  assert.ok((await pouts.summaryBalance(t())).withdrawEligibleAt > Date.now() + 13 * DAY, "the date it opens is shown");
  assert.strictEqual((await pouts.requestLandlordPayout(t(), "tenant")).requestedMinor, 200_000, "paying the landlord has no such wait");
  age(s.id, 13); await rej(pouts.startWithdraw(t(), "0712345678", "tenant"), "LMMX_E_STATE"); age(s.id, 15); assert.ok((await pouts.startWithdraw(t(), "0712345678", "tenant")).netMinor > 0);
});
ok("2-week rule cannot be dodged by editing dates in the database: the activation date is signed and cross-checked", async () => {
  let s = await funded(); const t = () => db.store.get(`lmm_tenants/${s.id}`);
  t().consentAt = Date.now() - 40 * DAY; await rej(pouts.startWithdraw(t(), "0712345678", "tenant"), "LMMX_E_TAMPER"); assert.strictEqual(t().frozen, true);
  s = await funded(); db.store.get(`lmm_pay_records/${s.id}`).setupCompletedAt = Date.now() - 40 * DAY; await rej(pouts.startWithdraw(t(), "0712345678", "tenant"), "LMMX_E_TAMPER");
  s = await funded(); t().consentAt = Date.now() - 40 * DAY; db.store.get(`lmm_pay_records/${s.id}`).setupCompletedAt = t().consentAt; await rej(pouts.confirmWithdraw(t(), "0000", "tenant"), "LMMX_E_OTP_INVALID");   // a fresh plan edited consistently still fails the signature
  await rej(pouts.startWithdraw(t(), "0712345678", "tenant"), "LMMX_E_TAMPER");
});
ok("instalment cap: KES 300 a day, x7 weekly, x14 biweekly, for every payment behind the balance; the stricter of the plan then and now; payments are signed", async () => {
  assert.deepStrictEqual(["daily", "weekly", "biweekly"].map((f) => C.withdrawInstalmentCapMinor(f)), [30_000, 210_000, 420_000]);
  let s = await funded(220_000); const t = () => db.store.get(`lmm_tenants/${s.id}`);   // weekly plan: KES 2,200 is over KES 2,100
  try { await pouts.startWithdraw(t(), "0712345678", "tenant"); assert.fail("should refuse"); } catch (e) { assert.strictEqual((e.details && e.details.lmmx) || e.lmmx, "LMMX_E_STATE"); assert.match(e.message, /KES 2,200/); assert.match(e.message, /KES 2,100/); assert.match(e.message, /Pay my landlord now/); }
  assert.strictEqual((await pouts.requestLandlordPayout(t(), "tenant")).requestedMinor, 220_000, "the landlord can always be paid");
  s = await funded(210_000); assert.ok((await pouts.startWithdraw(t(), "0712345678", "tenant")).netMinor > 0, "exactly the weekly cap is allowed");
  s = await funded(25_000); t().frequency = "daily"; assert.ok((await pouts.startWithdraw(t(), "0712345678", "tenant")).netMinor > 0, "KES 250 is under the daily cap");
  s = await funded(100_000); t().frequency = "daily"; await rej(pouts.startWithdraw(t(), "0712345678", "tenant"), "LMMX_E_STATE");   // paid on a weekly plan, now daily: the stricter cap applies
  s = await funded(25_000); t().frequency = "biweekly"; assert.ok((await pouts.startWithdraw(t(), "0712345678", "tenant")).netMinor > 0);
  s = await funded(220_000); const pay = db.list("lmmx_payments").map((p) => db.store.get(p)).find((p) => p.status === "credited"); assert.ok(pay.paySeal && pay.freq === "weekly", "each credited payment is signed with its plan");
  pay.creditMinor = 100_000; await rej(pouts.startWithdraw(t(), "0712345678", "tenant"), "LMMX_E_TAMPER"); assert.strictEqual(t().frozen, true);   // someone lowered the amount in the database
});
ok("the cap is checked again inside the reservation: a big payment made AFTER the code was sent still blocks the withdrawal and nothing moves", async () => {
  const s = await funded(100_000); const t = () => db.store.get(`lmm_tenants/${s.id}`); await pouts.startWithdraw(t(), "0712345678", "tenant"); const code = wdCode();
  await payAndCredit(s.id, 220_000); await new Promise((r) => setTimeout(r, 30));   // over the weekly cap of KES 2,100
  await rej(pouts.confirmWithdraw(t(), code, "tenant"), "LMMX_E_STATE");
  assert.strictEqual(db.list("lmmx_settlements").length, 0); assert.strictEqual(firstCycle().creditedMinor, 320_000); assert.ok(!firstCycle().withdrawnMinor);
});
ok("72 hours after a withdrawal the same phone or ID cannot set up a new plan (any desk, top desk too) or change the plan; after 72 hours it can", async () => {
  const s = await funded(); const t = () => db.store.get(`lmm_tenants/${s.id}`); seedTopForCool(); await pouts.startWithdraw(t(), "0712345678", "tenant"); await pouts.confirmWithdraw(t(), wdCode(), "tenant");
  await rej(chg.setPlan(t(), "daily", undefined), "LMMX_E_STATE");
  await tenants.closeTenant(t(), "test");   // the old plan is gone; a new plan for the same person is what is blocked
  await rej(tenants.createTenant(DESK, input()), "LMMX_E_STATE"); await rej(tenants.createTenant(TOP, input()), "LMMX_E_STATE");
  await rej(tenants.createTenant(DESK, input({ profile: { ...input().profile, phone: "0744555666" } })), "LMMX_E_STATE");      // same ID, new phone
  await rej(tenants.createTenant(DESK, input({ profile: { ...input().profile, idNumber: "87654321" } })), "LMMX_E_STATE");     // same phone, new ID
  for (const k of db.list("lmmx_locks").filter((p) => p.includes("wdcool_"))) db.store.get(k).at = Date.now() - 73 * 3_600_000;
  assert.strictEqual((await tenants.createTenant(DESK, input())).status, "awaiting_confirmation");
});
const seedTopForCool = () => db.seed("desk_agents/T1", { agentId: "T1", agentCode: "COG-0000", status: "active", rank: "internal", phone: "+254700000000" });
// ------------------------------------------------------------------------------------------------------------- audit
ok("the audit chain verifies, and a tampered row is detected", async () => {
  world(); await activate(); await new Promise((r) => setTimeout(r, 20));
  const good = await store.verifyAudit(); assert.ok(good.ok && good.checked >= 3, JSON.stringify(good));
  const first = db.list("lmmx_audit").sort()[1]; db.store.get(first).summary = "edited";
  const bad = await store.verifyAudit(); assert.strictEqual(bad.ok, false);
});
ok("no raw ID number or phone is stored in plain text on the tenant", async () => {
  world(); const s = await activate(); const raw = JSON.stringify(db.store.get(`lmm_tenants/${s.id}`));
  assert.ok(!raw.includes("12345678") && !raw.includes("0712345678") && !raw.includes("Wanjiru"));
});

(async () => {
  for (const [name, fn] of queue) { try { await fn(); passed++; console.log("  ✓", name); } catch (e) { failed++; console.log("  ✗", name, "\n   ", (e && e.stack ? e.stack.split("\n").slice(0, 3).join("\n    ") : e)); } }
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})();
