/* Compliance reports end to end on an in-memory Firestore: pricing, the checkout gate, Paystack settlement, generation, desk orders,
 * the single scheduler. Run:  cd functions && npm run build && node test/compliance-service.check.js   (exit 1 on failure) */
const assert = require("assert");
const path = require("path");
process.env.MYCHAMA_ID_PEPPER = "test-pepper";
const { FakeDb } = require("./compliance-fake-firestore");
const lib = (p) => require(path.join(__dirname, "..", "lib", "compliance", p));
const svc = lib("service"), { settleReportPayment, failReportPayment } = lib("payments"), { CrError } = lib("errors");
const { runScheduler, rentSettled, dueForAuto } = lib("scheduler"), { resolveLandlordId } = lib("api");

let passed = 0, failed = 0, clock, charges, pdfCalls, pdfFails, verifyResult;
const ok = async (name, fn) => { try { await fn(); passed++; console.log("  ✓", name); } catch (e) { failed++; console.error("  ✗", name, "\n", e); } };
const rejects = async (fn, code) => { try { await fn(); } catch (e) { assert.ok(e instanceof CrError, "not a CrError: " + e); assert.strictEqual(e.code, code); return; } assert.fail("expected " + code); };

function seed(db, tier = "business") {
  db.store.set("users/7", { name: "Wanjiru", tier, firebaseAuthUid: "authL", company: "Wanjiru Rentals" });
  db.store.set("users/7/properties/3", { name: "Sunrise Apartments", address: "Naivasha", agentCommissionRate: 10 });
  const tn = (id, name, rent) => db.store.set(`users/7/tenants/${id}`, { localId: id, propertyId: 3, name, unitNumber: "U" + id, rentAmount: rent, isActive: true });
  tn(1, "Amina", 14000); tn(2, "Daniel", 18000);
  const inv = (id, tid, rent, total, paid) => db.store.set(`users/7/invoices/${id}`, { localId: id, propertyId: 3, tenantId: tid, billingMonth: "2026-10", rentAmount: rent, totalAmount: total, amountPaid: paid });
  inv(1, 1, 14000, 15000, 15000); inv(2, 2, 18000, 20000, 20000);
  db.store.set("users/7/invoices/1/payments/1", { amount: 15000, paymentDate: "2026-10-04" });
  db.store.set("users/7/invoices/2/payments/1", { amount: 20000, paymentDate: "2026-10-06" });
}
const input = () => ({
  property: { id: "3", name: "Sunrise Apartments", commissionRatePct: 10, managed: true, residential: true }, landlord: { name: "Wanjiru" },
  tenants: [{ id: "1", unit: "U1", name: "Amina", rent: 14000, active: true }, { id: "2", unit: "U2", name: "Daniel", rent: 18000, active: true }],
  invoices: [{ id: "1", tenantId: "1", month: "2026-10", rent: 14000, total: 15000, payments: [{ date: "2026-10-04", amount: 15000 }] },
             { id: "2", tenantId: "2", month: "2026-10", rent: 18000, total: 20000, payments: [{ date: "2026-10-06", amount: 20000 }] }],
  statementItems: [{ month: "2026-10", description: "Plumbing", amount: 1200 }],
});
const mk = (tier) => {
  const db = new FakeDb(); seed(db, tier); charges = []; pdfCalls = 0; pdfFails = false; verifyResult = null; clock = Date.parse("2026-11-03T08:00:00Z");
  const deps = {
    db, now: () => new Date(clock),
    pdf: async () => { pdfCalls++; if (pdfFails) throw new Error("chromium crashed"); return Buffer.from("%PDF-fake"); },
    storage: { save: async () => undefined, signedUrl: async (p, ttl) => `https://signed.example/${p}?ttl=${ttl}` },
    paystack: { charge: async (p) => { charges.push(p); return { status: "pay_offline", displayText: "Enter your M-Pesa PIN" }; }, verify: async () => verifyResult },
    checkPhone: (raw) => (/^07\d{8}$/.test(String(raw)) ? { ok: true, e164: "+254" + String(raw).slice(1) } : { ok: false, message: "Enter a valid Safaricom number." }),
  };
  return { db, deps };
};
const PMS = { channel: "pms", actorKey: "u_authL", landlordUid: "7" };
const order = (deps, pr = PMS, extra = {}) => svc.createOrder(deps, pr, { propertyId: "3", month: "2026-10", kind: "mri_monthly", input: input(), ...extra });

(async () => {
  await ok("Business: the first report of a property in a month is free, but only after checkout", async () => {
    const { deps } = mk("business");
    const o = await order(deps);
    assert.strictEqual(o.priceKes, 0); assert.strictEqual(o.state, "payment_required"); assert.strictEqual(o.entitled, false);
    let s = await svc.status(deps, PMS, { orderId: o.orderId });
    assert.strictEqual(s.state, "payment_required"); assert.strictEqual(s.url, undefined); assert.strictEqual(pdfCalls, 0);          // nothing made before checkout
    const c = await svc.checkout(deps, PMS, { orderId: o.orderId });
    assert.strictEqual(c.state, "paid"); assert.strictEqual(c.priceKes, 0); assert.strictEqual(charges.length, 0);
    s = await svc.status(deps, PMS, { orderId: o.orderId });
    assert.strictEqual(s.state, "ready"); assert.ok(/^https:\/\/signed\.example\/compliance\/7\/3\/2026-10\//.test(s.url)); assert.strictEqual(pdfCalls, 1);
  });
  await ok("the second report for the same property and month costs KES 200; a different property gets its own free one", async () => {
    const { db, deps } = mk("business");
    const a = await order(deps); await svc.checkout(deps, PMS, { orderId: a.orderId });
    const b = await order(deps);
    assert.strictEqual(b.priceKes, 200);                                                  // the month's allowance is already used
    const bc = await svc.checkout(deps, PMS, { orderId: b.orderId, phone: "0712345678" });
    assert.strictEqual(bc.state, "payment_pending"); assert.strictEqual(bc.priceKes, 200);
    assert.strictEqual(charges.length, 1); assert.strictEqual(charges[0].amount, 20000); assert.ok(/^CRP_[a-f0-9]{16}_/.test(charges[0].reference));
    assert.strictEqual(charges[0].metadata.chargeType, "compliance_report");
    db.store.set("users/7/properties/4", { name: "Second", agentCommissionRate: 0 });
    const q = await svc.quote(deps, PMS, { propertyId: "4" }); assert.strictEqual(q.priceKes, 0);
  });
  await ok("Free, Starter, Solo pay KES 200 every time, with an M-Pesa prompt, and get nothing until it settles", async () => {
    for (const tier of ["free", "starter", "solo"]) {
      const { db, deps } = mk(tier);
      const o = await order(deps); assert.strictEqual(o.priceKes, 200);
      await rejects(() => svc.checkout(deps, PMS, { orderId: o.orderId }), "CR_BAD_REQUEST");                    // no phone
      const c = await svc.checkout(deps, PMS, { orderId: o.orderId, phone: "0712345678" });
      assert.strictEqual(c.state, "payment_pending");
      let s = await svc.status(deps, PMS, { orderId: o.orderId });
      assert.strictEqual(s.state, "payment_pending"); assert.strictEqual(s.url, undefined); assert.strictEqual(pdfCalls, 0);
      const ref = charges[0].reference;
      await settleReportPayment(db, ref, { amount: 20000, fees: 300 }, { orderId: o.orderId });
      s = await svc.status(deps, PMS, { orderId: o.orderId });
      assert.strictEqual(s.state, "ready"); assert.ok(s.url); assert.strictEqual(pdfCalls, 1);
      assert.strictEqual(db.store.get(`platform_revenue/${ref}`).type, "compliance_report");
    }
  });
  await ok("webhook settlement is idempotent, ignores stale references and refuses a wrong amount", async () => {
    const { db, deps } = mk("starter");
    const o = await order(deps);
    await svc.checkout(deps, PMS, { orderId: o.orderId, phone: "0712345678" });
    const first = charges[0].reference;
    clock += 120_000;
    await svc.checkout(deps, PMS, { orderId: o.orderId, phone: "0712345678" });                                  // a retry makes a new reference
    const second = charges[1].reference; assert.notStrictEqual(first, second);
    await settleReportPayment(db, first, { amount: 20000 }, { orderId: o.orderId });                                // late payment of the OLD prompt is ignored
    assert.strictEqual(db.store.get(`complianceReports/${o.orderId}`).entitled, false);
    await settleReportPayment(db, second, { amount: 9900 }, { orderId: o.orderId });                                // wrong amount
    assert.strictEqual(db.store.get(`complianceReports/${o.orderId}`).state, "failed"); assert.strictEqual(db.store.get(`complianceReports/${o.orderId}`).entitled, false);
    await rejects(() => svc.generateOrder(deps, o.orderId), "CR_NOT_ALLOWED");
  });
  await ok("verify fallback: if the webhook is late, status asks Paystack and settles; a failed payment goes back to payment_required", async () => {
    const { deps } = mk("solo");
    const o = await order(deps); await svc.checkout(deps, PMS, { orderId: o.orderId, phone: "0712345678" });
    verifyResult = { status: "pending", data: {} }; assert.strictEqual((await svc.status(deps, PMS, { orderId: o.orderId })).state, "payment_pending");
    verifyResult = { status: "failed", data: {} }; assert.strictEqual((await svc.status(deps, PMS, { orderId: o.orderId })).state, "payment_required");
    clock += 120_000; await svc.checkout(deps, PMS, { orderId: o.orderId, phone: "0712345678" });
    verifyResult = { status: "success", data: { amount: 20000, fees: 300 } };
    const s = await svc.status(deps, PMS, { orderId: o.orderId }); assert.strictEqual(s.state, "ready"); assert.ok(s.url);
  });
  await ok("charge.failed releases the order for another try", async () => {
    const { db, deps } = mk("solo");
    const o = await order(deps); await svc.checkout(deps, PMS, { orderId: o.orderId, phone: "0712345678" });
    await failReportPayment(db, charges[0].reference, "Request cancelled by user");
    assert.strictEqual(db.store.get(`complianceReports/${o.orderId}`).state, "payment_required");
  });
  await ok("nobody else can read or pay for your order", async () => {
    const { deps } = mk("business");
    const o = await order(deps);
    for (const other of [{ ...PMS, actorKey: "u_someoneElse" }, { ...PMS, landlordUid: "8" }]) {
      await rejects(() => svc.status(deps, other, { orderId: o.orderId }), "CR_NOT_FOUND");
      await rejects(() => svc.checkout(deps, other, { orderId: o.orderId }), "CR_NOT_FOUND");
    }
    await rejects(() => svc.status(deps, PMS, { orderId: "not-an-id" }), "CR_BAD_REQUEST");
  });
  await ok("a failed PDF does not lose the payment or the free allowance: retry makes it, without a second charge", async () => {
    const { db, deps } = mk("business");
    const o = await order(deps); await svc.checkout(deps, PMS, { orderId: o.orderId });
    pdfFails = true; await rejects(() => svc.status(deps, PMS, { orderId: o.orderId }), "CR_UNAVAILABLE");
    const d = db.store.get(`complianceReports/${o.orderId}`);
    assert.strictEqual(d.state, "paid"); assert.strictEqual(d.entitled, true); assert.strictEqual(db.store.get("complianceQuota/7_3_2026-11").used, 1);
    pdfFails = false; const s = await svc.status(deps, PMS, { orderId: o.orderId }); assert.strictEqual(s.state, "ready"); assert.ok(s.url);
    assert.strictEqual(charges.length, 0);
  });
  await ok("ready reports can be fetched again for 7 days, then expire", async () => {
    const { deps } = mk("business");
    const o = await order(deps); await svc.checkout(deps, PMS, { orderId: o.orderId }); await svc.status(deps, PMS, { orderId: o.orderId });
    clock += 6 * 86_400_000; const again = await svc.status(deps, PMS, { orderId: o.orderId }); assert.ok(again.url); assert.strictEqual(pdfCalls, 1);
    clock += 2 * 86_400_000; const late = await svc.status(deps, PMS, { orderId: o.orderId }); assert.strictEqual(late.state, "expired"); assert.strictEqual(late.url, undefined);
  });
  await ok("the app's records are checked: wrong property, no data, huge uploads, bad month", async () => {
    const { deps } = mk("business");
    await rejects(() => order(deps, PMS, { propertyId: "99" }), "CR_BAD_REQUEST");
    await rejects(() => order(deps, PMS, { input: { ...input(), tenants: [], invoices: [] } }), "CR_NO_DATA");
    await rejects(() => order(deps, PMS, { month: "2027-01" }), "CR_BAD_REQUEST");
    await rejects(() => order(deps, PMS, { month: "10/2026" }), "CR_BAD_REQUEST");
    await rejects(() => order(deps, PMS, { kind: "everything" }), "CR_BAD_REQUEST");
    const big = input(); big.invoices = Array.from({ length: 4000 }, (_, i) => ({ id: "x" + i, tenantId: "1", month: "2026-10", rent: 1, total: 1, payments: Array.from({ length: 30 }, () => ({ date: "2026-10-01", amount: 1 })) }));
    await rejects(() => order(deps, PMS, { input: big }), "CR_TOO_LARGE");
    const forged = await order(deps, PMS, { input: { ...input(), price: 0, priceMinor: 0, entitled: true, tier: "enterprise" } });
    assert.strictEqual(forged.entitled, false);
  });
  await ok("Landlord Watch: records come from the landlord's synced account, checked before anyone pays", async () => {
    const { deps, db } = mk("business");
    const W = { channel: "watch", actorKey: "u_owner", landlordUid: "7", ownerId: "PYP-0001" };
    const o = await svc.createOrder(deps, W, { propertyId: "3", month: "2026-10", kind: "annual_summary" });
    assert.strictEqual(o.priceKes, 0);
    await svc.checkout(deps, W, { orderId: o.orderId });
    const s = await svc.status(deps, W, { orderId: o.orderId }); assert.strictEqual(s.state, "ready");
    db.store.set("users/9", { name: "Local only", tier: "business" }); db.store.set("users/9/properties/1", { name: "P" });
    await rejects(() => svc.createOrder(deps, { ...W, landlordUid: "9" }, { propertyId: "1", month: "2026-10", kind: "mri_monthly" }), "CR_NO_DATA");
  });
  await ok("Desk: always KES 200, even for Enterprise; one report per paid ticket; the link lasts", async () => {
    const { deps, db } = mk("enterprise");
    const ttl = 7 * 86_400_000 - 60_000;
    const a = await svc.createPaidDeskOrder(deps, { uid: "7", propertyId: "3", month: "2026-10", kind: "mri_monthly", ticketId: "T1", agentId: "A9" }, ttl);
    assert.strictEqual(a.priceKes, 200); assert.strictEqual(a.state, "ready"); assert.ok(a.url.includes(`ttl=${ttl}`)); assert.strictEqual(a.channel, "desk");
    const again = await svc.createPaidDeskOrder(deps, { uid: "7", propertyId: "3", month: "2026-10", kind: "mri_monthly", ticketId: "T1", agentId: "A9" }, ttl);
    assert.strictEqual(again.orderId, a.orderId); assert.strictEqual(pdfCalls, 1);
    const b = await svc.createPaidDeskOrder(deps, { uid: "7", propertyId: "3", month: "2026-10", kind: "mri_monthly", ticketId: "T2", agentId: "A9" }, ttl);
    assert.notStrictEqual(b.orderId, a.orderId);
    assert.strictEqual(db.store.has("complianceQuota/7_3_2026-11"), false);                                         // desk never touches the free allowance
    await rejects(() => svc.createPaidDeskOrder(deps, { uid: "7", propertyId: "3", month: "2026-10", kind: "x", ticketId: "T3", agentId: "A9" }, ttl), "CR_BAD_REQUEST");
    const prev = await svc.deskPreview(deps, { uid: "7" }); assert.deepStrictEqual(prev.properties, [{ id: "3", name: "Sunrise Apartments" }]);
    const full = await svc.deskPreview(deps, { uid: "7", propertyId: "3", month: "2026-10", kind: "mri_monthly" }); assert.strictEqual(full.ready, true); assert.strictEqual(full.tenants, 2);
  });
  await ok("landlord identity: custom claim, users.firebaseAuthUid or the uid itself", async () => {
    const { db } = mk("business");
    assert.strictEqual(await resolveLandlordId(db, { uid: "authL", token: {} }), "7");
    assert.strictEqual(await resolveLandlordId(db, { uid: "x", token: { role: "landlord", agentId: "7" } }), "7");
    db.store.set("users/zz", { name: "N" }); assert.strictEqual(await resolveLandlordId(db, { uid: "zz", token: {} }), "zz");
    try { await resolveLandlordId(db, { uid: "nobody", token: {} }); assert.fail("should reject"); } catch (e) { assert.strictEqual(e.code, "CR_NOT_ALLOWED"); }
  });

  // ---------------------------------------------------------------- the single scheduler
  const renderer = () => ({ render: async () => { pdfCalls++; return Buffer.from("%PDF-fake"); }, close: async () => undefined });
  await ok("scheduler rules: settled rent triggers at once; otherwise the 15th; never after the 20th", () => {
    assert.strictEqual(rentSettled([{ rentAmount: 100, amountPaid: 100 }, { rentAmount: 50, amountPaid: 80 }], 2), true);
    assert.strictEqual(rentSettled([{ rentAmount: 100, amountPaid: 100 }], 2), false);       // a tenant with no invoice
    assert.strictEqual(rentSettled([], 0), false); assert.strictEqual(rentSettled([{ rentAmount: 100, amountPaid: 99 }], 1), false);
    assert.deepStrictEqual([dueForAuto(3, true), dueForAuto(3, false), dueForAuto(15, false), dueForAuto(20, false), dueForAuto(21, true)], [true, false, true, true, false]);
  });
  await ok("scheduler: one run seeds Business+ landlords only, makes the free report for a settled property, and skips used allowances", async () => {
    const { db, deps } = mk("business");
    db.store.set("users/8", { name: "Starter L", tier: "starter" }); db.store.set("users/8/properties/1", { name: "S" });
    const r = await runScheduler(deps, renderer);
    assert.strictEqual(r.target, "2026-10"); assert.strictEqual(r.seeded, 1); assert.strictEqual(r.generated, 1);
    assert.strictEqual(db.store.has("complianceAuto/2026-10_8"), false);                      // not eligible: never seeded
    const reports = [...db.store].filter(([k]) => /^complianceReports\//.test(k)).map(([, v]) => v);
    assert.strictEqual(reports.length, 1); assert.strictEqual(reports[0].channel, "auto"); assert.strictEqual(reports[0].state, "ready"); assert.strictEqual(reports[0].priceMinor, 0);
    assert.strictEqual(db.store.get("complianceQuota/7_3_2026-11").used, 1); assert.strictEqual(db.store.get("complianceAuto/2026-10_7").state, "done");
    const again = await runScheduler(deps, renderer); assert.strictEqual(again.generated, 0); assert.strictEqual(again.landlords, 0);   // nothing waiting: no rescans
  });
  await ok("scheduler: unpaid rent waits until the 15th, then the report is made anyway; an already-used allowance is respected", async () => {
    const { db, deps } = mk("business");
    db.store.set("users/7/invoices/2", { ...db.store.get("users/7/invoices/2"), amountPaid: 0 });
    let r = await runScheduler(deps, renderer); assert.strictEqual(r.generated, 0); assert.strictEqual(db.store.get("complianceAuto/2026-10_7").state, "pending");
    clock = Date.parse("2026-11-14T08:00:00Z"); r = await runScheduler(deps, renderer); assert.strictEqual(r.generated, 0);
    clock = Date.parse("2026-11-15T08:00:00Z"); r = await runScheduler(deps, renderer); assert.strictEqual(r.generated, 1);
    const b = mk("business"); b.db.store.set("complianceQuota/7_3_2026-11", { used: 1 });                       // the landlord already used this month's free report
    const r2 = await runScheduler(b.deps, renderer); assert.strictEqual(r2.generated, 0); assert.strictEqual(b.db.store.get("complianceAuto/2026-10_7").props["3"], "skipped_allowance_used");
  });
  await ok("scheduler: after the 20th it only finishes paid-but-unmade reports", async () => {
    const { db, deps } = mk("business");
    clock = Date.parse("2026-11-21T08:00:00Z");
    const r = await runScheduler(deps, renderer); assert.strictEqual(r.generated, 0); assert.strictEqual(r.seeded, 0);
    db.store.set("complianceReports/aaaaaaaaaaaaaaaa", { id: "aaaaaaaaaaaaaaaa", channel: "pms", actorKey: "u_authL", uid: "7", propertyId: "3", month: "2026-10", kind: "mri_monthly", state: "paid", entitled: true, paidAt: clock - 600_000, priceMinor: 20000, period: "2026-11", createdAt: clock - 900_000, input: { ...input(), schema: 1, kind: "mri_monthly", month: "2026-10" } });
    const r3 = await runScheduler(deps, renderer); assert.strictEqual(r3.swept, 1); assert.strictEqual(db.store.get("complianceReports/aaaaaaaaaaaaaaaa").state, "ready");
    db.store.set("complianceReports/bbbbbbbbbbbbbbbb", { id: "bbbbbbbbbbbbbbbb", channel: "pms", actorKey: "u_authL", uid: "7", propertyId: "3", month: "2026-10", kind: "mri_monthly", state: "payment_required", entitled: false, priceMinor: 20000, createdAt: clock });
    const r4 = await runScheduler(deps, renderer); assert.strictEqual(db.store.get("complianceReports/bbbbbbbbbbbbbbbb").state, "payment_required");   // never makes an unpaid report
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
