/* Desk rent batch executor against the in-memory Firestore (Paystack charge injected).
 * Run:  cd functions && npm run build && node test/desk-rentbatch.check.js   (exit 1 on failure) */
process.env.PAYSTACK_SECRET_KEY = "sk_test_unit";
const assert = require("assert");
const path = require("path");
const { FakeDb } = require("./desk-fake-firestore");
const lib = (p) => require(path.join(__dirname, "..", "lib", p));
const deskdb = lib("desk/db");
const { runRentBatch, pickInvoice, landlordCodeOf } = lib("desk/rentBatch");

const db = new FakeDb();
deskdb.deskDb = () => db;
let charges = [];
let chargeImpl;
const deps = { db: () => db, now: () => 1000, charge: async (i) => { charges.push(i); return chargeImpl(i); } };
const ok = async (i) => ({ reference: `INV_${i.metadata.userId}_1`, status: "pay_offline", displayText: "x" });

function seed(over = {}) {
  db.reset(); charges = []; chargeImpl = ok;
  db.seed("users/L1", { landlordCode: "PYL-0001", supportAgents: { "COG-0001": { name: "Desk" } }, ...(over.landlord || {}) });
  db.seed("desk_agents/A1", { status: "active", agentCode: "COG-0001", ...(over.agent || {}) });
  db.seed("users/L1/properties/1", { isRestricted: false });
  db.seed("users/L1/tenants/11", { name: "Ann", phone: "0711000001", propertyId: 1, isActive: true });
  db.seed("users/L1/tenants/22", { name: "Bob", phone: "0711000002", propertyId: 1, isActive: true });
  db.seed("users/L1/tenants/33", { name: "Cy", phone: "", propertyId: 1, isActive: true });
  db.seed("users/L1/invoices/i1", { tenantId: 11, billingMonth: "2026-09", dueDate: "2026-09-05", totalAmount: 5000, amountPaid: 1000 });
  db.seed("users/L1/invoices/i2", { tenantId: 11, billingMonth: "2026-10", dueDate: "2026-10-05", totalAmount: 5000, amountPaid: 0 });
  db.seed("users/L1/invoices/i3", { tenantId: 22, billingMonth: "2026-10", dueDate: "2026-10-05", totalAmount: 3000, amountPaid: 3000 });
  db.seed("users/L1/invoices/i4", { tenantId: 33, billingMonth: "2026-10", dueDate: "2026-10-05", totalAmount: 100, amountPaid: 0 });
  db.seed("desk_rent_batches/rb1", { batchId: "rb1", agentId: "A1", entityKey: "pms:PYL-0001", tenantIds: ["11", "22", "33", "99"], status: "requested", results: [], count: 4 });
}
let passed = 0, failed = 0;
async function t(name, fn) { try { seed(); await fn(); passed++; console.log("  ✓", name); } catch (e) { failed++; console.error("  ✗", name, "\n", e); } }
const batch = () => db.read("desk_rent_batches/rb1");
const byTenant = () => Object.fromEntries(batch().results.map((r) => [r.tenantId, r]));

(async () => {
  await t("pure helpers", async () => {
    assert.equal(landlordCodeOf("pms:PYL-0007"), "PYL-0007");
    assert.equal(landlordCodeOf("chama:SMC-0001"), null);
    assert.equal(pickInvoice([{ id: "b", data: { totalAmount: 10, amountPaid: 0, dueDate: "2026-02-01" } }, { id: "a", data: { totalAmount: 10, amountPaid: 0, dueDate: "2026-01-01" } }]).id, "a");
    assert.equal(pickInvoice([{ id: "a", data: { totalAmount: 10, amountPaid: 10 } }]), null);
  });
  await t("charges the oldest unpaid invoice's balance, once per tenant, and records results in order", async () => {
    await runRentBatch("rb1", deps);
    assert.equal(charges.length, 1, "only Ann is chargeable");
    assert.equal(charges[0].amount, 4000);
    assert.equal(charges[0].metadata.invoiceId, "i1");
    assert.equal(charges[0].metadata.agentId, "L1");
    assert.deepEqual(charges[0].desk, { agentId: "A1", batchId: "rb1" });
    assert.equal(batch().status, "done");
    assert.deepEqual(batch().results.map((r) => r.tenantId), ["11", "22", "33", "99"]);
    const r = byTenant();
    assert.equal(r["11"].status, "sent"); assert.ok(r["11"].reference);
    assert.match(r["22"].error, /Nothing is due/); assert.match(r["33"].error, /No phone/); assert.match(r["99"].error, /not found/);
  });
  await t("running the same batch again sends nothing (status is no longer requested)", async () => {
    await runRentBatch("rb1", deps); await runRentBatch("rb1", deps);
    assert.equal(charges.length, 1);
  });
  await t("a tenant already attempted is never prompted twice even if the batch is reset", async () => {
    await runRentBatch("rb1", deps);
    db.seed("desk_rent_batches/rb1", { ...batch(), status: "requested", results: [] });
    await runRentBatch("rb1", deps);
    assert.equal(charges.length, 1);
    assert.equal(byTenant()["11"].status, "sent");
  });
  await t("a charge that throws becomes a failed row and the batch continues", async () => {
    chargeImpl = async () => { throw new Error("Agent has not set up payment account. Please configure payment details first."); };
    await runRentBatch("rb1", deps);
    assert.equal(batch().status, "failed");
    assert.match(byTenant()["11"].error, /payment account/);
  });
  await t("a desk that is not the landlord's support agent is refused with no charge", async () => {
    seed({ landlord: { supportAgents: {} } });
    await runRentBatch("rb1", deps);
    assert.equal(charges.length, 0); assert.equal(batch().status, "failed");
    assert.match(batch().results[0].error, /support agents/);
  });
  await t("COG-0000 (top desk) is authorised without being listed", async () => {
    seed({ landlord: { supportAgents: {} }, agent: { agentCode: "COG-0000" } });
    await runRentBatch("rb1", deps);
    assert.equal(charges.length, 1);
  });
  await t("a suspended desk, a non-PMS entity and an unknown landlord are refused", async () => {
    seed({ agent: { status: "suspended" } }); await runRentBatch("rb1", deps); assert.equal(charges.length, 0); assert.match(batch().results[0].error, /not active/);
    seed(); db.seed("desk_rent_batches/rb1", { ...batch(), entityKey: "chama:SMC-0001" }); await runRentBatch("rb1", deps); assert.match(batch().results[0].error, /Plot Yangu/);
    seed(); db.seed("desk_rent_batches/rb1", { ...batch(), entityKey: "pms:PYL-9999" }); await runRentBatch("rb1", deps); assert.match(batch().results[0].error, /No Plot Yangu landlord/);
    assert.equal(charges.length, 0);
  });
  await t("restricted tenants and properties are skipped", async () => {
    db.seed("users/L1/tenants/11", { name: "Ann", phone: "0711000001", propertyId: 1, isActive: true, isRestricted: true });
    await runRentBatch("rb1", deps);
    assert.equal(charges.length, 0); assert.match(byTenant()["11"].error, /restricted/);
  });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
