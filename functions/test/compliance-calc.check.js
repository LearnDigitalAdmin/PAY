/* Compliance reports: report maths, the MRI band, bills vs base rent, prices and the desk split.
 * Run:  cd functions && npm run build && node test/compliance-calc.check.js   (exit 1 on failure) */
const assert = require("assert");
const path = require("path");
const lib = (p) => require(path.join(__dirname, "..", "lib", "compliance", p));
const { computeReport, allocatePayments, dueDateFor, pctOf } = lib("calc");
const { priceMinor, deskReportSplit, nairobiMonth, previousMonth } = lib("pricing");
let passed = 0, failed = 0;
const ok = (name, fn) => { try { fn(); passed++; console.log("  ✓", name); } catch (e) { failed++; console.error("  ✗", name, "\n", e); } };

const base = () => ({
  schema: 1, kind: "mri_monthly", month: "2026-10",
  landlord: { name: "L" }, property: { id: "1", name: "Block A", commissionRatePct: 10, managed: true, residential: true },
  tenants: [
    { id: "a", unit: "A1", name: "Amina", rent: 10000, active: true },
    { id: "b", unit: "A2", name: "Brian", rent: 12000, active: true },
    { id: "c", unit: "A3", name: "Chebet", rent: 8000, active: true },
  ],
  invoices: [
    { id: "i1", tenantId: "a", month: "2026-10", rent: 10000, total: 10500, payments: [{ date: "2026-10-03", amount: 10200 }] },
    { id: "i2", tenantId: "b", month: "2026-10", rent: 12000, total: 12000, payments: [{ date: "2026-10-05", amount: 5000 }, { date: "2026-10-20", amount: 7000 }] },
    { id: "i0", tenantId: "c", month: "2026-09", rent: 8000, total: 8000, payments: [{ date: "2026-10-02", amount: 8000 }] },
  ],
  statementItems: [
    { month: "2026-10", description: "Plumbing repairs", amount: 1500 },
    { month: "2026-10", description: "Rent", amount: 5000 },
    { month: "2026-10", description: "Agent commission", amount: 3000 },
    { month: "2026-09", description: "Other month", amount: 99 },
  ],
});

ok("base rent only: payments go to rent first, then bills; overpayment is advance rent", () => {
  assert.deepStrictEqual(allocatePayments(10000, 10500, [{ date: "2026-10-03", amount: 10200 }]), [{ date: "2026-10-03", rent: 1000000, bills: 20000 }]);
  assert.deepStrictEqual(allocatePayments(1000, 1000, [{ date: "2026-10-03", amount: 1500 }]), [{ date: "2026-10-03", rent: 150000, bills: 0 }]);
  assert.deepStrictEqual(allocatePayments(1000, 1200, [{ date: "2026-10-09", amount: 900 }, { date: "2026-10-01", amount: 300 }]).map((s) => [s.date, s.rent, s.bills]), [["2026-10-01", 30000, 0], ["2026-10-09", 70000, 20000]]);
});
ok("rent is counted when RECEIVED (a September invoice paid in October is October rent)", () => {
  const c = computeReport(base());
  assert.strictEqual(c.grossRent, 3000000);                       // 10,000 + 12,000 + 8,000
  assert.strictEqual(c.totals.receivedRent, 3000000);
});
ok("final rental income = rent received - agent commission; MRI base stays the GROSS rent", () => {
  const c = computeReport(base());
  assert.strictEqual(c.commission.amount, 300000); assert.strictEqual(c.finalIncome, 2700000);
  assert.strictEqual(c.mri.applies, true); assert.strictEqual(c.mri.base, 3000000); assert.strictEqual(c.mri.tax, 225000);   // 7.5% of 30,000 = 2,250.00
  assert.strictEqual(c.mri.dueDate, "2026-11-20");
});
ok("bills never include base rent; commission is a bill; duplicates are listed as excluded", () => {
  const c = computeReport(base());
  assert.deepStrictEqual(c.bills.lines.map((l) => [l.description.slice(0, 16), l.amount]), [["Agent commission", 300000], ["Plumbing repairs", 150000]]);
  assert.strictEqual(c.bills.total, 450000);
  assert.deepStrictEqual(c.bills.excluded.map((e) => e.description), ["Rent", "Agent commission"]);
  assert.ok(c.bills.lines.every((l) => !/^rent$/i.test(l.description)));
  assert.ok(c.rows.every((r) => r.invoicedBills >= 0));
  const a = c.rows.find((r) => r.name === "Amina");
  assert.strictEqual(a.invoicedBills, 50000); assert.strictEqual(a.receivedBills, 20000); assert.strictEqual(a.receivedRent, 1000000);
});
ok("tenants without an invoice are flagged; outstanding rent is not tax", () => {
  const c = computeReport(base());
  assert.strictEqual(c.occupancy.withoutInvoice, 1);
  assert.strictEqual(c.checks.find((x) => x.id === "invoices").result, "warn");
  const part = base(); part.invoices[1].payments = [{ date: "2026-10-05", amount: 5000 }];
  const p = computeReport(part);
  assert.strictEqual(p.rows.find((r) => r.name === "Brian").outstandingRent, 700000);
  assert.strictEqual(p.grossRent, 2300000);
});
ok("annual band: KES 288,000 - 15,000,000 (contracted rent x 12 or rent received, whichever is larger)", () => {
  const within = computeReport(base());                                  // 30,000 x 12 = 360,000
  assert.strictEqual(within.threshold.status, "within"); assert.strictEqual(within.threshold.basis, 36000000);
  const small = base(); small.tenants = [{ id: "a", unit: "1", name: "A", rent: 20000, active: true }];   // 240,000 a year
  small.invoices = [{ id: "x", tenantId: "a", month: "2026-10", rent: 20000, total: 20000, payments: [{ date: "2026-10-04", amount: 20000 }] }]; small.statementItems = [];
  const s = computeReport(small);
  assert.strictEqual(s.threshold.status, "below"); assert.strictEqual(s.mri.applies, false); assert.strictEqual(s.mri.tax, 0); assert.strictEqual(s.mri.regime, "below_threshold");
  assert.strictEqual(s.checks.find((x) => x.id === "threshold_min").result, "fail");
  small.portfolio = { propertyCount: 2, annualRentRoll: 400000, ytdReceived: 0 };                          // the landlord's total reaches the band
  const t = computeReport(small);
  assert.strictEqual(t.threshold.status, "within"); assert.strictEqual(t.threshold.scope, "landlord"); assert.strictEqual(t.mri.tax, 150000);
  const big = base(); big.portfolio = { propertyCount: 9, annualRentRoll: 15_000_001, ytdReceived: 0 };
  const g = computeReport(big);
  assert.strictEqual(g.threshold.status, "above"); assert.strictEqual(g.mri.regime, "above_threshold"); assert.strictEqual(g.mri.tax, 0);
  const edge = base(); edge.portfolio = { propertyCount: 1, annualRentRoll: 288000, ytdReceived: 0 }; edge.tenants = edge.tenants.map((t) => ({ ...t, rent: 1000 }));
  assert.strictEqual(computeReport(edge).threshold.status, "within");                                        // exactly KES 288,000 is in the band
  const edge2 = base(); edge2.portfolio = { propertyCount: 1, annualRentRoll: 287999.99, ytdReceived: 0 }; edge2.tenants = edge2.tenants.map((t) => ({ ...t, rent: 1000 }));
  assert.strictEqual(computeReport(edge2).threshold.status, "below");
});
ok("non-residential property is outside MRI", () => {
  const b = base(); b.property.residential = false;
  const c = computeReport(b);
  assert.strictEqual(c.mri.applies, false); assert.strictEqual(c.mri.tax, 0); assert.strictEqual(c.checks.find((x) => x.id === "residential").result, "fail");
});
ok("a property without an agent has no commission", () => {
  const b = base(); b.property.managed = false;
  const c = computeReport(b);
  assert.strictEqual(c.commission.amount, 0); assert.strictEqual(c.finalIncome, c.grossRent);
});
ok("annual summary: month-by-month, year to date, MRI per month", () => {
  const b = base(); b.kind = "annual_summary";
  b.invoices.push({ id: "j", tenantId: "a", month: "2026-01", rent: 10000, total: 10000, payments: [{ date: "2026-01-05", amount: 10000 }] });
  const c = computeReport(b);
  assert.strictEqual(c.monthly.length, 10);
  assert.deepStrictEqual([c.monthly[0].grossRent, c.monthly[9].grossRent], [1000000, 3000000]);
  assert.strictEqual(c.annual.gross, 4000000); assert.strictEqual(c.annual.commission, 400000); assert.strictEqual(c.annual.finalIncome, 3600000); assert.strictEqual(c.annual.mriTax, 300000);
});
ok("percentages round half up; due date rolls over the year end", () => {
  assert.strictEqual(pctOf(1000, 7.5), 75); assert.strictEqual(pctOf(1, 50), 1); assert.strictEqual(pctOf(333, 7.5), 25);
  assert.strictEqual(dueDateFor("2026-12"), "2027-01-20"); assert.strictEqual(dueDateFor("2026-02"), "2026-03-20");
});
ok("price: one free per property per month on Business+, KES 200 otherwise (also for free-plan landlords)", () => {
  for (const t of ["business", "Pro", "professional", "ENTERPRISE"]) { assert.strictEqual(priceMinor({ channel: "pms", tier: t, freeUsed: 0 }), 0); assert.strictEqual(priceMinor({ channel: "watch", tier: t, freeUsed: 1 }), 20000); }
  for (const t of ["free", "starter", "solo", "", undefined, null, "toString"]) assert.strictEqual(priceMinor({ channel: "pms", tier: t, freeUsed: 0 }), 20000);
});
ok("desk is never free, whatever the landlord's plan", () => {
  for (const t of ["enterprise", "business", "free"]) assert.strictEqual(priceMinor({ channel: "desk", tier: t, freeUsed: 0 }), 20000);
});
ok("desk split: KES 200 - 1.5% Paystack - 15% platform = KES 167.00 for the agent", () => {
  const s = deskReportSplit();
  assert.deepStrictEqual([s.paystackMinor, s.platformMinor, s.agentMinor], [300, 3000, 16700]);
  assert.strictEqual(s.agentSharePct, 84.77);                           // share of what Paystack settles (200.00 - 3.00)
  const agentSettled = Math.floor(((20000 - 300) * Math.round(s.agentSharePct * 100)) / 10000);
  assert.ok(agentSettled <= 16700 && 16700 - agentSettled <= 1, `agent nets ${agentSettled}`);   // never overpaid, at most 1 cent short
  assert.strictEqual(s.platformMinorOnSettle(300) + agentSettled + 300, 20000);
});
ok("Nairobi month rolls over at 21:00 UTC", () => {
  assert.strictEqual(nairobiMonth(new Date("2026-10-31T20:59:00Z")), "2026-10"); assert.strictEqual(nairobiMonth(new Date("2026-10-31T21:00:00Z")), "2026-11");
  assert.strictEqual(previousMonth("2026-01"), "2025-12");
});
ok("the PDF template: figures, escaping, uniform sections, no NaN, and the MRI base is gross rent", () => {
  const { renderReportHtml, kes } = lib("html");
  assert.strictEqual(kes(123456789), "KES 1,234,567.89"); assert.strictEqual(kes(-5), "-KES 0.05"); assert.strictEqual(kes(0), "KES 0.00");
  const b = base(); b.tenants[0].name = "<script>alert(1)</script> & Co"; b.property.name = 'A "quoted" <b>name</b>';
  const h = renderReportHtml(computeReport(b), { reportId: "abc", generatedAt: new Date("2026-11-05T10:00:00Z"), dataHash: "f".repeat(64), source: "pms" });
  assert.ok(!h.includes("<script>alert") && !h.includes("<b>name</b>")); assert.ok(h.includes("&lt;script&gt;"));
  assert.ok(!/NaN|undefined|null/.test(h.replace(/class="[^"]*"/g, "")));
  for (const t of ["MRI working paper", "KES 30,000.00", "KES 2,250.00", "20 November 2026", "Agent commission (10% of rent received)", "Plumbing repairs", "Left out of the register", "iTax"]) assert.ok(h.includes(t), t);
  const annual = renderReportHtml(computeReport({ ...b, kind: "annual_summary" }), { reportId: "abc", generatedAt: new Date(), dataHash: "0", source: "desk" });
  assert.ok(annual.includes("Month by month") && annual.includes("Latest return due"));
  const below = base(); below.property.residential = false;
  assert.ok(renderReportHtml(computeReport(below), { reportId: "x", generatedAt: new Date(), dataHash: "0", source: "watch" }).includes("MRI does not apply"));
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
