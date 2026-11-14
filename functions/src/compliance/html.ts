// One template for every report: same layout, same section order, same wording. Paged by the PDF engine (table headers repeat,
// rows never split, the footer carries page numbers).
import { MRI_MAX_ANNUAL_KES, MRI_MIN_ANNUAL_KES, MRI_RATE_PCT, REPORT_TITLE } from "./constants";
import { freshnessMessage, nairobiDate } from "./freshness";
import type { Computed } from "./types";

const esc = (s: unknown): string => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
export const kes = (minor: number): string => {
  const sign = minor < 0 ? "-" : "";
  const a = Math.abs(minor);
  return `${sign}KES ${Math.floor(a / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${String(a % 100).padStart(2, "0")}`;
};
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthName = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const longDate = (d: string) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;

export interface Meta { reportId: string; generatedAt: Date; dataHash: string; source: "pms" | "watch" | "desk" | "auto" }

const CSS = `
:root{--ink:#14213d;--mu:#5b6676;--line:#d7dde5;--soft:#f4f7f6;--ac:#0b6b4f;--warn:#a4530f;--bad:#a3262a}
*{box-sizing:border-box}html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;font:10.5pt/1.45 "Helvetica Neue",Arial,sans-serif;color:var(--ink)}
.head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid var(--ac);padding-bottom:8px;margin-bottom:12px}
.brand{font-weight:700;color:var(--ac);font-size:11pt;letter-spacing:.3px}.title{font-size:17pt;font-weight:700;margin:2px 0 0}.sub{color:var(--mu);font-size:9.5pt}
.id{text-align:right;font-size:8.5pt;color:var(--mu)}.id b{color:var(--ink)}
h2{font-size:12pt;margin:18px 0 6px;color:var(--ac);border-bottom:1px solid var(--line);padding-bottom:3px;break-after:avoid}
h2 .n{display:inline-block;min-width:18px}
table{border-collapse:collapse;width:100%;font-size:9.2pt;margin:4px 0 6px}
thead{display:table-header-group}tfoot{display:table-row-group}tr{break-inside:avoid}
th{background:var(--soft);text-align:left;border:1px solid var(--line);padding:4px 6px;font-weight:600}
td{border:1px solid var(--line);padding:4px 6px;vertical-align:top}td.r,th.r{text-align:right;font-variant-numeric:tabular-nums}
tr.tot td{font-weight:700;background:var(--soft)}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:8px 0}.card{border:1px solid var(--line);border-radius:6px;padding:8px 10px;background:var(--soft);break-inside:avoid}
.card .k{font-size:8.3pt;color:var(--mu);text-transform:uppercase;letter-spacing:.4px}.card .v{font-size:13pt;font-weight:700;margin-top:2px}
.card.hi{background:#e8f4ef;border-color:#9fd1bd}.badge{display:inline-block;border-radius:10px;padding:1px 9px;font-size:8.5pt;font-weight:700;color:#fff}
.b-pass{background:var(--ac)}.b-warn{background:var(--warn)}.b-fail{background:var(--bad)}.b-info{background:#4b5d7a}
.note{border-left:4px solid var(--warn);background:#fbf3ea;padding:6px 10px;margin:8px 0;font-size:9.3pt;break-inside:avoid}
.note.ok{border-color:var(--ac);background:#e8f4ef}.note.bad{border-color:var(--bad);background:#fbeceb}
ol,ul{margin:4px 0 4px 18px;padding:0}li{margin:2px 0}.mu{color:var(--mu)}.small{font-size:8.5pt}
.sign{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:14px;break-inside:avoid}.sign div{border-top:1px solid var(--ink);padding-top:3px;font-size:8.8pt}
.hash{font-family:ui-monospace,Menlo,monospace;font-size:7.8pt;word-break:break-all}
`;

function statusBlock(c: Computed): string {
  const t = c.threshold;
  if (!c.property.residential) return `<div class="note bad"><b>MRI does not apply.</b> This property is recorded as non-residential. MRI covers residential rent only; commercial rent is taxed under the normal income tax rules.</div>`;
  if (t.status === "below") return `<div class="note bad"><b>Below the MRI band.</b> Annual gross rent is under KES ${MRI_MIN_ANNUAL_KES.toLocaleString("en-US")} (KES ${(t.monthlyEquivalent / 100).toLocaleString("en-US")} a month), so MRI is not payable. Rent below the band is declared in the annual income tax return where required.</div>`;
  if (t.status === "above") return `<div class="note bad"><b>Above the MRI band.</b> Annual gross rent is over KES ${MRI_MAX_ANNUAL_KES.toLocaleString("en-US")}. MRI does not apply: file the normal income tax return, where allowable expenses are deductible.</div>`;
  return `<div class="note ok"><b>MRI applies.</b> Annual gross rent is within KES ${MRI_MIN_ANNUAL_KES.toLocaleString("en-US")} to KES ${MRI_MAX_ANNUAL_KES.toLocaleString("en-US")}. Pay ${MRI_RATE_PCT}% of the gross rent received, no deductions, by the 20th of the following month (${longDate(c.mri.dueDate)} for this return).</div>`;
}

/** A notice under the summary when the records the report was made from are not current. Nothing for fresh records or the app's own data. */
function freshnessBlock(c: Computed): string {
  const m = c.dataAsOf ? freshnessMessage(c.dataAsOf) : null;
  if (!m) return "";
  return `<div class="note${m.severe ? " bad" : ""}"><b>${esc(m.title)}</b> ${esc(m.text)}</div>`;
}
const syncedLine = (c: Computed): string => (c.dataAsOf?.syncedAt ? ` &middot; records last synced ${esc(longDate(nairobiDate(c.dataAsOf.syncedAt)))}` : "");

export function renderReportHtml(c: Computed, meta: Meta): string {
  const p = c.property, l = c.landlord, t = c.threshold;
  const periodLabel = c.kind === "annual_summary" ? `January to ${monthName(c.month)}` : monthName(c.month);
  const row = (a: string, b: string, cls = "") => `<tr class="${cls}"><td>${a}</td><td class="r">${b}</td></tr>`;

  // The annual report summarises the whole period; the monthly one summarises the return month.
  const sm = c.annual
    ? { label: periodLabel, gross: c.annual.gross, commission: c.annual.commission, finalIncome: c.annual.finalIncome, tax: c.annual.mriTax, dueLabel: "Latest return due", due: c.mri.dueDate }
    : { label: monthName(c.month), gross: c.grossRent, commission: c.commission.amount, finalIncome: c.finalIncome, tax: c.mri.tax, dueLabel: "Return due", due: c.mri.dueDate };
  const summary = `
  <div class="grid">
    <div class="card"><div class="k">Gross rent received (${esc(sm.label)})</div><div class="v">${kes(sm.gross)}</div></div>
    <div class="card"><div class="k">Agent commission (${c.commission.ratePct}%)</div><div class="v">${kes(sm.commission)}</div></div>
    <div class="card hi"><div class="k">Final rental income</div><div class="v">${kes(sm.finalIncome)}</div></div>
    <div class="card"><div class="k">MRI base (gross rent)</div><div class="v">${kes(sm.gross)}</div></div>
    <div class="card hi"><div class="k">MRI at ${MRI_RATE_PCT}%</div><div class="v">${c.mri.applies ? kes(sm.tax) : "Not applicable"}</div></div>
    <div class="card"><div class="k">${sm.dueLabel}</div><div class="v">${esc(longDate(sm.due))}</div></div>
  </div>${statusBlock(c)}${freshnessBlock(c)}`;

  const worksheet = `
  <table><thead><tr><th>Step</th><th class="r">Amount</th></tr></thead><tbody>
    ${row("A. Base rent received in " + esc(monthName(c.month)) + " (cash basis; bills and deposits excluded)", kes(c.grossRent))}
    ${row("B. Agent commission (" + c.commission.ratePct + "% of A), listed as a bill", kes(c.commission.amount))}
    ${row("C. Final rental income = A - B", kes(c.finalIncome), "tot")}
    ${row("D. MRI base = A (gross rent; the law allows no deduction)", kes(c.mri.base))}
    ${row("E. MRI = D x " + MRI_RATE_PCT + "%" + (c.mri.applies ? "" : " (not applicable: see the annual band test)"), c.mri.applies ? kes(c.mri.tax) : kes(0), "tot")}
  </tbody></table>`;

  const thresholdTable = `
  <table><tbody>
    ${row("Test applied to", t.scope === "landlord" ? "All of the landlord's properties" : "This property only")}
    ${row("Contracted rent for the year (active tenants x 12)" + (t.portfolioRoll !== null ? ", all properties" : ""), kes(t.portfolioRoll ?? t.propertyRoll))}
    ${row("Rent received this year to " + esc(monthName(c.month)) + (t.portfolioYtd !== null ? ", all properties" : ""), kes(t.portfolioYtd ?? t.propertyYtd))}
    ${row("This property: contracted rent / received to date", kes(t.propertyRoll) + " / " + kes(t.propertyYtd))}
    ${row("Figure tested (the larger of the two)", kes(t.basis), "tot")}
    ${row("Minimum for MRI (KES 24,000 a month)", kes(t.minAnnual))}
    ${row("Maximum for MRI", kes(t.maxAnnual))}
    ${row("Result", t.status === "within" ? "Within the MRI band" : t.status === "below" ? "Below the band" : "Above the band", "tot")}
  </tbody></table>`;

  const rentRows = c.rows.map((r) => `<tr><td>${esc(r.unit)}</td><td>${esc(r.name)}</td><td class="r">${kes(r.contractRent)}</td><td class="r">${kes(r.invoicedRent)}</td><td class="r">${kes(r.receivedRent)}</td><td class="r">${kes(r.outstandingRent)}</td><td class="mu">${esc(r.note)}</td></tr>`).join("");
  const rentTable = `
  <table><thead><tr><th>Unit</th><th>Tenant</th><th class="r">Monthly rent</th><th class="r">Rent invoiced</th><th class="r">Rent received</th><th class="r">Outstanding</th><th>Note</th></tr></thead><tbody>${rentRows || `<tr><td colspan="7" class="mu">No tenants recorded.</td></tr>`}</tbody>
  <tfoot><tr class="tot"><td colspan="2">Total (${c.occupancy.activeTenants} active tenants)</td><td class="r">${kes(c.totals.contractRent)}</td><td class="r">${kes(c.totals.invoicedRent)}</td><td class="r">${kes(c.totals.receivedRent)}</td><td class="r">${kes(c.totals.outstandingRent)}</td><td></td></tr></tfoot></table>
  <p class="small mu">Rent received is rent paid in ${esc(monthName(c.month))}, whichever month it was billed for. Payments are applied to base rent first, then to bills; anything above the invoice is advance rent.</p>`;

  const billLines = c.bills.lines.map((b) => `<tr><td>${esc(b.description)}</td><td>${b.source === "agent_commission" ? "Agent commission" : "Agent statement"}</td><td class="r">${kes(b.amount)}</td></tr>`).join("");
  const billsTable = `
  <table><thead><tr><th>Bill</th><th>Source</th><th class="r">Amount</th></tr></thead><tbody>${billLines || `<tr><td colspan="3" class="mu">No bills recorded for ${esc(monthName(c.month))}.</td></tr>`}</tbody>
  <tfoot><tr class="tot"><td colspan="2">Total bills</td><td class="r">${kes(c.bills.total)}</td></tr></tfoot></table>
  ${c.bills.excluded.length ? `<p class="small mu">Left out of the register: ${c.bills.excluded.map((e) => `${esc(e.description)} (${kes(e.amount)}): ${esc(e.reason)}`).join("; ")}.</p>` : ""}
  <p class="small mu">Base rent is income and never appears in this register. Charges that tenants are billed on top of rent (water, service charge and similar) were ${kes(c.totals.invoicedBills)} invoiced and ${kes(c.totals.receivedBills)} received in the month; they are not rent and are not part of the MRI base.</p>`;

  const monthTable = `
  <table><thead><tr><th>Month</th><th class="r">Gross rent received</th><th class="r">Agent commission</th><th class="r">Final rental income</th><th class="r">MRI at ${MRI_RATE_PCT}%</th></tr></thead><tbody>
  ${c.monthly.map((m) => `<tr><td>${esc(monthName(m.month))}</td><td class="r">${kes(m.grossRent)}</td><td class="r">${kes(m.commission)}</td><td class="r">${kes(m.finalIncome)}</td><td class="r">${c.mri.applies ? kes(m.mriTax) : "-"}</td></tr>`).join("")}</tbody>
  ${c.annual ? `<tfoot><tr class="tot"><td>Total</td><td class="r">${kes(c.annual.gross)}</td><td class="r">${kes(c.annual.commission)}</td><td class="r">${kes(c.annual.finalIncome)}</td><td class="r">${c.mri.applies ? kes(c.annual.mriTax) : "-"}</td></tr></tfoot>` : ""}</table>`;

  const checks = `
  <table><thead><tr><th>Check</th><th>Result</th><th>Detail</th></tr></thead><tbody>
  ${c.checks.map((k) => `<tr><td>${esc(k.label)}</td><td><span class="badge b-${k.result}">${k.result.toUpperCase()}</span></td><td>${esc(k.detail)}</td></tr>`).join("")}</tbody></table>`;

  let n = 0;
  const sec = (title: string, body: string) => `<h2><span class="n">${++n}.</span> ${esc(title)}</h2>${body}`;
  const body = c.kind === "annual_summary"
    ? sec("Summary", summary) + sec("Month by month", monthTable) + sec("Annual rent band test", thresholdTable) + sec(`Rent schedule for ${monthName(c.month)}`, rentTable) + sec("Bills and agent commission", billsTable) + sec("Compliance checks", checks)
    : sec("Summary", summary) + sec("MRI working paper", worksheet) + sec("Annual rent band test", thresholdTable) + sec("Rent schedule by unit", rentTable) + sec("Bills and agent commission (base rent excluded)", billsTable) + sec("Compliance checks", checks)
      + (c.monthly.length > 1 ? sec("Year to date", monthTable) : "");

  const filing = sec("Filing the return on iTax", `
  <ol>
    <li>Sign in to the KRA iTax portal with the landlord's KRA PIN. Choose Returns, File Return, then Monthly Rental Income.</li>
    <li>Enter the gross rent received for ${esc(monthName(c.month))}: <b>${kes(c.mri.base)}</b> (line D above). iTax works out the tax.</li>
    <li>Generate the payment slip and pay by ${esc(longDate(c.mri.dueDate))}. Keep the acknowledgement receipt with this report.</li>
  </ol>
  <p class="small mu">Plot Yangu is not connected to KRA and does not file or pay anything on your behalf. This report is prepared from the rent, invoice and payment records kept in Plot Yangu. Check it against your bank and M-Pesa statements before you file. Penalties and interest can apply to late filing or payment; see KRA for current rules.</p>
  <div class="sign"><div>Landlord / agent signature &amp; date</div><div>KRA PIN: ${esc(l.kraPin || "______________________")}</div></div>
  <p class="small mu hash">Report ${esc(meta.reportId)} &middot; ${REPORT_TITLE[c.kind]} &middot; version ${esc(c.version)} &middot; source ${esc(meta.source)}${syncedLine(c)} &middot; record fingerprint (SHA-256) ${esc(meta.dataHash)}</p>`);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(REPORT_TITLE[c.kind])} - ${esc(p.name)}</title><style>${CSS}</style></head><body>
  <div class="head"><div><div class="brand">PLOT YANGU &middot; COMPLIANCE REPORT</div><div class="title">${esc(REPORT_TITLE[c.kind])}</div>
  <div class="sub">${esc(p.name)}${p.address ? ", " + esc(p.address) : ""}<br>Landlord: ${esc(l.name || "-")} &middot; Period: ${esc(periodLabel)}</div></div>
  <div class="id">Report ID<br><b>${esc(meta.reportId)}</b><br>Generated ${esc(meta.generatedAt.toISOString().slice(0, 16).replace("T", " "))} UTC</div></div>
  ${body}${filing}</body></html>`;
}

export const footerText = (c: Computed, reportId: string): string => `Plot Yangu · ${REPORT_TITLE[c.kind]} · ${c.property.name} · ${c.month} · ${reportId}`;
