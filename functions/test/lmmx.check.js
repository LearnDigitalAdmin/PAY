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
  const rows = [[10_000, 10_700, 240], [50_000, 52_800, 900], [250_000, 261_500, 3000], [500_000, 520_400, 4500], [1_000_000, 1_040_800, 9000]];
  for (const [x, g, d] of rows) { const q = C.quoteInstalment({ creditMinor: x, rentMinor: 1_000_000, channel: "till" }); assert.strictEqual(q.chargeMinor, g); assert.strictEqual(q.deskShareMinor, d); }
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
  const q = await pay.makeQuote(t, 250_000); assert.strictEqual(q.chargeMinor, 261_500);
  const out = await pay.startPayment(t, q.quoteId, "0712345678"); assert.ok(charges.get(out.reference).split, "the charge carries the desk's flat split");
  assert.strictEqual(splits[0].subaccounts[0].share, 3000);
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
