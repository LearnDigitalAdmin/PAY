/* Landlord Watch calculation + masking vectors (contract v1.1 section 5 worked example).
 * Run:  cd functions && npm run build && node test/landlord-watch-calc.check.js   (exit 1 on failure) */
const assert = require("assert");
const path = require("path");
const lib = (p) => require(path.join(__dirname, "..", "lib", "landlordWatch", p));
const { buildOpenSnapshot } = lib("calc");
const { maskSnapshot, etagOf } = lib("mask");
const F = lib("format");
let passed = 0, failed = 0;
const ok = (name, fn) => { try { fn(); passed++; console.log("  ✓", name); } catch (e) { failed++; console.error("  ✗", name, "\n", e); } };

const property = { name: "Sunrise Apartments", address: "Naivasha, Nakuru", maxUnits: 6, commissionRatePct: 10, managedByAgency: true };
const tenants = [
  { id: "A", name: "Amina Wanjiru", phone: "+254711333444", unit: "A1", rentAmount: 14000, isActive: true },
  { id: "B", name: "Brian Mwangi", phone: "+254722000111", unit: "B2", rentAmount: 11500, isActive: true },
  { id: "C", name: "Carol Njeri", phone: "+254733000222", unit: "C3", rentAmount: 8500, isActive: true },
  { id: "D", name: "Daniel Otieno", phone: "+254722111222", unit: "D4", rentAmount: 18000, isActive: true },
  { id: "E", name: "Esther Achieng", phone: "+254799000333", unit: "E5", rentAmount: 10000, isActive: true },
];
const inv = (id, tenantId, rent, total, paid, due, paidDate) => ({ id, tenantId, billingMonth: "2026-10", rentAmount: rent, totalAmount: total, amountPaid: paid, dueDate: due, paidDate });
const invoices = [
  inv("iA", "A", 14000, 15000, 15000, "2026-10-05", "2026-10-04"),
  inv("iB", "B", 11500, 12500, 5000, "2026-10-05", null),
  inv("iC", "C", 8500, 9000, 9000, "2026-10-05", "2026-10-17"),
  inv("iD", "D", 18000, 20000, 0, "2026-10-05", null),
];
const payments = [
  { invoiceId: "iA", amount: 15000, date: "2026-10-04" },
  { invoiceId: "iB", amount: 5000, date: "2026-10-08" },
  { invoiceId: "iC", amount: 9000, date: "2026-10-17" },
];
const base = { ownerId: "PYP-0001", month: "2026-10", lang: "en", property, tenants, invoices, payments, transcripts: {}, tenantRef: (id) => `t_${id}`, now: new Date("2026-10-23T08:00:00Z") };

const snap = buildOpenSnapshot(base);
const s = snap.summary;
ok("billed / collected / pending / rate", () => {
  assert.strictEqual(s.billed.v, 56500); assert.strictEqual(s.collected.v, 29000); assert.strictEqual(s.pending.v, 27500);
  assert.strictEqual(s.collectionRatePct.v, 51.3); assert.strictEqual(s.collectionRatePct.d, "51%");
  assert.strictEqual(s.billed.d, "KES 56,500");
});
ok("invoice counts", () => {
  assert.deepStrictEqual([s.invoices.total.v, s.invoices.paid.v, s.invoices.partial.v, s.invoices.unpaid.v, s.invoices.noInvoice.v], [4, 2, 1, 1, 1]);
});
ok("commission is on BASE RENT only", () => {
  assert.strictEqual(s.baseRent.billed.v, 52000); assert.strictEqual(s.baseRent.collected.v, 34000);
  assert.strictEqual(s.commission.onCollected.v, 3400); assert.strictEqual(s.commission.onExpected.v, 5200);
});
ok("net expected / payable / still to collect", () => {
  assert.strictEqual(s.net.expected.v, 51300); assert.strictEqual(s.net.payable.v, 25600); assert.strictEqual(s.net.stillToCollect.v, 25700);
});
ok("estimate statement when the agent has no transcript", () => {
  assert.strictEqual(s.statement.source, "estimate");
  assert.strictEqual(s.statement.income.v, 29000); assert.strictEqual(s.statement.deductions.v, 3400); assert.strictEqual(s.statement.netPayable.v, 25600);
  assert.strictEqual(s.statement.items[1].label, "Agent commission (10% of base rent)");
});
ok("occupancy is in UNITS", () => {
  assert.strictEqual(s.tenants.occupiedUnits.v, 5); assert.strictEqual(s.tenants.vacantUnits.v, 1);
  assert.strictEqual(s.tenants.occupancyPct.v, 83.3); assert.strictEqual(s.tenants.occupancyPct.d, "83%");
});
ok("remittance is by the 15th", () => {
  const r = s.remittance;
  assert.strictEqual(r.dueDate, "2026-10-15");
  assert.strictEqual(r.collectedByDue.v, 20000); assert.strictEqual(r.collectedAfterDue.v, 9000);
  assert.strictEqual(r.netByDue.v, 17450); assert.strictEqual(r.netAfterDue.v, 8150);
  assert.strictEqual(r.netByDue.v + r.netAfterDue.v, s.net.payable.v);
});
ok("tenant rows: unpaid first, statuses, late flag", () => {
  assert.deepStrictEqual(snap.tenants.map((t) => t.status), ["unpaid", "partial", "paid", "paid", "no_invoice"]);
  const c = snap.tenants.find((t) => t.ref === "t_C"); assert.strictEqual(c.paidOn, "2026-10-17"); assert.strictEqual(c.paidOnTime, false);
  const a = snap.tenants.find((t) => t.ref === "t_A"); assert.strictEqual(a.paidOnTime, true);
  assert.strictEqual(snap.tenants.find((t) => t.ref === "t_D").balance.v, 20000);
});
ok("trend has 6 months ending at the requested month", () => {
  assert.strictEqual(snap.trend.length, 6); assert.strictEqual(snap.trend[5].month, "2026-10"); assert.strictEqual(snap.trend[0].month, "2026-05");
  assert.strictEqual(snap.trend[5].netPayable.v, 25600);
});
ok("rate 0 means no commission (never 100%)", () => {
  const z = buildOpenSnapshot({ ...base, property: { ...property, commissionRatePct: 0 } });
  assert.strictEqual(z.summary.commission.onCollected.v, 0); assert.strictEqual(z.summary.net.payable.v, 29000);
});
ok("a new tenant with no invoice is NOT unpaid", () => {
  const n = buildOpenSnapshot({ ...base, invoices: [], payments: [], tenants: [tenants[4]] });
  assert.strictEqual(n.summary.invoices.unpaid.v, 0); assert.strictEqual(n.summary.pending.v, 0); assert.strictEqual(n.tenants[0].status, "no_invoice");
});
ok("agent statement mirrors the PMS transcript (income - deductions) and picks up edited deductions", () => {
  const t = { billingMonth: "2026-10", status: "finalized", notes: "Thanks", items: [
    { description: "Collectable Rent", amount: 34000, isDeductible: false, sortOrder: 1 },
    { description: "Agent Commission (10%)", amount: 3400, isDeductible: true, sortOrder: 2 },
    { description: "Plumber", amount: 2500, isDeductible: true, sortOrder: 3 },
  ] };
  const a = buildOpenSnapshot({ ...base, transcripts: { "2026-10": t } }).summary;
  assert.strictEqual(a.statement.source, "agent"); assert.strictEqual(a.statement.status, "finalized");
  assert.strictEqual(a.statement.income.v, 34000); assert.strictEqual(a.statement.deductions.v, 5900); assert.strictEqual(a.statement.netPayable.v, 28100);
  assert.strictEqual(a.net.payable.v, 28100);
});
ok("estimate labels in Swahili", () => {
  const sw = buildOpenSnapshot({ ...base, lang: "sw" }).summary.statement;
  assert.strictEqual(sw.items[0].label, "Zilizokusanywa (kodi na bili)");
});

// ---------------- masking ----------------
ok("level 'tenant' hides tenant PII only", () => {
  const m = maskSnapshot(snap, "tenant");
  assert.strictEqual(m.property.name, "Sunrise Apartments"); assert.strictEqual(m.summary.billed.v, 56500);
  assert.strictEqual(m.tenants[0].name, "D••• O•••"); assert.strictEqual(m.tenants[0].phone, "07•• ••• 222");
  assert.strictEqual(m.tenants[0].unit, "D4"); assert.strictEqual(m.tenants[0].status, "unpaid");
});
ok("level 'full' masks everything and leaks no real value", () => {
  const m = maskSnapshot(snap, "full");
  assert.strictEqual(m.property.name, "S••• A•••"); assert.strictEqual(m.property.address, "••••••••");
  assert.strictEqual(m.summary.billed.v, null); assert.strictEqual(m.summary.billed.d, "KES ••,•••");
  assert.strictEqual(m.summary.tenants.active.d, "••"); assert.strictEqual(m.summary.collectionRatePct.d, "••%");
  assert.ok(m.tenants.length <= 5 && m.tenants.every((t) => t.status === "masked" && t.dueDate === null));
  const text = JSON.stringify(m);
  for (const leak of ["Daniel", "Amina", "254722111222", "56,500", "29,000", "Naivasha", "Sunrise", "Plumber"]) assert.ok(!text.includes(leak), `leaked ${leak}`);
  assert.strictEqual(m.summary.remittance.dueDate, "2026-10-15");
});
ok("no snapshot level ever carries an id or email field", () => {
  for (const lvl of ["full", "tenant", "open"]) { const t = JSON.stringify(maskSnapshot(snap, lvl)); assert.ok(!/"(id|email|nationalId|idNumber)"/.test(t)); }
});
ok("etag changes with mask level and language, not with generatedAt", () => {
  const a = etagOf(maskSnapshot(snap, "tenant"), "en"), b = etagOf(maskSnapshot(snap, "open"), "en"), c = etagOf(maskSnapshot(snap, "tenant"), "sw");
  assert.notStrictEqual(a, b); assert.notStrictEqual(a, c);
  assert.strictEqual(a, etagOf({ ...maskSnapshot(snap, "tenant"), generatedAt: "x" }, "en"));
});

// ---------------- formatting / dates ----------------
ok("formatters", () => {
  assert.strictEqual(F.formatKes(125000), "KES 125,000"); assert.strictEqual(F.formatKes(1250.5), "KES 1,250.5");
  assert.strictEqual(F.maskName("John Kamau"), "J••• K•••"); assert.strictEqual(F.maskPhone("+254712345678"), "07•• ••• 678");
  assert.strictEqual(F.shiftMonth("2026-01", -1), "2025-12"); assert.strictEqual(F.shiftMonth("2026-12", 1), "2027-01");
  assert.strictEqual(F.currentMonth(new Date("2026-10-31T22:00:00Z")), "2026-11"); // 01:00 on 1 Nov in Nairobi
  assert.strictEqual(F.monthLabel("2026-10", "sw"), "Oktoba 2026"); assert.strictEqual(F.dayLabel("2026-10-15", "sw"), "15 Oktoba 2026");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
