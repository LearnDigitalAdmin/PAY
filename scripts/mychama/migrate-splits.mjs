#!/usr/bin/env node
// TRACK B / B3 — re-create every chama's Paystack subaccount + split under the NEW (MyChama) Paystack account.
//
// WHY: settlementSplitCode values in mychama1 belong to the OLD Paystack account. A split code can only be
// used by the account that created it, so every chama needs a new one before ANY charge uses the new key.
//
// WHAT IS PERSISTED IN FIRESTORE (verified in Chama functions/mychama/payments.py):
//   chamas/{id}.settlementAccount   = "<paybill|till|bank>:<accountNumber>"      (always)
//   chamas/{id}.settlementSplitCode = old-account split code                       (always)
//   chamas/{id}/settlementAccountRequests/{rid}  { accountType, accountNumber, bankCode, status }
//        -> only exists when the account was set/changed via requestSettlementChange. The chair's INITIAL
//           setupSettlementAccount writes NO request doc, so a BANK-type account set up that way has NO
//           recoverable bankCode. Such chamas are reported as `needs_reonboarding` (never guessed).
//   paybill/till use Chama's placeholder bank code "MPESA" (payments.py TODO: "go-live blocker").
//
// WHAT IT DOES per chama (idempotent):
//   skip   settlementSplitKeyVersion === 2 (already migrated) / no settlement account
//   create subaccount (percentage_charge 0) then split (100% to the subaccount) — same payloads as Chama's
//          shared/paystack.py — with the NEW key
//   write  legacySettlementSplitCode (old code kept), settlementSplitCode (new), settlementSplitKeyVersion: 2,
//          settlementSplitMigratedAt. The split-percentage logic is untouched: amounts are still computed in code
//          (money.py) before the charge; the split just routes 100% to the chama's subaccount.
//   A crash between "subaccount created" and "split written" is safe: the subaccount code is staged on the chama
//   doc (settlementMigration.subaccountCode) and re-used on the next run.
//
// USAGE
//   node scripts/mychama/migrate-splits.mjs --dry-run                      (default; no Paystack calls, no writes)
//   MYCHAMA_PAYSTACK_NEW_KEY=sk_test_... node scripts/mychama/migrate-splits.mjs --apply --confirm-bank-codes
// ROLLBACK  node scripts/mychama/migrate-splits.mjs --rollback [--apply]
//        puts each migrated chama's legacySettlementSplitCode back as settlementSplitCode (the new code is kept in
//        rolledBackSplitCode) and removes the version marker. Use it ONLY together with reverting the Chama/CYBER key
//        (see docs/mychama/cutover.md §Rollback): the old key must never meet a new-account split code.
// FLAGS  --project mychama1   --only id1,id2   --report out.json   --paybill-bank-code X   --till-bank-code Y
// AUTH   Application Default Credentials (gcloud auth application-default login) or the Firestore emulator
//        (FIRESTORE_EMULATOR_HOST). The Paystack key is read ONLY from the environment and is never printed.
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const val = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };

const APPLY = flag("apply");
const ROLLBACK = flag("rollback");
if (APPLY && flag("dry-run")) die("Use --dry-run OR --apply, not both.");
const PROJECT = val("project", "mychama1");
const ONLY = val("only", "") ? val("only", "").split(",").map((s) => s.trim()).filter(Boolean) : null;
const REPORT = val("report", "");
const PAYBILL_CODE = val("paybill-bank-code", "MPESA");   // Chama placeholder — CONFIRM against Paystack GET /bank?country=kenya
const TILL_CODE = val("till-bank-code", "MPESA");
const KEY = process.env.MYCHAMA_PAYSTACK_NEW_KEY || "";
const API = "https://api.paystack.co";

function die(m) { console.error("ERROR: " + m); process.exit(1); }
const mask = (s) => (s && s.length > 3 ? "•".repeat(Math.max(s.length - 3, 1)) + s.slice(-3) : "•••");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (APPLY && !ROLLBACK) {
  if (!/^sk_(test|live)_/.test(KEY)) die("--apply needs MYCHAMA_PAYSTACK_NEW_KEY (the NEW account's secret key) in the environment.");
  console.log(`*** APPLY MODE — using a ${KEY.startsWith("sk_live_") ? "LIVE" : "TEST"} key on project ${PROJECT} ***`);
}

admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

async function paystack(path, body) {
  const res = await fetch(API + path, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.status === false) throw new Error(`Paystack ${path} ${res.status}: ${j.message || "unknown error"}`);
  return j.data;
}

/** bank code for the chama's current settlement account, or {reason} when it cannot be recovered. */
async function resolveBankCode(chamaId, type, number) {
  if (type === "paybill") return { code: PAYBILL_CODE, usedDefault: !flag("paybill-bank-code") };
  if (type === "till") return { code: TILL_CODE, usedDefault: !flag("till-bank-code") };
  if (type !== "bank") return { reason: `unknown account type "${type}"` };
  const snap = await db.collection(`chamas/${chamaId}/settlementAccountRequests`).where("status", "==", "approved").get();
  const match = snap.docs.map((d) => d.data())
    .filter((r) => r.accountType === "bank" && String(r.accountNumber) === number && r.bankCode)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  return match ? { code: String(match.bankCode), usedDefault: false } : { reason: "bank account has no recoverable bankCode (set up via initial setup, not a change request) — chair must re-submit settlement details" };
}

const results = [];
const push = (r) => { results.push(r); console.log(`${r.status.padEnd(18)} ${r.chamaId}${r.accountType ? `  ${r.accountType}:${r.accountMasked}` : ""}${r.reason ? `  — ${r.reason}` : ""}`); };

const all = await db.collection("chamas").get();
const chamas = all.docs.filter((d) => !ONLY || ONLY.includes(d.id));
console.log(`${chamas.length} chama(s) to examine${ONLY ? " (filtered by --only)" : ""}.\n`);

if (ROLLBACK) {
  for (const doc of chamas) {
    const c = doc.data();
    const base = { chamaId: doc.id };
    if (c.settlementSplitKeyVersion !== 2) { push({ ...base, status: "not_migrated" }); continue; }
    if (!c.legacySettlementSplitCode) { push({ ...base, status: "no_legacy_code", reason: "set up after cutover — nothing to roll back to" }); continue; }
    if (!APPLY) { push({ ...base, status: "would_rollback" }); continue; }
    await doc.ref.update({
      settlementSplitCode: c.legacySettlementSplitCode,
      rolledBackSplitCode: c.settlementSplitCode,
      settlementSplitKeyVersion: FieldValue.delete(),
      settlementSplitMigratedAt: FieldValue.delete(),
      updatedAt: Date.now(),
    });
    push({ ...base, status: "rolled_back" });
  }
  console.log("\nSummary:", results.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {}));
  if (!APPLY) console.log("Dry run only — pass --apply to roll back.");
  process.exit(0);
}

// plan first, so --apply can refuse BEFORE touching Paystack if a placeholder code would be used unconfirmed
const plan = [];
for (const doc of chamas) {
  const c = doc.data();
  const base = { chamaId: doc.id };
  if (c.settlementSplitKeyVersion === 2) { push({ ...base, status: "already_migrated" }); continue; }
  if (!c.settlementSplitCode && !c.settlementAccount) { push({ ...base, status: "no_settlement" }); continue; }
  const m = /^(paybill|till|bank):(.+)$/.exec(String(c.settlementAccount || ""));
  if (!m) { push({ ...base, status: "needs_reonboarding", reason: "settlementAccount missing/unparseable" }); continue; }
  const [, type, number] = m;
  const bc = await resolveBankCode(doc.id, type, number);
  if (bc.reason) { push({ ...base, status: "needs_reonboarding", accountType: type, accountMasked: mask(number), reason: bc.reason }); continue; }
  plan.push({ doc, c, type, number, bankCode: bc.code, usedDefault: bc.usedDefault });
}

if (APPLY && plan.some((p) => p.usedDefault) && !flag("confirm-bank-codes")) {
  die(`${plan.filter((p) => p.usedDefault).length} paybill/till chama(s) would use Chama's PLACEHOLDER bank code "MPESA". ` +
      "Confirm the real code against Paystack (GET /bank?country=kenya), pass --paybill-bank-code/--till-bank-code, or pass --confirm-bank-codes to accept the placeholder.");
}

for (const p of plan) {
  const { doc, c, type, number, bankCode } = p;
  const base = { chamaId: doc.id, accountType: type, accountMasked: mask(number) };
  if (!APPLY) { push({ ...base, status: "would_migrate", reason: `bank code "${bankCode}"${p.usedDefault ? " (placeholder)" : ""}` }); continue; }
  let staged = null, newSplit = null;
  try {
    const name = c.name || "Chama";
    let subaccountCode = c.settlementMigration?.subaccountCode;
    if (!subaccountCode) {
      const sub = await paystack("/subaccount", { business_name: name, settlement_bank: bankCode, account_number: number, percentage_charge: 0 });
      subaccountCode = sub.subaccount_code;
      await doc.ref.update({ "settlementMigration.subaccountCode": subaccountCode, "settlementMigration.at": Date.now() });
      staged = subaccountCode;
    }
    const split = await paystack("/split", { name: `${name} settlement`, type: "percentage", currency: "KES", subaccounts: [{ subaccount: subaccountCode, share: 100 }], bearer_type: "subaccount" });
    newSplit = split.split_code;

    // only write if nobody changed the settlement account while we were talking to Paystack
    const outcome = await db.runTransaction(async (tx) => {
      const cur = (await tx.get(doc.ref)).data() || {};
      if (cur.settlementSplitKeyVersion === 2) return "already";
      if (cur.settlementSplitCode !== c.settlementSplitCode || cur.settlementAccount !== c.settlementAccount) return "changed";
      tx.update(doc.ref, {
        legacySettlementSplitCode: cur.legacySettlementSplitCode || c.settlementSplitCode || null,
        settlementSplitCode: newSplit,
        settlementSplitKeyVersion: 2,
        settlementSplitMigratedAt: Date.now(),
        settlementMigration: FieldValue.delete(),
        updatedAt: Date.now(),
      });
      return "ok";
    });
    if (outcome === "ok") push({ ...base, status: "migrated" });
    else if (outcome === "already") push({ ...base, status: "already_migrated" });
    else push({ ...base, status: "changed_during_run", reason: `settlement account changed mid-run; orphan split ${newSplit} created at Paystack — re-run`, orphanSplit: newSplit });
  } catch (e) {
    push({ ...base, status: "failed", reason: String(e.message || e).slice(0, 300), orphanSubaccount: staged || undefined, orphanSplit: newSplit || undefined });
  }
  await sleep(300);   // be gentle with Paystack
}

const tally = results.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
console.log("\nSummary:", tally);
if (REPORT) { writeFileSync(REPORT, JSON.stringify({ project: PROJECT, mode: APPLY ? "apply" : "dry-run", at: new Date().toISOString(), tally, results }, null, 2)); console.log(`Report written to ${REPORT}`); }
if (!APPLY) console.log("\nDry run only — nothing was written and Paystack was not called.");
if (tally.needs_reonboarding) console.log("\nneeds_reonboarding chamas cannot pay online until their chair + treasurer re-submit settlement details (requestSettlementChange -> approveSettlementChange) AFTER the Chama functions use the new key. Until then PAY and Chama both refuse (online_collection_disabled).");
process.exit(tally.failed || tally.changed_during_run ? 2 : 0);
