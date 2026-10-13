// Track B acceptance tests — signature (valid/invalid/replayed), reference parsing, handler hardening, dispatcher,
// and mychamaPayInitiate end to end (Paystack mocked).
//
//   cd functions && npm run build && cd ..
//   node scripts/mychama/test-money-plane.mjs                 # in-memory Firestore (no emulator needed)
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/mychama/test-money-plane.mjs --emulator
//        (same scenarios against the real Firestore emulator; project id mychama1)
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { FakeDb } from "./_fake-firestore.mjs";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
process.env.MYCHAMA_PAYSTACK_SECRET_KEY = "sk_test_unit_secret";
process.env.MYCHAMA_ID_PEPPER = "unit-test-pepper";
const EMULATOR = process.argv.includes("--emulator");

// ─────────────────────────── database under test ───────────────────────────
let db, plot;
if (EMULATOR) {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("--emulator needs FIRESTORE_EMULATOR_HOST");
  const admin = require("firebase-admin");
  const mk = (name, projectId) => {
    const f = admin.initializeApp({ projectId }, name).firestore();
    f.settings({ ignoreUndefinedProperties: true });
    return Object.assign(f, {
      seed: (p, d) => f.doc(p).set(d),
      read: async (p) => (await f.doc(p).get()).data(),
      list: async (c) => (await f.collection(c).listDocuments()).map((r) => r.path),
      reset: () => fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: "DELETE" }),
    });
  };
  db = mk("t-mychama1", "mychama1");
  plot = mk("t-plot", "plot-test");
} else {
  db = new FakeDb(); db.reset = () => db.store.clear();
  plot = new FakeDb(); plot.reset = () => plot.store.clear();
}

// ─────────────────────────── wiring: patch the seams, then load the compiled code ───────────────────────────
const cfg = require("./lib/mychama/config");
cfg.mychamaDb = () => db;
cfg.plotDb = () => plot;
const sms = require("./lib/mychama/sms");
const smsCalls = [];
sms.sendMyChamaSms = async (...a) => { smsCalls.push(a); };
const axios = require("axios");
let chargeCalls = [];
const okCharge = async () => ({ data: { status: true, message: "Charge attempted", data: { status: "pay_offline", display_text: "Enter your M-Pesa PIN" } } });
let chargeImpl = okCharge;
axios.post = async (url, body, opts) => { chargeCalls.push({ url, body, opts }); return chargeImpl(url, body, opts); };

const util = require("./lib/mychama/webhook/util");
const handlers = require("./lib/mychama/webhook/handlers");
const dispatch = require("./lib/mychama/webhook/dispatch");
const fees = require("./lib/mychama/pay/fees");
const { mychamaPayInitiate } = require("./lib/mychama/pay");

// ─────────────────────────── tiny runner ───────────────────────────
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await db.reset(); await plot.reset(); smsCalls.length = 0; chargeCalls = []; chargeImpl = okCharge; await fn(); pass++; console.log("  ok   " + name); }
  catch (e) { fail++; console.error("  FAIL " + name + "\n       " + String(e.stack || e).split("\n").slice(0, 6).join("\n       ")); }
}
const code = async (p) => { try { await p; } catch (e) { return e?.details?.code ?? `raw:${e?.message}`; } return "no_error"; };

// ─────────────────────────── seed helpers ───────────────────────────
const CH = "sunrise01";
const PHONE = "+254712345678";
async function seedChama(id = CH, extra = {}) {
  await db.seed(`chamas/${id}`, { name: "Sunrise", plan: "starter", status: "active", settlementSplitCode: "SPL_new", settlementSplitKeyVersion: 2, settlementSubaccountCode: "ACCT_new", smsCredits: 0, ...extra });
  await db.seed(`chamas/${id}/members/m1`, { name: "Ann", status: "active", phone: "0712345678", phoneNormalized: PHONE, creditBalance: 0, totalContributed: 0 });
  await db.seed(`chamas/${id}/members/m2`, { name: "Bob", status: "active", phone: "0722000000", phoneNormalized: "+254722000000", creditBalance: 0, totalContributed: 0 });
  await db.seed(`chamas/${id}/contributions/c1`, { memberId: "m1", periodKey: "2026-10", amount: 1000, paidAmount: 0, status: "pending" });
  await db.seed(`chamas/${id}/contributions/c2`, { memberId: "m2", periodKey: "2026-10", amount: 1000, paidAmount: 0, status: "pending" });
}
const gross1000 = () => fees.contributionFees(1000).gross;
const kobo = (kes) => Math.round(kes * 100);
async function seedIntent(chamaId = CH, ref = `MCA-${CH}-CNT-1758100000000-A7K2QX`, extra = {}) {
  const f = fees.contributionFees(1000);
  await db.seed(`chamas/${chamaId}/paymentIntents/${ref}`, {
    chamaId, memberId: "m1", purpose: "contribution", reference: ref, amount: 1000, grossAmount: f.gross, paystackFee: f.paystackFee,
    ourFee: f.ourFee, currency: "KES", phone: PHONE, provider: "mpesa", status: "pending", channel: "app", contributionId: "c1",
    createdAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() + 1800000, ...extra,
  });
  return ref;
}
const sign = (body, secret = process.env.MYCHAMA_PAYSTACK_SECRET_KEY) => crypto.createHmac("sha512", secret).update(body).digest("hex");

// ═══════════════════════════ A. signature + reference parsing ═══════════════════════════
console.log("A. signature / references");
await t("signature: valid body verifies", async () => {
  const body = Buffer.from(JSON.stringify({ event: "charge.success", data: { reference: "MCA-x-CNT-1-ABC123" } }));
  assert.equal(util.verifyPaystackSignature(body, sign(body), process.env.MYCHAMA_PAYSTACK_SECRET_KEY), true);
});
await t("signature: tampered body, wrong key, missing, truncated and wrong-length signatures are rejected", async () => {
  const body = Buffer.from('{"event":"charge.success","data":{"amount":100}}');
  const good = sign(body), key = process.env.MYCHAMA_PAYSTACK_SECRET_KEY;
  assert.equal(util.verifyPaystackSignature(Buffer.from('{"event":"charge.success","data":{"amount":999}}'), good, key), false);
  assert.equal(util.verifyPaystackSignature(body, sign(body, "sk_live_OLD_ACCOUNT_KEY"), key), false);   // old-account key must not verify
  assert.equal(util.verifyPaystackSignature(body, undefined, key), false);
  assert.equal(util.verifyPaystackSignature(body, "", key), false);
  assert.equal(util.verifyPaystackSignature(body, good.slice(0, 60), key), false);
  assert.equal(util.verifyPaystackSignature(body, good + "00", key), false);
  assert.equal(util.verifyPaystackSignature(body, good.toUpperCase(), key), false);
});
await t("references: prefixes, hyphenated chama ids, non-MyChama", async () => {
  assert.deepEqual(util.parseMyChamaReference("MCA-sunrise01-CNT-1758100000000-A7K2QX"), { kind: "payment", chamaId: "sunrise01", collection: "paymentIntents" });
  assert.equal(util.parseMyChamaReference("MCW-sun-rise-01-LNR-1758100000000-A7K2QX").chamaId, "sun-rise-01");
  assert.deepEqual(util.parseMyChamaReference("MCS-ch1-1758100000000-ABC123"), { kind: "sms_topup", chamaId: "ch1", collection: "smsTopUps" });
  assert.equal(util.parseMyChamaReference("MCP-ch1-1-ABC").kind, "plan_billing");
  assert.equal(util.parseMyChamaReference("MCX-ch1-1-ABC").collection, "reportCreditTopUps");
  assert.equal(util.parseMyChamaReference("MCR-ch1-1-ABC").collection, "reportAlacartePurchases");
  for (const bad of ["CYBER_123", "INV_9", "SUB_1", "BOOK_1", "", undefined, null, 42, "MCZ-a-b-c-d", "constructor-x-y-z"]) {
    assert.equal(util.parseMyChamaReference(bad), null, String(bad));
  }
});

// ═══════════════════════════ B. handleMyChamaPayment hardening ═══════════════════════════
console.log("B. payment handler");
await t("amount mismatch: nothing applied, applyNote + audit log, no SMS, stays pending", async () => {
  await seedChama(); const ref = await seedIntent();
  await handlers.handleMyChamaPayment(ref, CH, kobo(gross1000()) - 1, "KES");
  const i = await db.read(`chamas/${CH}/paymentIntents/${ref}`);
  assert.equal(i.status, "pending"); assert.match(i.applyNote, /mismatch/); assert.ok(i.applyBlockedAt);
  assert.equal((await db.read(`chamas/${CH}/contributions/c1`)).paidAmount, 0);
  assert.equal((await db.read(`chamas/${CH}/members/m1`)).totalContributed, 0);
  assert.equal(await db.read(`chamas/${CH}/transactions/${ref}`), undefined);
  assert.equal((await db.list("whatsappAuditLog")).length, 1);
  assert.equal(smsCalls.length, 0);
});
await t("currency not KES: nothing applied even when the amount matches", async () => {
  await seedChama(); const ref = await seedIntent();
  await handlers.handleMyChamaPayment(ref, CH, kobo(gross1000()), "USD");
  const i = await db.read(`chamas/${CH}/paymentIntents/${ref}`);
  assert.equal(i.status, "pending"); assert.match(i.applyNote, /not KES/);
  assert.equal((await db.read(`chamas/${CH}/contributions/c1`)).paidAmount, 0);
});
await t("correct payment applies once; a REPLAYED event is a no-op (no double apply, one SMS)", async () => {
  await seedChama(); const ref = await seedIntent();
  await handlers.handleMyChamaPayment(ref, CH, kobo(gross1000()), "KES");
  await handlers.handleMyChamaPayment(ref, CH, kobo(gross1000()), "KES");   // replay
  await Promise.all([handlers.handleMyChamaPayment(ref, CH, kobo(gross1000()), "KES")]);
  const c = await db.read(`chamas/${CH}/contributions/c1`);
  assert.equal(c.paidAmount, 1000); assert.equal(c.status, "paid");
  assert.equal((await db.read(`chamas/${CH}/members/m1`)).totalContributed, 1000);
  assert.equal((await db.read(`chamas/${CH}/paymentIntents/${ref}`)).status, "success");
  const txn = await db.read(`chamas/${CH}/transactions/${ref}`);
  assert.equal(txn.amount, 1000); assert.equal(txn.direction, "in"); assert.equal(txn.channel, "app");
  assert.equal(smsCalls.length, 1); assert.equal(smsCalls[0][0], PHONE);
});
await t("legacy callers (no currency argument) still work unchanged", async () => {
  await seedChama(); const ref = await seedIntent();
  await handlers.handleMyChamaPayment(ref, CH, kobo(gross1000()));
  assert.equal((await db.read(`chamas/${CH}/paymentIntents/${ref}`)).status, "success");
});

// ═══════════════════════════ C. non-payment handlers ═══════════════════════════
console.log("C. MCS / MCP / MCX / MCR");
await t("MCS: wrong amount blocked; right amount credits once; replay no double credit", async () => {
  await seedChama(); const ref = `MCS-${CH}-1758100000000-ABC123`;
  await db.seed(`chamas/${CH}/smsTopUps/${ref}`, { chamaId: CH, amountKes: 500, status: "pending" });
  await handlers.handleMyChamaSmsTopup(ref, CH, kobo(499), "KES");
  assert.equal((await db.read(`chamas/${CH}`)).smsCredits, 0); assert.match((await db.read(`chamas/${CH}/smsTopUps/${ref}`)).applyNote, /mismatch/);
  await handlers.handleMyChamaSmsTopup(ref, CH, kobo(500), "KES");
  await handlers.handleMyChamaSmsTopup(ref, CH, kobo(500), "KES");
  assert.equal((await db.read(`chamas/${CH}`)).smsCredits, 500);
  assert.equal((await db.read(`chamas/${CH}/smsTopUps/${ref}`)).status, "success");
});
await t("MCP: Chama's metadata shape (toPlan only) now upgrades the plan; conflicts/mismatches/missing doc are blocked", async () => {
  await seedChama(CH, { plan: "free" }); const ref = `MCP-${CH}-1758100000000-ABC123`;
  await db.seed(`chamas/${CH}/planBilling/${ref}`, { chamaId: CH, fromPlan: "free", toPlan: "growth", amountKes: 2499, status: "pending" });
  await handlers.handleMyChamaPlanBilling(ref, CH, "max", kobo(2499), "KES");              // metadata disagrees with the doc
  assert.equal((await db.read(`chamas/${CH}`)).plan, "free");
  await handlers.handleMyChamaPlanBilling(ref, CH, "growth", kobo(1), "KES");               // wrong amount
  assert.equal((await db.read(`chamas/${CH}`)).plan, "free");
  await handlers.handleMyChamaPlanBilling(`MCP-${CH}-0-NOPE`, CH, "growth", kobo(2499), "KES");   // no billing doc => nothing
  assert.equal((await db.read(`chamas/${CH}`)).plan, "free");
  await handlers.handleMyChamaPlanBilling(ref, CH, undefined, kobo(2499), "KES");           // plan only on the doc
  const c = await db.read(`chamas/${CH}`);
  assert.equal(c.plan, "growth"); assert.match(c.planExpiry, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal((await db.read(`chamas/${CH}/planBilling/${ref}`)).status, "success");
});
await t("MCX: credits (not KES) are added once; wrong amount blocked; bad credits blocked", async () => {
  await seedChama(CH, { reportCreditsBalance: 3 }); const ref = `MCX-${CH}-1758100000000-ABC123`;
  await db.seed(`chamas/${CH}/reportCreditTopUps/${ref}`, { chamaId: CH, credits: 10, amountKes: 560, status: "pending" });
  await handlers.handleMyChamaReportCreditTopup(ref, CH, kobo(100), "KES");
  assert.equal((await db.read(`chamas/${CH}`)).reportCreditsBalance, 3);
  await handlers.handleMyChamaReportCreditTopup(ref, CH, kobo(560), "KES");
  await handlers.handleMyChamaReportCreditTopup(ref, CH, kobo(560), "KES");
  assert.equal((await db.read(`chamas/${CH}`)).reportCreditsBalance, 13);
  const bad = `MCX-${CH}-1758100000001-ZZZ999`;
  await db.seed(`chamas/${CH}/reportCreditTopUps/${bad}`, { chamaId: CH, credits: "lots", amountKes: 560, status: "pending" });
  await handlers.handleMyChamaReportCreditTopup(bad, CH, kobo(560), "KES");
  assert.equal((await db.read(`chamas/${CH}`)).reportCreditsBalance, 13);
});
await t("MCR: flips to success only for the right amount/currency", async () => {
  await seedChama(); const ref = `MCR-${CH}-1758100000000-ABC123`;
  await db.seed(`chamas/${CH}/reportAlacartePurchases/${ref}`, { chamaId: CH, amountKes: 360, status: "pending" });
  await handlers.handleMyChamaReportAlacarte(ref, CH, kobo(360), "USD");
  assert.equal((await db.read(`chamas/${CH}/reportAlacartePurchases/${ref}`)).status, "pending");
  await handlers.handleMyChamaReportAlacarte(ref, CH, kobo(360), "KES");
  assert.equal((await db.read(`chamas/${CH}/reportAlacartePurchases/${ref}`)).status, "success");
});

// ═══════════════════════════ D. dispatcher ═══════════════════════════
console.log("D. dispatcher");
await t("non-MyChama reference: ignored, nothing touched", async () => {
  await seedChama();
  assert.equal(await dispatch.dispatchChargeSuccess({ reference: "CYBER_123", amount: 100, currency: "KES" }), "ignored_non_mychama");
  assert.equal(await dispatch.dispatchChargeFailed({ reference: "INV_9" }), "ignored_non_mychama");
  assert.equal((await db.list(`chamas/${CH}/paymentIntents`)).length, 0);
});
await t("success event without amount/currency is NOT applied", async () => {
  await seedChama(); const ref = await seedIntent();
  assert.equal(await dispatch.dispatchChargeSuccess({ reference: ref, currency: "KES" }), "ignored_invalid");
  assert.equal(await dispatch.dispatchChargeSuccess({ reference: ref, amount: kobo(gross1000()) }), "ignored_invalid");
  assert.equal((await db.read(`chamas/${CH}/paymentIntents/${ref}`)).status, "pending");
});
await t("hyphenated chamaId resolves from the reference; metadata.chamaId cannot redirect the payment", async () => {
  await seedChama("sun-rise-01"); const ref = `MCA-sun-rise-01-CNT-1758100000000-A7K2QX`;
  await seedIntent("sun-rise-01", ref);
  await seedChama("other");
  await dispatch.dispatchChargeSuccess({ reference: ref, amount: kobo(gross1000()), currency: "KES", metadata: { chamaId: "other" } });
  assert.equal((await db.read(`chamas/sun-rise-01/paymentIntents/${ref}`)).status, "success");
  assert.equal((await db.read(`chamas/other/contributions/c1`)).paidAmount, 0);
});
await t("MCP through the dispatcher uses metadata.toPlan (Chama's real shape)", async () => {
  await seedChama(CH, { plan: "free" }); const ref = `MCP-${CH}-1758100000000-ABC123`;
  await db.seed(`chamas/${CH}/planBilling/${ref}`, { chamaId: CH, fromPlan: "free", toPlan: "basic", amountKes: 999, status: "pending" });
  await dispatch.dispatchChargeSuccess({ reference: ref, amount: kobo(999), currency: "KES", metadata: { chargeType: "mychama_plan_upgrade", toPlan: "basic", chamaId: CH } });
  assert.equal((await db.read(`chamas/${CH}`)).plan, "basic");
});
await t("charge.failed: pending -> failed; a success is never overwritten", async () => {
  await seedChama(); const r1 = await seedIntent(CH, `MCA-${CH}-CNT-1758100000001-AAAAAA`);
  const r2 = await seedIntent(CH, `MCA-${CH}-CNT-1758100000002-BBBBBB`, { status: "success" });
  await dispatch.dispatchChargeFailed({ reference: r1, gateway_response: "Insufficient funds" });
  await dispatch.dispatchChargeFailed({ reference: r2, gateway_response: "late failure event" });
  const a = await db.read(`chamas/${CH}/paymentIntents/${r1}`);
  assert.equal(a.status, "failed"); assert.equal(a.paystackMessage, "Insufficient funds");
  assert.equal((await db.read(`chamas/${CH}/paymentIntents/${r2}`)).status, "success");
});

// ═══════════════════════════ E. mychamaPayInitiate ═══════════════════════════
console.log("E. mychamaPayInitiate");
const LINK = (extra = {}) => ({ linkId: `${CH}__m1`, uid: "u1", chamaId: CH, memberId: "m1", chamaName: "Sunrise", state: "active", verifiedVia: "sms_code", boundPhoneKey: cfg.computePhoneKey(PHONE), boundPhoneMasked: "07•• ••• 678", linkedAt: 1, updatedAt: 1, ...extra });
const seedLink = (extra) => plot.seed(`chamaLinks/u1/links/${CH}__m1`, LINK(extra));
const call = (data, auth = { uid: "u1", token: { role: "tenant" } }) => mychamaPayInitiate.run({ data, auth, rawRequest: {} });
const base = (extra = {}) => ({ chamaId: CH, purpose: "contribution", amount: 1000, contributionId: "c1", clientRequestId: "req-" + crypto.randomUUID(), ...extra });

await t("unauthenticated / not linked / needs_reverify / phone changed", async () => {
  await seedChama();
  assert.equal(await code(call(base(), null)), "unauthenticated");
  assert.equal(await code(call(base())), "not_linked");
  await seedLink({ state: "needs_reverify" });
  assert.equal(await code(call(base())), "link_needs_reverify");
  await seedLink();
  await db.seed(`chamas/${CH}/members/m1`, { name: "Ann", status: "active", phone: "0799999999", phoneNormalized: "+254799999999" });   // chair changed the phone
  assert.equal(await code(call(base())), "link_needs_reverify");
  assert.equal(chargeCalls.length, 0);
});
await t("happy path: intent shaped like Chama's, charge with NEW key + split_code, member from the link, idempotent result stored", async () => {
  await seedChama(); await seedLink();
  const res = await call(base({ memberId: "m2", clientRequestId: "req-happy-0001" }));        // a client-supplied memberId is ignored
  const f = fees.contributionFees(1000);
  assert.equal(res.grossAmount, f.gross); assert.equal(res.paystackFee, f.paystackFee); assert.equal(res.ourFee, f.ourFee);
  assert.match(res.reference, new RegExp(`^MCA-${CH}-CNT-\\d{13}-[A-Z0-9]{6}$`)); assert.equal(res.message, "Enter your M-Pesa PIN");

  const i = await db.read(`chamas/${CH}/paymentIntents/${res.reference}`);
  assert.equal(i.memberId, "m1"); assert.equal(i.amount, 1000); assert.equal(i.grossAmount, f.gross); assert.equal(i.currency, "KES");
  assert.equal(i.status, "pending"); assert.equal(i.channel, "app"); assert.equal(i.via, "pay_portal");
  assert.deepEqual(i.initiatedBy, { uid: "u1", role: "tenant" }); assert.equal(i.phone, PHONE); assert.equal(i.provider, "mpesa");
  assert.equal(i.phoneOverridden, false); assert.equal(i.contributionId, "c1"); assert.equal(i.loanId, null); assert.equal(i.arrearId, null);
  assert.equal(i.splitCode, "SPL_new"); assert.equal(i.expiresAt - i.createdAt, 1800000); assert.equal(i.paystackMessage, "Enter your M-Pesa PIN");

  assert.equal(chargeCalls.length, 1);
  const c = chargeCalls[0];
  assert.equal(c.url, "https://api.paystack.co/charge");
  assert.equal(c.opts.headers.Authorization, "Bearer sk_test_unit_secret");
  assert.equal(c.body.amount, kobo(f.gross)); assert.equal(c.body.currency, "KES");
  // routed by subaccount + flat charge so the chama is paid exactly the net (never the split code)
  assert.equal(c.body.split_code, undefined); assert.equal(c.body.subaccount, "ACCT_new"); assert.equal(c.body.bearer, "account");
  assert.equal(c.body.amount - c.body.transaction_charge, kobo(1000)); assert.equal(c.body.transaction_charge, fees.mainAccountChargeSubunits(f.gross, 1000));
  assert.deepEqual(c.body.mobile_money, { phone: PHONE, provider: "mpesa" }); assert.equal(c.body.reference, res.reference);
  assert.equal(c.body.metadata.chargeType, "mychama_payment"); assert.equal(c.body.metadata.targetProject, "mychama1");
  assert.equal(c.body.metadata.memberId, "m1"); assert.equal(c.body.metadata.splitCode, "SPL_new");

  const k = await db.read(`chamas/${CH}/idempotencyKeys/req-happy-0001`);
  assert.equal(k.status, "done"); assert.equal(k.result.reference, res.reference); assert.ok(k.expiresAt > Date.now());
});
await t("replay with the same clientRequestId returns the same result and does NOT charge twice", async () => {
  await seedChama(); await seedLink();
  const d = base({ clientRequestId: "req-replay-001" });
  const a = await call(d), b = await call(d);
  assert.deepEqual(b, a); assert.equal(chargeCalls.length, 1);
  assert.equal((await db.list(`chamas/${CH}/paymentIntents`)).length, 1);
});
await t("another member cannot read someone else's stored result via the same clientRequestId", async () => {
  await seedChama(); await seedLink();
  await call(base({ clientRequestId: "shared-key-001" }));
  await plot.seed(`chamaLinks/u2/links/${CH}__m2`, LINK({ linkId: `${CH}__m2`, uid: "u2", memberId: "m2", boundPhoneKey: cfg.computePhoneKey("+254722000000") }));
  assert.equal(await code(call(base({ clientRequestId: "shared-key-001", contributionId: "c2" }), { uid: "u2", token: {} })), "invalid_target");
  assert.equal(chargeCalls.length, 1);
});
await t("targets: someone else's contribution, paid contribution, unsafe ids, wrong purpose fields", async () => {
  await seedChama(); await seedLink();
  assert.equal(await code(call(base({ contributionId: "c2" }))), "invalid_target");
  assert.equal(await code(call(base({ contributionId: "../members/m2" }))), "invalid_target");
  assert.equal(await code(call(base({ contributionId: undefined }))), "invalid_target");
  await db.seed(`chamas/${CH}/contributions/c3`, { memberId: "m1", amount: 500, paidAmount: 500, status: "paid" });
  assert.equal(await code(call(base({ contributionId: "c3" }))), "invalid_target");
  assert.equal(await code(call(base({ chamaId: "a/b" }))), "invalid_target");
  assert.equal(await code(call(base({ purpose: "withdrawal" }))), "invalid_target");
  assert.equal(await code(call(base({ clientRequestId: "short" }))), "invalid_target");
  assert.equal(chargeCalls.length, 0);
});
await t("loan: own open instalment OK; other member's loan / completed loan / paid instalment refused; LNR reference + plan markup", async () => {
  await seedChama(); await seedLink();
  const sched = [{ n: 1, due: 600, paid: true, paidAmount: 600 }, { n: 2, due: 600, paid: false, paidAmount: 0 }];
  await db.seed(`chamas/${CH}/loans/L1`, { memberId: "m1", status: "active", schedule: sched });
  await db.seed(`chamas/${CH}/loans/L2`, { memberId: "m2", status: "active", schedule: sched });
  await db.seed(`chamas/${CH}/loans/L3`, { memberId: "m1", status: "completed", schedule: sched });
  const loan = (extra) => base({ purpose: "loan_repayment", amount: 600, contributionId: undefined, loanId: "L1", installmentNo: 2, ...extra });
  assert.equal(await code(call(loan({ loanId: "L2" }))), "invalid_target");
  assert.equal(await code(call(loan({ loanId: "L3" }))), "invalid_target");
  assert.equal(await code(call(loan({ installmentNo: 1 }))), "invalid_target");
  assert.equal(await code(call(loan({ installmentNo: 9 }))), "invalid_target");
  assert.equal(await code(call(loan({ installmentNo: undefined }))), "invalid_target");
  const res = await call(loan());
  assert.match(res.reference, /-LNR-/); assert.equal(res.grossAmount, fees.loanRepaymentFees(600, "starter").gross);
  const i = await db.read(`chamas/${CH}/paymentIntents/${res.reference}`);
  assert.equal(i.loanId, "L1"); assert.equal(i.installmentNo, 2); assert.equal(i.contributionId, null);
});
await t("MGR: current period, arrear, closed pot, non-member, stale period, fully-paid period", async () => {
  await seedChama(); await seedLink();
  await db.seed(`chamas/${CH}/mgrPots/P1`, { name: "Pot", status: "active", period: 3, amount: 500, memberIds: ["m1", "m2"] });
  await db.seed(`chamas/${CH}/mgrPots/P2`, { name: "Closed", status: "closed", period: 1, amount: 500, memberIds: ["m1"] });
  await db.seed(`chamas/${CH}/mgrPots/P3`, { name: "NotMine", status: "active", period: 1, amount: 500, memberIds: ["m2"] });
  await db.seed(`chamas/${CH}/mgrPots/P1/arrears/A1`, { memberId: "m1", status: "open", amount: 300 });
  await db.seed(`chamas/${CH}/mgrPots/P1/arrears/A2`, { memberId: "m2", status: "open", amount: 300 });
  const mgr = (extra) => base({ purpose: "mgr_contribution", amount: 500, contributionId: undefined, potId: "P1", potPeriod: 3, ...extra });
  assert.equal(await code(call(mgr({ potId: "P2", potPeriod: 1 }))), "invalid_target");
  assert.equal(await code(call(mgr({ potId: "P3", potPeriod: 1 }))), "invalid_target");
  assert.equal(await code(call(mgr({ potPeriod: 2 }))), "invalid_target");
  assert.equal(await code(call(mgr({ arrearId: "A2", potPeriod: undefined }))), "invalid_target");
  const ok = await call(mgr());
  assert.match(ok.reference, /-MGR-/); assert.equal(ok.grossAmount, fees.mgrContributionFees(500).gross);
  assert.equal((await db.read(`chamas/${CH}/paymentIntents/${ok.reference}`)).potPeriod, 3);
  const arr = await call(mgr({ arrearId: "A1", potPeriod: undefined, amount: 300 }));
  const ai = await db.read(`chamas/${CH}/paymentIntents/${arr.reference}`);
  assert.equal(ai.arrearId, "A1"); assert.equal(ai.potPeriod, null);
  await db.seed(`chamas/${CH}/mgrPots/P1/records/r1`, { memberId: "m1", period: 3, status: "paid", amount: 500 });
  assert.equal(await code(call(mgr())), "invalid_target");
});
await t("chama gates: no split / old-account split / free plan => online_collection_disabled; suspended or missing => chama_unavailable", async () => {
  await seedLink();
  await seedChama(CH, { settlementSplitCode: undefined });
  assert.equal(await code(call(base())), "online_collection_disabled");
  await seedChama(CH, { settlementSplitKeyVersion: undefined });            // split code exists but belongs to the OLD account
  assert.equal(await code(call(base())), "online_collection_disabled");
  await seedChama(CH, { settlementSubaccountCode: undefined });             // no subaccount to route the exact net to
  assert.equal(await code(call(base())), "online_collection_disabled");
  await seedChama(CH, { plan: "free" });
  assert.equal(await code(call(base())), "online_collection_disabled");
  await seedChama(CH, { status: "suspended" });
  assert.equal(await code(call(base())), "chama_unavailable");
  await db.reset();
  assert.equal(await code(call(base())), "chama_unavailable");
  assert.equal(chargeCalls.length, 0);
});
await t("amounts: zero / negative / string / 3 decimals / over the mobile-money limit => invalid_amount", async () => {
  await seedChama(); await seedLink();
  for (const amount of [0, -5, "100", 100.123, NaN, 0.5, 250000]) assert.equal(await code(call(base({ amount }))), "invalid_amount", String(amount));
  assert.equal(chargeCalls.length, 0);
});
await t("phone: explicit override is recorded; invalid phone refused; airtel prefix detected", async () => {
  await seedChama(); await seedLink();
  assert.equal(await code(call(base({ phone: "12345" }))), "invalid_phone");
  const res = await call(base({ phone: "0733 111 222" }));
  const i = await db.read(`chamas/${CH}/paymentIntents/${res.reference}`);
  assert.equal(i.phone, "+254733111222"); assert.equal(i.phoneOverridden, true); assert.equal(i.memberPhoneOnFile, PHONE); assert.equal(i.provider, "airtel");
});
await t("rate limit: 10 intents in the last hour => rate_limited (older ones don't count)", async () => {
  await seedChama(); await seedLink();
  for (let n = 0; n < 9; n++) await seedIntent(CH, `MCA-${CH}-CNT-17581000000${n}0-OLD00${n}`, { status: "failed" });
  await seedIntent(CH, `MCA-${CH}-CNT-1758100000999-ANCIEN`, { status: "failed", createdAt: Date.now() - 2 * 3600 * 1000 });
  await call(base());                                                           // 10th in the hour: allowed
  assert.equal(await code(call(base())), "rate_limited");                       // 11th: refused
});
await t("Paystack failure: intent -> failed, upstream_failure, idempotency key RELEASED so the retry works", async () => {
  await seedChama(); await seedLink();
  chargeImpl = async () => { throw Object.assign(new Error("boom"), { response: { status: 502, data: { message: "gateway down" } } }); };
  const d = base({ clientRequestId: "req-retry-0001" });
  assert.equal(await code(call(d)), "upstream_failure");
  const ids = await db.list(`chamas/${CH}/paymentIntents`);
  assert.equal(ids.length, 1); assert.equal((await db.read(ids[0])).status, "failed");
  assert.equal(await db.read(`chamas/${CH}/idempotencyKeys/req-retry-0001`), undefined);
  chargeImpl = async () => ({ data: { status: true, data: { status: "pay_offline", display_text: "ok" } } });
  const again = await call(d);
  assert.equal((await db.read(`chamas/${CH}/paymentIntents/${again.reference}`)).status, "pending");
  chargeImpl = async () => ({ data: { status: false, message: "Invalid split" } });
  assert.equal(await code(call(base({ clientRequestId: "req-reject-001" }))), "upstream_failure");   // 200-with-status:false is a failure too
});
await t("concurrent duplicates: second call while the first is in flight is refused, a stale placeholder is taken over", async () => {
  await seedChama(); await seedLink();
  await db.seed(`chamas/${CH}/idempotencyKeys/req-inflight-1`, { status: "pending", createdAt: Date.now() });
  assert.equal(await code(call(base({ clientRequestId: "req-inflight-1" }))), "rate_limited");
  await db.seed(`chamas/${CH}/idempotencyKeys/req-stale-0001`, { status: "pending", createdAt: Date.now() - 10 * 60 * 1000 });
  const ok = await call(base({ clientRequestId: "req-stale-0001" }));
  assert.ok(ok.reference);
});
await t("end to end: initiate -> signed webhook body -> handler applies exactly once", async () => {
  await seedChama(); await seedLink();
  const res = await call(base({ clientRequestId: "req-e2e-00001" }));
  const body = Buffer.from(JSON.stringify({ event: "charge.success", data: { reference: res.reference, amount: kobo(res.grossAmount), currency: "KES", status: "success", metadata: { chamaId: CH } } }));
  assert.equal(util.verifyPaystackSignature(body, sign(body), process.env.MYCHAMA_PAYSTACK_SECRET_KEY), true);
  const ev = JSON.parse(body.toString());
  await dispatch.dispatchChargeSuccess(ev.data);
  await dispatch.dispatchChargeSuccess(ev.data);                                  // Paystack retry
  assert.equal((await db.read(`chamas/${CH}/paymentIntents/${res.reference}`)).status, "success");
  assert.equal((await db.read(`chamas/${CH}/contributions/c1`)).paidAmount, 1000);
  assert.equal((await db.read(`chamas/${CH}/members/m1`)).totalContributed, 1000);
  assert.equal(smsCalls.length, 1);
});

// ═══════════════════════════ F. the real HTTP handler ═══════════════════════════
console.log("F. mychamaPaystackCallback (HTTP)");
const { mychamaPaystackCallback } = require("./lib/mychama/webhook");
const express = require("express");
const app = express();
app.use(express.text({ type: () => true, verify: (req, _res, buf) => { req.rawBody = buf; } }));   // Cloud Functions exposes req.rawBody the same way
app.all("*", mychamaPaystackCallback);
const server = await new Promise((r) => { const sv = app.listen(0, "127.0.0.1", () => r(sv)); });
const URL_ = `http://127.0.0.1:${server.address().port}/`;
async function hit({ method = "POST", body, signature, rawBody }) {
  const raw = rawBody ?? Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  const r = await fetch(URL_, { method, headers: { "content-type": "application/json", ...(signature === undefined ? {} : { "x-paystack-signature": signature }) }, body: method === "GET" ? undefined : raw });
  return { status: r.status, json: await r.json().catch(() => null) };
}
await t("405 non-POST; 400 missing/bad/old-account signature; nothing applied", async () => {
  await seedChama(); const ref = await seedIntent();
  const ev = { event: "charge.success", data: { reference: ref, amount: kobo(gross1000()), currency: "KES", status: "success" } };
  const raw = Buffer.from(JSON.stringify(ev));
  assert.equal((await hit({ method: "GET", body: ev })).status, 405);
  assert.equal((await hit({ body: ev })).status, 400);
  assert.equal((await hit({ body: ev, signature: "deadbeef" })).status, 400);
  assert.equal((await hit({ body: ev, signature: sign(raw, "sk_live_OLD_ACCOUNT_KEY") })).status, 400);
  assert.equal((await hit({ body: ev, signature: sign(Buffer.from(JSON.stringify({ ...ev, x: 1 }))) })).status, 400);   // signed different bytes
  assert.equal((await db.read(`chamas/${CH}/paymentIntents/${ref}`)).status, "pending");
});
await t("valid signed event applies (200); the identical event replayed is 200 and a no-op", async () => {
  await seedChama(); const ref = await seedIntent();
  const raw = Buffer.from(JSON.stringify({ event: "charge.success", data: { reference: ref, amount: kobo(gross1000()), currency: "KES", status: "success" } }));
  const r1 = await hit({ rawBody: raw, body: "", signature: sign(raw) });
  const r2 = await hit({ rawBody: raw, body: "", signature: sign(raw) });
  assert.equal(r1.status, 200); assert.equal(r2.status, 200);
  assert.equal((await db.read(`chamas/${CH}/contributions/c1`)).paidAmount, 1000);
  assert.equal(smsCalls.length, 1);
});
await t("non-MyChama reference, unknown event types and bad JSON: 200 / 200 / 400, nothing applied", async () => {
  const mk = (o) => { const raw = Buffer.from(JSON.stringify(o)); return { rawBody: raw, body: "", signature: sign(raw) }; };
  assert.equal((await hit(mk({ event: "charge.success", data: { reference: "CYBER_55", amount: 100, currency: "KES" } }))).status, 200);
  assert.equal((await hit(mk({ event: "transfer.success", data: {} }))).status, 200);
  const junk = Buffer.from("not json");
  assert.equal((await hit({ rawBody: junk, body: "", signature: sign(junk) })).status, 400);
});
await t("amount mismatch is a permanent error => 200 (no retry storm); a Firestore outage is transient => 500", async () => {
  await seedChama(); const ref = await seedIntent();
  const raw = Buffer.from(JSON.stringify({ event: "charge.success", data: { reference: ref, amount: 1, currency: "KES", status: "success" } }));
  assert.equal((await hit({ rawBody: raw, body: "", signature: sign(raw) })).status, 200);
  assert.ok((await db.read(`chamas/${CH}/paymentIntents/${ref}`)).applyNote);
  const good = Buffer.from(JSON.stringify({ event: "charge.success", data: { reference: ref, amount: kobo(gross1000()), currency: "KES", status: "success" } }));
  const orig = cfg.mychamaDb; cfg.mychamaDb = () => { throw new Error("firestore unavailable"); };
  const r = await hit({ rawBody: good, body: "", signature: sign(good) });
  cfg.mychamaDb = orig;
  assert.equal(r.status, 500);
});

server.close();
console.log(`\n${EMULATOR ? "[emulator]" : "[in-memory]"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
