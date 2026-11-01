/* Lipa Mos Mos end to end against an in-memory Firestore and a mocked Paystack/SMS (no network, no emulator).
 * Run:  cd functions && npm run build && node test/lmm-flow.check.js   (exit 1 on failure) */
process.env.PAYSTACK_SECRET_KEY = "sk_test_x"; process.env.LMM_SEAL_KEY = "seal-key-for-tests";
process.env.HP_SMS_USERID = "u"; process.env.HP_SMS_APIKEY = "k"; process.env.HP_SMS_PASSWORD = "p"; process.env.HP_SMS_SENDERID = "s";
const assert = require("assert");
const path = require("path");
const axios = require("axios");
const { FakeDb, install } = require("./lmm-fake-firestore");
const db = new FakeDb(); install(db);
const lib = (p) => require(path.join(__dirname, "..", "lib", "lmm", p));
const settle = lib("settle"), plan = lib("plan"), rec = lib("recipient"), index = lib("index"), cfg = lib("config");

const SECRETS = { paystack: "sk_test_x", seal: "seal-key-for-tests" };
const KES = (n) => n * 100;
let passed = 0, failed = 0;
const sms = [], transfers = [], otpAttempts = [], charges = new Map(), recipients = new Map();
let transferMode = "pending";        // "pending" | "otp" | "nobalance"
const resetPaystack = () => { sms.length = 0; transfers.length = 0; otpAttempts.length = 0; charges.clear(); recipients.clear(); transferMode = "pending"; };

axios.post = async (url, body) => {
  if (url.includes("hostpinnacle")) { const p = new URLSearchParams(body); sms.push({ mobile: p.get("mobile"), msg: p.get("msg") }); return { data: { status: "success" } }; }
  if (url.endsWith("/transferrecipient")) { const code = "RCP_test" + (recipients.size + 1); recipients.set(code, { type: body.type, bank_code: body.bank_code, account_number: body.account_number }); return { data: { status: true, data: { recipient_code: code } } }; }
  if (url.endsWith("/charge")) { assert.ok(!("split_code" in body) && !("subaccount" in body) && !("split" in body), "LMM charges must never carry a split"); charges.set(body.reference, { amount: body.amount, status: "pending" }); return { data: { status: true, data: { status: "pay_offline", display_text: "Enter PIN" } } }; }
  if (url.endsWith("/transfer")) {
    if (transferMode === "nobalance") throw Object.assign(new Error("x"), { response: { data: { message: "Your balance is not enough to fulfil this request" } } });
    if (transferMode === "otp") { otpAttempts.push(body); return { data: { status: true, data: { status: "otp", transfer_code: "TRF_otp" } } }; }
    transfers.push(body); return { data: { status: true, data: { status: "pending", transfer_code: "TRF_" + transfers.length } } };
  }
  throw new Error("unexpected POST " + url);
};
axios.get = async (url) => {
  let m = url.match(/\/transaction\/verify\/(.+)$/);
  if (m) { const c = charges.get(decodeURIComponent(m[1])); if (!c) throw new Error("404"); return { data: { status: true, data: { status: c.status, reference: decodeURIComponent(m[1]), amount: c.amount, currency: "KES", fees: Math.round(c.amount * 0.015) } } }; }
  m = url.match(/\/transferrecipient\/(.+)$/);
  if (m) { const r = recipients.get(decodeURIComponent(m[1])); if (!r) throw new Error("404"); return { data: { status: true, data: { recipient_code: decodeURIComponent(m[1]), type: r.type, active: true, details: { account_number: r.account_number, bank_code: r.bank_code } } } }; }
  m = url.match(/\/transfer\/verify\/(.+)$/);
  if (m) { const t = transfers.find((x) => x.reference === decodeURIComponent(m[1])); return { data: { status: true, data: { status: t ? "success" : "failed", amount: t ? t.amount : 0 } } }; }
  throw new Error("unexpected GET " + url);
};

const world = async ({ rent = 10000, invoiceTotal = 10000 } = {}) => {
  db.store.clear(); resetPaystack();
  db.seed("users/A1", { paymentInfo: { accountId: "ACCT_1", settlementType: "bank", settlementBankCode: "068", accountNumber: "1234567890", businessName: "Landlord Ltd" } });
  db.seed("users/A1/tenants/1", { name: "John Doe", phone: "0712345678", rentAmount: rent, isActive: true });
  if (invoiceTotal) db.seed("users/A1/invoices/I1", { tenantId: 1, billingMonth: "2026-11", dueDate: "2026-11-05", totalAmount: invoiceTotal, amountPaid: 0, arrears: invoiceTotal, isPaid: false });
  const r = await rec.createSealedRecipient(SECRETS, { landlordId: "A1", settlementType: "bank", bankCode: "068", accountNumber: "1234567890", name: "Landlord Ltd" });
  assert.ok(r.ok);
  const out = await plan.lmm_start.run({ data: { agentId: "A1", tenantId: "1", frequency: "weekly" } });
  assert.ok(out.available);
};
/** Tenant pays `kes` and Paystack confirms it. Returns the credit result. */
const payAndConfirm = async (kes, { paidMinorDelta = 0 } = {}) => {
  const out = await plan.lmm_pay.run({ data: { agentId: "A1", tenantId: "1", amount: kes, phone: "0712345678" } });
  const c = charges.get(out.reference); c.status = "success"; c.amount += paidMinorDelta;
  db.store.get(`lmm_payments/${out.reference}`).status = "pending"; db.store.get(`lmm_payments/${out.reference}`).createdAt = 1;   // let the next prompt through
  return { reference: out.reference, result: await settle.creditPayment(SECRETS, out.reference, c.amount), out };
};
const alerts = () => sms.filter((s) => s.mobile === cfg.LMM.ALERT_MOBILE);
const tenantSms = () => sms.filter((s) => s.mobile === "254712345678").map((s) => s.msg);
const ok = async (name, fn) => { try { await fn(); passed++; console.log("  ✓", name); } catch (e) { failed++; console.error("  ✗", name, "\n", e); } };

(async () => {
  await ok("plan starts, tenant is charged 2.5% extra, the charge has NO split, and the rent is credited exactly", async () => {
    await world();
    assert.deepStrictEqual(tenantSms().length, 1); assert.match(tenantSms()[0], /^Dear John, your Lipa Mos Mos plan for KES 10,000 rent is on\./);
    const { out, result } = await payAndConfirm(3000);
    assert.deepStrictEqual([out.creditMinor, out.chargeMinor, out.surchargeMinor], [KES(3000), KES(3075), KES(75)]);
    assert.strictEqual(result, "credited");
    const p = db.read("lmm_plans/A1_1"); assert.strictEqual(p.creditedMinor, KES(3000));
    assert.ok(tenantSms().some((m) => /^Dear John, well done! You have paid 25% of your rent \(KES 3,000\)\./.test(m)), tenantSms().join(" | "));
    assert.strictEqual(transfers.length, 0, "nothing is sent before the target or the 5th");
  });

  await ok("a webhook sent twice credits once", async () => {
    await world();
    const { reference } = await payAndConfirm(2000);
    assert.strictEqual(await settle.creditPayment(SECRETS, reference, charges.get(reference).amount), "ignored");
    assert.strictEqual(db.read("lmm_plans/A1_1").creditedMinor, KES(2000));
  });

  await ok("reaching the invoice settles the landlord: one transfer of the full amount minus the KES 95 fee, to the SEALED recipient", async () => {
    await world();
    await payAndConfirm(4000); await payAndConfirm(3000); await payAndConfirm(3000);
    assert.strictEqual(transfers.length, 1);
    const t = transfers[0]; assert.deepStrictEqual([t.source, t.amount, t.recipient, t.currency], ["balance", KES(10000 - 95), "RCP_test1", "KES"]); assert.match(t.reference, /^lmm-[0-9a-f]{16}-0-0$/);
    const st = db.read("lmm_settlements/A1_1_1"); assert.strictEqual(st.status, "locked"); assert.strictEqual(db.read("lmm_plans/A1_1").inFlightMinor, KES(10000));
    // Paystack confirms
    await settle.onTransferEvent(SECRETS, "transfer.success", { reference: t.reference, amount: t.amount, recipient: { recipient_code: "RCP_test1" } });
    const inv = db.read("users/A1/invoices/I1"); assert.deepStrictEqual([inv.isPaid, inv.status, inv.amountPaid, inv.arrears], [true, "paid", 10000, 0]);
    assert.strictEqual(db.read("lmm_settlements/A1_1_1").status, "paid"); const p = db.read("lmm_plans/A1_1"); assert.deepStrictEqual([p.inFlightMinor, p.settledTotalMinor, p.creditedMinor], [0, KES(10000), 0]);
    assert.ok(tenantSms().some((m) => /^Dear John, your landlord has been paid KES 10,000 for rent\./.test(m)), tenantSms().join(" | "));
    // replayed webhook changes nothing
    const before = JSON.stringify([...db.store]); await settle.onTransferEvent(SECRETS, "transfer.success", { reference: t.reference, amount: t.amount, recipient: { recipient_code: "RCP_test1" } });
    assert.strictEqual(JSON.stringify([...db.store]), before);
  });

  await ok("on the 5th, a partly paid invoice is settled and marked PARTIAL; the rest stays on the plan", async () => {
    await world({ invoiceTotal: 20000 });
    await payAndConfirm(5000);
    assert.strictEqual(transfers.length, 0);
    assert.strictEqual(await settle.settlePlan(SECRETS, "A1_1", "fifth"), "started");
    assert.strictEqual(transfers[0].amount, KES(5000 - 95));
    await settle.onTransferEvent(SECRETS, "transfer.success", { reference: transfers[0].reference, amount: transfers[0].amount, recipient: { recipient_code: "RCP_test1" } });
    const inv = db.read("users/A1/invoices/I1"); assert.deepStrictEqual([inv.isPaid, inv.status, inv.amountPaid, inv.arrears], [false, "partial", 5000, 15000]);
    assert.ok(tenantSms().some((m) => /^Dear John, KES 5,000 was sent to your landlord today\. Balance KES 15,000 stays on your plan\./.test(m)), tenantSms().join(" | "));
  });

  await ok("a new invoice retargets the plan; with no invoice the target is a month's rent", async () => {
    await world({ rent: 8000, invoiceTotal: 0 });
    assert.strictEqual((await plan.lmm_getPlan.run({ data: { agentId: "A1", tenantId: "1" } })).plan.targetMinor, KES(8000));
    db.seed("users/A1/invoices/I9", { tenantId: 1, billingMonth: "2026-11", dueDate: "2026-11-05", totalAmount: 9500, amountPaid: 0, isPaid: false });
    assert.strictEqual((await plan.lmm_getPlan.run({ data: { agentId: "A1", tenantId: "1" } })).plan.targetMinor, KES(9500));
  });

  await ok("settlement with no open invoice still pays the landlord and keeps the credit to apply to the next invoice", async () => {
    await world({ rent: 8000, invoiceTotal: 0 });
    await payAndConfirm(8000);                      // target (rent) reached
    assert.strictEqual(transfers.length, 1);
    await settle.onTransferEvent(SECRETS, "transfer.success", { reference: transfers[0].reference, amount: transfers[0].amount, recipient: { recipient_code: "RCP_test1" } });
    assert.strictEqual(db.read("lmm_plans/A1_1").unappliedMinor, KES(8000));
    db.seed("users/A1/invoices/I2", { tenantId: 1, billingMonth: "2026-12", dueDate: "2026-12-05", totalAmount: 8000, amountPaid: 0, isPaid: false });
    assert.strictEqual((await plan.lmm_getPlan.run({ data: { agentId: "A1", tenantId: "1" } })).plan.targetMinor, 0, "already paid ahead");
  });

  await ok("TAMPER: editing the recipient record blocks the transfer and texts 0791286165", async () => {
    await world(); await payAndConfirm(5000);
    db.store.get("lmm_recipients/A1").recipientCode = "RCP_attacker";
    assert.strictEqual(await settle.settlePlan(SECRETS, "A1_1", "fifth"), "held");
    assert.strictEqual(transfers.length, 0); assert.ok(alerts().some((a) => /SEAL_MISMATCH/.test(a.msg)), JSON.stringify(alerts()));
  });
  await ok("TAMPER: swapping the account on Paystack's side (recipient no longer matches the seal) blocks the transfer", async () => {
    await world(); await payAndConfirm(5000);
    recipients.get("RCP_test1").account_number = "9999999999";
    assert.strictEqual(await settle.settlePlan(SECRETS, "A1_1", "fifth"), "held");
    assert.strictEqual(transfers.length, 0); assert.ok(alerts().some((a) => /RECIPIENT_MISMATCH/.test(a.msg)));
  });
  await ok("TAMPER: inflating a payment's credited amount in Firestore cannot raise the transfer", async () => {
    await world(); const { reference } = await payAndConfirm(5000);
    const p = db.store.get(`lmm_payments/${reference}`); p.creditMinor = KES(9000); db.store.get("lmm_plans/A1_1").creditedMinor = KES(9000);
    assert.strictEqual(await settle.settlePlan(SECRETS, "A1_1", "fifth"), "held");
    assert.strictEqual(transfers.length, 0); assert.ok(alerts().some((a) => /PAYMENT_UNVERIFIED|AMOUNT_MISMATCH/.test(a.msg)));
  });
  await ok("TAMPER: raising the plan's credited total without matching payments is caught", async () => {
    await world(); await payAndConfirm(5000);
    db.store.get("lmm_plans/A1_1").creditedMinor = KES(9000);
    assert.strictEqual(await settle.settlePlan(SECRETS, "A1_1", "fifth"), "held");
    assert.strictEqual(transfers.length, 0); assert.ok(alerts().some((a) => /PLAN_MISMATCH/.test(a.msg)));
  });
  await ok("TAMPER: editing the settlement between locking and sending blocks the send", async () => {
    await world(); transferMode = "otp"; await payAndConfirm(10000);              // locks, then Paystack asks for an OTP: nothing sent
    assert.ok(alerts().some((a) => /OTP_REQUIRED/.test(a.msg))); assert.strictEqual(db.read("lmm_settlements/A1_1_1").status, "locked");
    db.store.get("lmm_settlements/A1_1_1").chunks[0].sendMinor = KES(99999);
    transferMode = "pending"; sms.length = 0;
    await settle.sendSettlement(SECRETS, "A1_1_1");
    assert.strictEqual(transfers.length, 0); assert.ok(alerts().some((a) => /SEAL_MISMATCH/.test(a.msg))); assert.strictEqual(db.read("lmm_settlements/A1_1_1").status, "blocked");
  });
  await ok("OTP still required: nothing is sent, an alert goes out, and once it is off the SAME settlement sends exactly once", async () => {
    await world(); transferMode = "otp"; await payAndConfirm(10000);
    assert.ok(alerts().some((a) => /OTP_REQUIRED/.test(a.msg)));
    transferMode = "pending"; await settle.sendSettlement(SECRETS, "A1_1_1"); await settle.sendSettlement(SECRETS, "A1_1_1");
    assert.strictEqual(transfers.length, 1, "exactly one real transfer"); assert.ok(otpAttempts.length >= 1 && transfers[0].reference === otpAttempts[0].reference, "same reference throughout");
    assert.strictEqual(db.read("lmm_settlements/A1_1_1").chunks[0].status, "sent");
  });
  await ok("an under- or over-paid charge is never credited, and an alert goes out", async () => {
    await world();
    const { result } = await payAndConfirm(3000, { paidMinorDelta: -100 });
    assert.strictEqual(result, "rejected"); assert.strictEqual(db.read("lmm_plans/A1_1").creditedMinor, 0); assert.ok(alerts().some((a) => /AMOUNT_MISMATCH/.test(a.msg)));
  });
  await ok("an unconfirmed charge (Paystack says not successful) is never credited", async () => {
    await world();
    const out = await plan.lmm_pay.run({ data: { agentId: "A1", tenantId: "1", amount: 3000, phone: "0712345678" } });
    assert.strictEqual(await settle.creditPayment(SECRETS, out.reference, charges.get(out.reference).amount), "rejected");
    assert.strictEqual(db.read("lmm_plans/A1_1").creditedMinor, 0);
  });
  await ok("the daily outflow cap stops a settlement and alerts", async () => {
    await world(); await payAndConfirm(5000);
    const day = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10).replace(/-/g, "");
    db.seed(`lmm_counters/out_${day}`, { outMinor: cfg.LMM.DAILY_OUTFLOW_CAP_MINOR });
    assert.strictEqual(await settle.settlePlan(SECRETS, "A1_1", "fifth"), "held");
    assert.strictEqual(transfers.length, 0); assert.ok(alerts().some((a) => /OVER_CAP/.test(a.msg)));
  });
  await ok("below the KES 300 minimum nothing is sent (the fee would eat it)", async () => {
    await world(); await payAndConfirm(200);
    assert.strictEqual(await settle.settlePlan(SECRETS, "A1_1", "fifth"), "below_minimum"); assert.strictEqual(transfers.length, 0);
  });
  await ok("a failed transfer is retried with a NEW reference (max 3 tries), with alerts", async () => {
    await world(); await payAndConfirm(10000);
    const t0 = transfers[0];
    await settle.onTransferEvent(SECRETS, "transfer.failed", { reference: t0.reference, amount: t0.amount, recipient: { recipient_code: "RCP_test1" } });
    assert.ok(alerts().some((a) => /TRANSFER_FAILED/.test(a.msg)));
    await settle.sendSettlement(SECRETS, "A1_1_1");
    assert.strictEqual(transfers.length, 2); assert.notStrictEqual(transfers[1].reference, t0.reference); assert.match(transfers[1].reference, /-0-1$/);
  });
  await ok("a transfer event with a different amount or recipient is not trusted", async () => {
    await world(); await payAndConfirm(10000);
    const t0 = transfers[0];
    await settle.onTransferEvent(SECRETS, "transfer.success", { reference: t0.reference, amount: t0.amount + 100, recipient: { recipient_code: "RCP_test1" } });
    await settle.onTransferEvent(SECRETS, "transfer.success", { reference: t0.reference, amount: t0.amount, recipient: { recipient_code: "RCP_attacker" } });
    assert.strictEqual(db.read("lmm_settlements/A1_1_1").status, "locked"); assert.ok(alerts().some((a) => /AMOUNT_MISMATCH/.test(a.msg)));
  });
  await ok("Airtel and Paybill landlords get no plan, and tenants are told", async () => {
    db.store.clear(); resetPaystack();
    db.seed("users/A2", { paymentInfo: { accountId: "X" } });
    await rec.createSealedRecipient(SECRETS, { landlordId: "A2", settlementType: "airtel-ke", bankCode: "ATL", accountNumber: "0733000000", name: "L" });
    const out = await plan.lmm_getPlan.run({ data: { agentId: "A2", tenantId: "1" } });
    assert.strictEqual(out.available, false); await assert.rejects(plan.lmm_start.run({ data: { agentId: "A2", tenantId: "1", frequency: "daily" } }), /not enabled/);
  });
  await ok("instalments are validated server-side (whole shillings, min, max, no overpaying, Safaricom only)", async () => {
    await world();
    const pay = (amount, phone = "0712345678") => plan.lmm_pay.run({ data: { agentId: "A1", tenantId: "1", amount, phone } });
    await assert.rejects(pay(5), /whole-shilling/); await assert.rejects(pay(1000.5), /whole-shilling/); await assert.rejects(pay(20000), /more than you owe/);
    await assert.rejects(pay(1000, "0733123456"), /Safaricom/i);
    const small = await pay(50); assert.deepStrictEqual([small.creditMinor, small.chargeMinor], [KES(50), KES(53)]);   // 5% for under KES 100: 52.5 -> 53
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
