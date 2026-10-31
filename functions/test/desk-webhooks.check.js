/* Desk money paths against an in-memory Firestore (no emulator needed; Paystack mocked at axios).
 * Run:  cd functions && npm run build && node test/desk-webhooks.check.js   (exit 1 on failure) */
process.env.PAYSTACK_SECRET_KEY = "sk_test_unit";
process.env.MYCHAMA_PAYSTACK_SECRET_KEY = "sk_test_unit_mychama";
process.env.MYCHAMA_ID_PEPPER = "unit-pepper";
const assert = require("assert");
const crypto = require("crypto");
const path = require("path");
const { FakeDb } = require("./desk-fake-firestore");
const lib = (p) => require(path.join(__dirname, "..", "lib", p));

const deskdb = lib("desk/db");
const cfgMod = lib("desk/config");
const sms = lib("desk/sms");
const hooks = lib("desk/hooks");
const events = lib("desk/events");
const splitMod = lib("desk/split");
const rentCharge = lib("desk/rentCharge");
const mychamaCfg = lib("mychama/config");
const handlers = lib("mychama/webhook/handlers");
const dispatch = lib("mychama/webhook/dispatch");
const axios = require("axios");

const plot = new FakeDb();     // the shared project database (desk_*, users, transactions…)
const chama = new FakeDb();    // MyChama's database
deskdb.deskDb = () => plot;
mychamaCfg.mychamaDb = () => chama;
mychamaCfg.plotDb = () => plot;

let paystackCalls = [];
let paystackImpl;
const defaultPaystack = async (url, body) => {
  if (url.endsWith("/split")) return { data: { status: true, data: { split_code: "SPL_" + crypto.createHash("md5").update(JSON.stringify(body.subaccounts)).digest("hex").slice(0, 10) } } };
  if (url.endsWith("/charge")) return { data: { status: true, data: { reference: body.reference, status: "pay_offline", display_text: "Enter your M-Pesa PIN" } } };
  throw new Error("unexpected Paystack call " + url);
};
axios.post = async (url, body, opts) => { paystackCalls.push({ url, body, opts }); return paystackImpl(url, body, opts); };

let passed = 0, failed = 0;
async function t(name, fn) {
  try {
    plot.reset(); chama.reset(); cfgMod.clearDeskConfigCache(); paystackCalls = []; paystackImpl = defaultPaystack;
    await fn(); passed++; console.log("  ✓", name);
  } catch (e) { failed++; console.error("  ✗", name, "\n", e); }
}
const splitCalls = () => paystackCalls.filter((c) => c.url.endsWith("/split"));
const chargeCalls = () => paystackCalls.filter((c) => c.url.endsWith("/charge"));
const eventDocs = () => plot.list("desk_events").map((p) => plot.read(p));
const auditRows = () => plot.list("desk_audit").map((p) => plot.read(p));

const ENTITY = "pms:PYL-0001";
function seedDesk({ entity = ENTITY, used = false, agent = {}, sub = "ACCT_agent1", selfOwned = false } = {}) {
  plot.seed(`desk_customers/${entity}`, { entityKey: entity, product: entity.split(":")[0], ownerAgentId: "ag1", attributedAt: 1, firstPurchaseUsed: used, selfOwned, paidPeriods: [] });
  plot.seed("desk_agents/ag1", { agentId: "ag1", agentCode: "COG-0001", status: "active", rank: "senior", ...agent });
  if (sub) plot.seed("agents/ag1", { paymentInfo: { accountId: sub } });
}
const settle = { amount: 15000, fees: 225, paid_at: "2026-10-09T10:00:00.000Z" };

(async () => {
  console.log("owner resolution");
  await t("requires ownerAgentId, not selfOwned, an active desk agent and a payout subaccount", async () => {
    const { resolveDeskOwner } = lib("desk/owner");
    assert.strictEqual(await resolveDeskOwner(ENTITY), null);
    seedDesk();
    assert.deepStrictEqual(await resolveDeskOwner(ENTITY), { agentId: "ag1", agentCode: "COG-0001", rank: "senior", subaccountCode: "ACCT_agent1" });
    seedDesk({ selfOwned: true }); assert.strictEqual(await resolveDeskOwner(ENTITY), null);
    seedDesk({ agent: { status: "suspended" } }); assert.strictEqual(await resolveDeskOwner(ENTITY), null);
    seedDesk({ sub: null }); plot.store.delete("agents/ag1"); assert.strictEqual(await resolveDeskOwner(ENTITY), null);
    seedDesk({ sub: "not-a-subaccount" }); assert.strictEqual(await resolveDeskOwner(ENTITY), null);
  });

  console.log("split cache");
  await t("getOrCreateDeskSplit shares the kernel's key and document shape, validates, and reuses the cache", async () => {
    const subs = [{ subaccount: "ACCT_b", sharePct: 10.5 }, { subaccount: "ACCT_a", sharePct: 20 }];
    const canon = ["ACCT_a:2000", "ACCT_b:1050"].join("|");
    const key = crypto.createHash("sha256").update(canon).digest("hex").slice(0, 32);
    assert.strictEqual(splitMod.splitKey(subs), key);
    const code = await splitMod.getOrCreateDeskSplit(subs, "rent");
    const doc = plot.read(`desk_split_codes/${key}`);
    assert.strictEqual(doc.splitCode, code); assert.strictEqual(doc.label, "rent"); assert.ok(doc.createdAt); assert.deepStrictEqual(doc.subs.map((s) => s.subaccount).sort(), ["ACCT_a", "ACCT_b"]);
    assert.strictEqual(splitCalls()[0].body.bearer_type, "all-proportional");
    assert.strictEqual(await splitMod.getOrCreateDeskSplit(subs, "rent"), code);
    assert.strictEqual(splitCalls().length, 1);
    for (const bad of [[], [{ subaccount: "main", sharePct: 5 }], [{ subaccount: "ACCT_x", sharePct: 0 }], [{ subaccount: "ACCT_x", sharePct: 100 }], [{ subaccount: "ACCT_x", sharePct: 60 }, { subaccount: "ACCT_y", sharePct: 40 }]]) {
      await assert.rejects(() => splitMod.getOrCreateDeskSplit(bad, "x"));
    }
    assert.strictEqual(plot.list("desk_split_codes").length, 1);
  });

  console.log("SMS top-ups");
  await t("desk-owned first purchase of KES 150 gives the desk 71.03%, reserves once, and the settle writes ONE event", async () => {
    seedDesk();
    const plan = await sms.planDeskSmsCharge({ entityKey: ENTITY, reference: "SMS_u1_1", grossMinor: 15000, credits: 214 });
    assert.strictEqual(plan.applied, true); assert.strictEqual(plan.commission.sharePct, 71.03); assert.strictEqual(plan.commission.rule, "sms_first_purchase");
    assert.deepStrictEqual(splitCalls()[0].body.subaccounts, [{ subaccount: "ACCT_agent1", share: 71.03 }]);
    const cust = plot.read(`desk_customers/${ENTITY}`);
    assert.strictEqual(cust.firstPurchaseReservedRef, "SMS_u1_1"); assert.ok(cust.firstPurchaseReservedAt > 0);
    const pending = { reference: "SMS_u1_1", deskCommission: plan.commission };
    assert.strictEqual(await sms.recordSmsPurchaseEvent({ reference: "SMS_u1_1", tokens: 214, data: settle, pending }), "written");
    const [e] = eventDocs();
    assert.deepStrictEqual(e, { eventId: "sms_purchase:SMS_u1_1", type: "sms_purchase", product: "pms", entityKey: ENTITY, agentId: "ag1", paystackRef: "SMS_u1_1", grossMinor: 15000, feeMinor: 225, agentSharePct: 71.03, paidAt: Date.parse(settle.paid_at), credits: 214 });
    // replayed webhook: no second event
    assert.strictEqual(await sms.recordSmsPurchaseEvent({ reference: "SMS_u1_1", tokens: 214, data: settle, pending }), "duplicate");
    assert.strictEqual(eventDocs().length, 1);
  });
  await t("after the first purchase is consumed, the second purchase earns 45% of margin (standard rule)", async () => {
    seedDesk({ used: true });
    const plan = await sms.planDeskSmsCharge({ entityKey: ENTITY, reference: "SMS_u1_2", grossMinor: 50000, credits: 714 });
    assert.strictEqual(plan.applied, true); assert.strictEqual(plan.commission.rule, "sms_standard"); assert.strictEqual(plan.commission.sharePct, 31.95);
    assert.strictEqual(plan.reservedFirstPurchase, false);
    assert.strictEqual(plot.read(`desk_customers/${ENTITY}`).firstPurchaseReservedRef, undefined);
  });
  await t("a first purchase at or above KES 200 is standard and takes no reservation", async () => {
    seedDesk();
    const plan = await sms.planDeskSmsCharge({ entityKey: ENTITY, reference: "SMS_u1_3", grossMinor: 25000, credits: 357 });
    assert.strictEqual(plan.commission.rule, "sms_standard"); assert.strictEqual(plan.reservedFirstPurchase, false);
  });
  await t("reserve -> failure releases; reserve -> success keeps it for the events trigger; only the holder can release", async () => {
    seedDesk();
    const plan = await sms.planDeskSmsCharge({ entityKey: ENTITY, reference: "SMS_u1_4", grossMinor: 15000, credits: 214 });
    const pending = { deskCommission: plan.commission };
    assert.strictEqual(await sms.releaseFirstPurchaseReservation(ENTITY, "SMS_someone_else"), false);
    assert.strictEqual(plot.read(`desk_customers/${ENTITY}`).firstPurchaseReservedRef, "SMS_u1_4");
    assert.strictEqual(await sms.releaseSmsReservationFor(pending, "SMS_u1_4"), true);
    const c = plot.read(`desk_customers/${ENTITY}`);
    assert.strictEqual(c.firstPurchaseReservedRef, undefined); assert.strictEqual(c.firstPurchaseReservedAt, undefined); assert.strictEqual(c.ownerAgentId, "ag1");
    const again = await sms.planDeskSmsCharge({ entityKey: ENTITY, reference: "SMS_u1_5", grossMinor: 15000, credits: 214 });
    assert.strictEqual(again.commission.rule, "sms_first_purchase");   // the first purchase is still available
  });
  await t("a live reservation blocks a concurrent first purchase; a reservation older than 30 minutes does not", async () => {
    seedDesk();
    const now = Date.now();
    await sms.planDeskSmsCharge({ entityKey: ENTITY, reference: "SMS_a", grossMinor: 15000, credits: 214, now });
    const during = await sms.planDeskSmsCharge({ entityKey: ENTITY, reference: "SMS_b", grossMinor: 15000, credits: 214, now: now + 60_000 });
    assert.strictEqual(during.commission.rule, "sms_standard");
    assert.strictEqual(plot.read(`desk_customers/${ENTITY}`).firstPurchaseReservedRef, "SMS_a");
    const after = await sms.planDeskSmsCharge({ entityKey: ENTITY, reference: "SMS_c", grossMinor: 15000, credits: 214, now: now + 31 * 60_000 });
    assert.strictEqual(after.commission.rule, "sms_first_purchase");
    assert.strictEqual(plot.read(`desk_customers/${ENTITY}`).firstPurchaseReservedRef, "SMS_c");
  });
  await t("no event without deskCommission; unowned customers get a plain charge; the 50 free tokens are not a purchase", async () => {
    assert.strictEqual(await sms.recordSmsPurchaseEvent({ reference: "SMS_x", tokens: 10, data: settle, pending: { reference: "SMS_x" } }), "skipped");
    assert.strictEqual(await sms.recordSmsPurchaseEvent({ reference: "SMS_x", tokens: 10, data: settle, pending: undefined }), "skipped");
    assert.strictEqual(eventDocs().length, 0);
    const plan = await sms.planDeskSmsCharge({ entityKey: "pms:NOBODY", reference: "SMS_y", grossMinor: 15000, credits: 214 });
    assert.deepStrictEqual(plan, { applied: false, reason: "no_desk_owner" });
    assert.strictEqual(paystackCalls.length, 0);
  });
  await t("a desk failure never blocks the charge: no split, audit row, reservation released", async () => {
    seedDesk();
    paystackImpl = async () => { throw new Error("Paystack is down"); };
    const plan = await sms.planDeskSmsCharge({ entityKey: ENTITY, reference: "SMS_z", grossMinor: 15000, credits: 214 });
    assert.deepStrictEqual(plan, { applied: false, reason: "desk_resolution_failed" });
    assert.strictEqual(plot.read(`desk_customers/${ENTITY}`).firstPurchaseReservedRef, undefined);
    const rows = auditRows(); assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].action, "desk_sms_resolution_failed"); assert.strictEqual(rows[0].entityKey, ENTITY); assert.match(rows[0].meta.error, /Paystack is down/);
  });
  await t("an unusable settlement (fee above gross) is skipped with an audit row, never thrown", async () => {
    const pending = { deskCommission: { agentId: "ag1", agentCode: "COG-0001", sharePct: 71.03, rule: "sms_first_purchase", entityKey: ENTITY } };
    assert.strictEqual(await sms.recordSmsPurchaseEvent({ reference: "SMS_q", tokens: 5, data: { amount: 100, fees: 500 }, pending }), "skipped");
    assert.strictEqual(eventDocs().length, 0); assert.strictEqual(auditRows()[0].action, "desk_event_skipped");
  });

  console.log("rent");
  const seedLandlord = (extra = {}) => plot.seed("users/L1", { tier: "pro", landlordCode: "PYL-0001", paymentInfo: { accountId: "ACCT_landlord" }, ...extra });
  const rentInput = (extra = {}) => ({ email: "t@samuhia.co.ke", amount: 8000, currency: "KES", phone: "0712345678", provider: "mpesa", metadata: { userId: "T1", userName: "Tess", invoiceId: "inv1", billingMonth: "2026-10", arrears: 0, agentId: "L1" }, ...extra });
  await t("a landlord's own rent charge: tenant pays rent + surcharge, landlord gets exactly rent - deductions via a flat split, persisted on the transaction", async () => {
    seedLandlord({ paymentInfo: { accountId: "ACCT_landlord", split: 2.4 } });   // stale split must be ignored
    const r = await rentCharge.initiateRentCharge(rentInput());
    assert.match(r.reference, /^INV_T1_\d+$/);
    const sp = splitCalls()[0].body; assert.strictEqual(sp.type, "flat"); assert.strictEqual(sp.bearer_type, "account");
    assert.deepStrictEqual(sp.subaccounts, [{ subaccount: "ACCT_landlord", share: 788800 }]);   // pro (0.4%): 8000 - (120 est - 40 tenant) - 32 convenience
    const charge = chargeCalls()[0].body; assert.strictEqual(charge.amount, 804000);   // rent 8000 + tenant surcharge 40 assert.ok(charge.split_code.startsWith("SPL_")); assert.strictEqual(charge.metadata.deskBatchId, undefined);
    const txn = plot.read(`transactions/${r.reference}`);
    assert.strictEqual(txn.amount, 8000);   // the invoice is credited the rent
    assert.deepStrictEqual([txn.rentMinor, txn.tenantFeeMinor, txn.chargeMinor, txn.deductionsMinor, txn.netPayoutMinor], [800000, 4000, 804000, 11200, 788800]);
    assert.strictEqual(txn.tier, "pro"); assert.strictEqual(txn.deskCommission, undefined);
    assert.ok(plot.read("payments/T1/billingMonths/2026-10"));
  });
  await t("tenant surcharge is capped at KES 150 whatever the tier", async () => {
    seedLandlord({ tier: "free" });
    const r = await rentCharge.initiateRentCharge(rentInput({ amount: 20000 }));
    const txn = plot.read(`transactions/${r.reference}`);
    assert.strictEqual(txn.tenantFeeMinor, 10000);   // 0.5% of 20000 = 100, under the cap
    const big = await rentCharge.initiateRentCharge(rentInput({ amount: 50000 }));
    const bt = plot.read(`transactions/${big.reference}`);
    assert.deepStrictEqual([bt.chargeMinor, bt.tenantFeeMinor, bt.deductionsMinor, bt.netPayoutMinor], [5015000, 15000, 107500, 4892500]);
  });
  await t("desk batch charge by the OWNER desk uses the three-way split and records deskCommission; the webhook writes ONE rent event with the real fee", async () => {
    seedLandlord({ tier: "business" }); seedDesk();
    const r = await rentCharge.initiateRentCharge(rentInput({ desk: { agentId: "ag1", batchId: "rb_1" } }));
    assert.deepStrictEqual(splitCalls()[0].body.subaccounts, [{ subaccount: "ACCT_landlord", share: 786800 }, { subaccount: "ACCT_agent1", share: 2080 }]);   // business (0.65% = 52.00): agent gets 40%
    const charge = chargeCalls()[0].body; assert.strictEqual(charge.metadata.deskBatchId, "rb_1"); assert.strictEqual(charge.metadata.deskAgentId, "ag1");
    const txn = plot.read(`transactions/${r.reference}`);
    assert.deepStrictEqual(txn.deskCommission, { agentCode: "COG-0001", agentId: "ag1", sharePct: 0.26, rule: "rent", entityKey: ENTITY });
    const data = { amount: 800000, fees: 12000, paid_at: "2026-10-09T08:00:00Z" };
    assert.strictEqual(await hooks.recordRentPaymentEvent({ reference: r.reference, data, transaction: txn }), "written");
    assert.strictEqual(await hooks.recordRentPaymentEvent({ reference: r.reference, data, transaction: txn }), "duplicate");
    const [e] = eventDocs(); assert.strictEqual(eventDocs().length, 1);
    assert.strictEqual(e.type, "rent_payment"); assert.strictEqual(e.grossMinor, 800000); assert.strictEqual(e.feeMinor, 12000); assert.strictEqual(e.agentSharePct, 0.26); assert.strictEqual(e.eventId, `rent_payment:${r.reference}`);
  });
  await t("a batch from a NON-owner desk uses the normal two-way split and writes no desk commission", async () => {
    seedLandlord({ tier: "business" }); seedDesk(); plot.seed("desk_agents/ag2", { agentId: "ag2", agentCode: "COG-0002", status: "active", rank: "clerk" });
    const r = await rentCharge.initiateRentCharge(rentInput({ desk: { agentId: "ag2", batchId: "rb_2" } }));
    assert.deepStrictEqual(splitCalls()[0].body.subaccounts, [{ subaccount: "ACCT_landlord", share: 786800 }]);
    const txn = plot.read(`transactions/${r.reference}`); assert.strictEqual(txn.deskCommission, undefined); assert.strictEqual(txn.agentMinor, 0);
    assert.strictEqual(await hooks.recordRentPaymentEvent({ reference: r.reference, data: { amount: 800000, fees: 12000 }, transaction: txn }), "skipped");
    assert.strictEqual(eventDocs().length, 0);
  });
  await t("a desk-resolution failure on a batch still charges (two-way) and audits why", async () => {
    seedLandlord(); seedDesk();
    const realGet = plot.collection.bind(plot);
    plot.collection = (p) => { if (p === "desk_customers") throw new Error("desk db unavailable"); return realGet(p); };
    try {
      const r = await rentCharge.initiateRentCharge(rentInput({ desk: { agentId: "ag1", batchId: "rb_3" } }));
      assert.strictEqual(plot.read(`transactions/${r.reference}`).deskCommission, undefined);
    } finally { plot.collection = realGet; }
    assert.ok(auditRows().some((a) => a.action === "desk_rent_resolution_failed"));
  });
  await t("rent charge refuses a missing landlord, missing payout account and a non-positive amount", async () => {
    await assert.rejects(() => rentCharge.initiateRentCharge(rentInput()), (e) => e.code === "not-found");
    plot.seed("users/L1", { tier: "pro" });
    await assert.rejects(() => rentCharge.initiateRentCharge(rentInput()), (e) => e.code === "failed-precondition");
    seedLandlord();
    await assert.rejects(() => rentCharge.initiateRentCharge(rentInput({ amount: 0 })), (e) => e.code === "invalid-argument");
    assert.strictEqual(chargeCalls().length, 0);
  });

  console.log("Plot Yangu subscriptions");
  await t("a subscription carrying deskCommission produces exactly one event (plan, Nairobi period); none without it", async () => {
    const subscription = { deskCommission: { agentCode: "COG-0001", agentId: "ag1", sharePct: 30, rule: "subscription", entityKey: ENTITY } };
    const data = { amount: 99900, fees: 1499, paid_at: "2026-10-31T22:30:00Z" };   // 01:30 on 1 Nov in Nairobi
    assert.strictEqual(await hooks.recordSubscriptionEvent({ reference: "SUB_1", data, subscription, planId: "pro" }), "written");
    assert.strictEqual(await hooks.recordSubscriptionEvent({ reference: "SUB_1", data, subscription, planId: "pro" }), "duplicate");
    const [e] = eventDocs(); assert.strictEqual(eventDocs().length, 1);
    assert.strictEqual(e.type, "subscription_payment"); assert.strictEqual(e.plan, "pro"); assert.strictEqual(e.periodMonth, "2026-11");
    assert.strictEqual(e.grossMinor, 99900); assert.strictEqual(e.feeMinor, 1499); assert.strictEqual(e.agentSharePct, 30);
    assert.strictEqual(await hooks.recordSubscriptionEvent({ reference: "SUB_2", data, subscription: { planId: "pro" } }), "skipped");
    assert.strictEqual(eventDocs().length, 1);
  });

  console.log("MyChama platform charges");
  const CH = "sunrise01";
  const dc = { agentCode: "COG-0001", sharePct: 40, rule: "sms_standard", entityKey: "chama:SMC-0042", agentId: "" };
  const facts = (amount, fees, paidAt = "2026-10-09T09:00:00Z") => ({ amountKobo: amount, feesKobo: fees, paidAt });
  await t("MCS- sms top-up: one sms_purchase event with the real fee, agentId looked up by agent code; a replay adds nothing", async () => {
    plot.seed("desk_agents/ag1", { agentId: "ag1", agentCode: "COG-0001", status: "active", rank: "senior" });
    const ref = `MCS-${CH}-1760000000000-ABC123`;
    chama.seed(`chamas/${CH}`, { smsCredits: 0 });
    chama.seed(`chamas/${CH}/smsTopUps/${ref}`, { amountKes: 500, credits: 500, status: "pending", deskCommission: dc });
    await handlers.handleMyChamaSmsTopup(ref, CH, 50000, "KES", facts(50000, 750));
    await handlers.handleMyChamaSmsTopup(ref, CH, 50000, "KES", facts(50000, 750));   // replay
    assert.strictEqual(chama.read(`chamas/${CH}`).smsCredits, 500);   // credited once (existing behaviour)
    const evs = eventDocs(); assert.strictEqual(evs.length, 1);
    assert.deepStrictEqual(evs[0], { eventId: `sms_purchase:${ref}`, type: "sms_purchase", product: "chama", entityKey: "chama:SMC-0042", agentId: "ag1", paystackRef: ref, grossMinor: 50000, feeMinor: 750, agentSharePct: 40, paidAt: Date.parse("2026-10-09T09:00:00Z"), credits: 500 });
  });
  await t("MCP- plan billing: exactly one subscription_payment (plan, periodMonth in Africa/Nairobi)", async () => {
    plot.seed("desk_agents/ag1", { agentId: "ag1", agentCode: "COG-0001", status: "active", rank: "senior" });
    const ref = `MCP-${CH}-1760000000000-ABC123`;
    chama.seed(`chamas/${CH}`, { plan: "starter" });
    chama.seed(`chamas/${CH}/planBilling/${ref}`, { amountKes: 999, toPlan: "basic", status: "pending", deskCommission: { ...dc, rule: "subscription", sharePct: 30 } });
    await dispatch.dispatchChargeSuccess({ reference: ref, amount: 99900, currency: "KES", status: "success", fees: 1499, paid_at: "2026-10-31T22:30:00Z", metadata: { plan: "basic" } });
    await dispatch.dispatchChargeSuccess({ reference: ref, amount: 99900, currency: "KES", status: "success", fees: 1499, paid_at: "2026-10-31T22:30:00Z", metadata: { plan: "basic" } });
    const evs = eventDocs(); assert.strictEqual(evs.length, 1);
    assert.strictEqual(evs[0].type, "subscription_payment"); assert.strictEqual(evs[0].plan, "basic"); assert.strictEqual(evs[0].periodMonth, "2026-11");
    assert.strictEqual(evs[0].feeMinor, 1499); assert.strictEqual(evs[0].grossMinor, 99900); assert.strictEqual(evs[0].agentSharePct, 30);
    assert.strictEqual(chama.read(`chamas/${CH}`).plan, "basic");
  });
  await t("MCX- / MCR- report purchases map to report_purchase", async () => {
    plot.seed("desk_agents/ag1", { agentId: "ag1", agentCode: "COG-0001", status: "active", rank: "senior" });
    const x = `MCX-${CH}-1760000000001-AAA111`, r = `MCR-${CH}-1760000000002-BBB222`;
    chama.seed(`chamas/${CH}`, { reportCreditsBalance: 0 });
    chama.seed(`chamas/${CH}/reportCreditTopUps/${x}`, { amountKes: 200, credits: 10, status: "pending", deskCommission: { ...dc, rule: "report", sharePct: 30 } });
    chama.seed(`chamas/${CH}/reportAlacartePurchases/${r}`, { amountKes: 100, status: "pending", deskCommission: { ...dc, rule: "report", sharePct: 30 } });
    await dispatch.dispatchChargeSuccess({ reference: x, amount: 20000, currency: "KES", status: "success", fees: 300 });
    await dispatch.dispatchChargeSuccess({ reference: r, amount: 10000, currency: "KES", status: "success", fees: 150 });
    const evs = eventDocs().sort((a, b) => a.paystackRef.localeCompare(b.paystackRef));
    assert.deepStrictEqual(evs.map((e) => e.type), ["report_purchase", "report_purchase"]);
    assert.deepStrictEqual(evs.map((e) => e.feeMinor), [150, 300]);   // MCR- sorts before MCX-
  });
  await t("no event for contributions, loans, MGR, or intents without deskCommission", async () => {
    plot.seed("desk_agents/ag1", { agentId: "ag1", agentCode: "COG-0001", status: "active", rank: "senior" });
    chama.seed(`chamas/${CH}`, { name: "S" });
    chama.seed(`chamas/${CH}/members/m1`, { name: "Ann", status: "active", creditBalance: 0, totalContributed: 0 });
    chama.seed(`chamas/${CH}/contributions/c1`, { memberId: "m1", periodKey: "2026-10", amount: 1000, paidAmount: 0, status: "pending" });
    const cnt = `MCA-${CH}-CNT-1760000000000-AAAAAA`;
    chama.seed(`chamas/${CH}/paymentIntents/${cnt}`, { chamaId: CH, memberId: "m1", purpose: "contribution", reference: cnt, amount: 1000, grossAmount: 1000, currency: "KES", status: "pending", contributionId: "c1", deskCommission: dc });
    await dispatch.dispatchChargeSuccess({ reference: cnt, amount: 100000, currency: "KES", status: "success", fees: 1500 });
    const mgr = `MCA-${CH}-MGR-1760000000000-BBBBBB`;
    chama.seed(`chamas/${CH}/paymentIntents/${mgr}`, { chamaId: CH, memberId: "m1", purpose: "mgr", reference: mgr, amount: 500, grossAmount: 500, currency: "KES", status: "pending", deskCommission: dc });
    await dispatch.dispatchChargeSuccess({ reference: mgr, amount: 50000, currency: "KES", status: "success", fees: 750 });
    const plain = `MCS-${CH}-1760000000009-CCC333`;
    chama.seed(`chamas/${CH}/smsTopUps/${plain}`, { amountKes: 100, status: "pending" });
    await dispatch.dispatchChargeSuccess({ reference: plain, amount: 10000, currency: "KES", status: "success", fees: 150 });
    assert.strictEqual(eventDocs().length, 0);
  });
  await t("a MyChama event with an unusable commission is skipped with an audit row and does not throw", async () => {
    const ref = `MCS-${CH}-1760000000010-DDD444`;
    chama.seed(`chamas/${CH}`, { smsCredits: 0 });
    chama.seed(`chamas/${CH}/smsTopUps/${ref}`, { amountKes: 100, status: "pending", deskCommission: { ...dc, entityKey: "chama:SMC-1" } });
    await handlers.handleMyChamaSmsTopup(ref, CH, 10000, "KES", facts(10000, 20000));   // fee above gross
    assert.strictEqual(eventDocs().length, 0); assert.ok(auditRows().some((a) => a.action === "desk_event_skipped"));
    assert.strictEqual(chama.read(`chamas/${CH}`).smsCredits, 100);
  });

  console.log("refunds");
  await t("refund.processed writes a refund event only when a desk event exists for the refunded reference", async () => {
    seedDesk();
    const pending = { deskCommission: { agentCode: "COG-0001", agentId: "ag1", sharePct: 71.03, rule: "sms_first_purchase", entityKey: ENTITY } };
    await sms.recordSmsPurchaseEvent({ reference: "SMS_r1", tokens: 214, data: settle, pending });
    assert.strictEqual(await hooks.recordRefundEvent({ transaction_reference: "SMS_r1", refund_reference: "RF_1", amount: "150.00" }), "written");
    assert.strictEqual(await hooks.recordRefundEvent({ transaction_reference: "SMS_r1", refund_reference: "RF_1" }), "duplicate");
    const refund = plot.read("desk_events/refund:RF_1");
    assert.strictEqual(refund.type, "refund"); assert.strictEqual(refund.originalRef, "SMS_r1"); assert.strictEqual(refund.paystackRef, "SMS_r1"); assert.strictEqual(refund.agentId, "ag1"); assert.strictEqual(refund.entityKey, ENTITY);
    assert.strictEqual(await hooks.recordRefundEvent({ transaction_reference: "CONTRIBUTION_REF", refund_reference: "RF_2" }), "ignored");
    assert.strictEqual(await hooks.recordRefundEvent({}), "ignored");
    assert.strictEqual(await hooks.recordRefundEvent(undefined), "ignored");
    assert.strictEqual(plot.read("desk_events/refund:RF_2"), undefined);
    // a refund event alone never counts as "a desk event exists for the reference"
    plot.store.delete("desk_events/sms_purchase:SMS_r1");
    assert.strictEqual(await hooks.recordRefundEvent({ transaction_reference: "SMS_r1", refund_reference: "RF_3" }), "ignored");
    // the MyChama webhook route
    plot.seed("desk_events/sms_purchase:MCS-x", { eventId: "sms_purchase:MCS-x", type: "sms_purchase", product: "chama", entityKey: "chama:SMC-0042", agentId: "ag1", paystackRef: "MCS-x", grossMinor: 50000, feeMinor: 750, agentSharePct: 40, paidAt: 1 });
    assert.strictEqual(await dispatch.dispatchRefundProcessed({ transaction_reference: "MCS-x", id: 987 }), "handled");
    assert.ok(plot.read("desk_events/refund:987"));
  });

  console.log("config");
  await t("getDeskConfig reads desk_config/global over the defaults and caches for 60 s", async () => {
    assert.strictEqual((await cfgMod.getDeskConfig()).platformCutPct, 2.5);
    plot.seed("desk_config/global", { platformCutPct: 3 });
    assert.strictEqual((await cfgMod.getDeskConfig()).platformCutPct, 2.5);   // cached
    cfgMod.clearDeskConfigCache();
    const c = await cfgMod.getDeskConfig(); assert.strictEqual(c.platformCutPct, 3); assert.strictEqual(c.rentTakeCapMinor, 25000);
    const t0 = Date.now();
    plot.seed("desk_config/global", { platformCutPct: 4 });
    assert.strictEqual((await cfgMod.loadDeskConfig(async () => ({ platformCutPct: 9 }), t0 + 30_000)).platformCutPct, 3);
    assert.strictEqual((await cfgMod.loadDeskConfig(async () => ({ platformCutPct: 9 }), t0 + 61_000)).platformCutPct, 9);
  });

  console.log("event validation");
  await t("writeDeskEvent is create-only and refuses malformed events", async () => {
    const base = { eventId: "rent_payment:R1", type: "rent_payment", product: "pms", entityKey: ENTITY, agentId: "ag1", paystackRef: "R1", grossMinor: 1000, feeMinor: 15, agentSharePct: 0.4, paidAt: 5 };
    assert.strictEqual(await events.writeDeskEvent(base), true);
    assert.strictEqual(await events.writeDeskEvent({ ...base, grossMinor: 9999 }), false);
    assert.strictEqual(plot.read("desk_events/rent_payment:R1").grossMinor, 1000);   // first write wins
    for (const bad of [{ ...base, eventId: "x/y" }, { ...base, feeMinor: 2000 }, { ...base, agentSharePct: 100 }, { ...base, grossMinor: 10.5 }, { ...base, type: "x" }, { ...base, type: "refund" }, { ...base, periodMonth: "2026-13" }, { ...base, paidAt: 0 }]) {
      await assert.rejects(() => events.writeDeskEvent(bad), /Invalid desk event/);
    }
    assert.strictEqual(events.monthKeyEAT(Date.parse("2026-12-31T21:00:00Z")), "2027-01");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
