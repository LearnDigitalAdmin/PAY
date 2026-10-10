// Exercises migrate-splits.mjs end to end with firebase-admin replaced by the in-memory Firestore and Paystack stubbed.
//   node scripts/mychama/test-migrate.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { FakeDb } from "./_fake-firestore.mjs";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const db = new FakeDb();
// the script calls db.collection("chamas").get() and runTransaction — both supported by the fake
const fakeAdmin = { initializeApp() {}, firestore: Object.assign(() => db, { FieldValue: { delete: () => null } }) };
const adminPath = require.resolve("firebase-admin");
require.cache[adminPath] = { id: adminPath, filename: adminPath, loaded: true, exports: fakeAdmin };

const fetchCalls = [];
let n = 0;
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  fetchCalls.push({ url, body, auth: init.headers.Authorization });
  if (url.endsWith("/subaccount")) return { ok: true, status: 200, json: async () => ({ status: true, data: { subaccount_code: `ACCT_${++n}` } }) };
  if (url.endsWith("/split")) return { ok: true, status: 200, json: async () => ({ status: true, data: { split_code: `SPL_NEW_${n}` } }) };
  throw new Error("unexpected " + url);
};

const seed = () => {
  db.store.clear();
  db.seed("chamas/pb", { name: "Paybill Chama", settlementAccount: "paybill:123456", settlementSplitCode: "SPL_OLD_pb" });
  db.seed("chamas/tl", { name: "Till Chama", settlementAccount: "till:987654", settlementSplitCode: "SPL_OLD_tl" });
  db.seed("chamas/bk", { name: "Bank OK", settlementAccount: "bank:0011223344", settlementSplitCode: "SPL_OLD_bk" });
  db.seed("chamas/bk/settlementAccountRequests/r1", { status: "approved", accountType: "bank", accountNumber: "0011223344", bankCode: "063", updatedAt: 5 });
  db.seed("chamas/bk/settlementAccountRequests/r0", { status: "approved", accountType: "bank", accountNumber: "0011223344", bankCode: "999", updatedAt: 1 });
  db.seed("chamas/bx", { name: "Bank initial setup", settlementAccount: "bank:5566778899", settlementSplitCode: "SPL_OLD_bx" });
  db.seed("chamas/done", { name: "Done", settlementAccount: "till:1", settlementSplitCode: "SPL_ALREADY", settlementSplitKeyVersion: 2 });
  db.seed("chamas/none", { name: "No settlement yet" });
};
let run = 0;
async function runScript(...args) {
  process.argv = ["node", "migrate-splits.mjs", ...args];
  let code = 0; const realExit = process.exit; process.exit = (c) => { code = c; throw new Error("__exit__"); };
  const log = console.log; const out = []; console.log = (...a) => out.push(a.join(" "));
  try { await import(`./migrate-splits.mjs?run=${++run}`); } catch (e) { if (e.message !== "__exit__") throw e; } finally { process.exit = realExit; console.log = log; }
  return { code, out: out.join("\n") };
}

seed();
let r = await runScript("--dry-run");
assert.equal(fetchCalls.length, 0, "dry run must not call Paystack");
assert.match(r.out, /would_migrate\s+pb/); assert.match(r.out, /would_migrate\s+bk/); assert.match(r.out, /needs_reonboarding\s+bx/);
assert.match(r.out, /already_migrated\s+done/); assert.match(r.out, /no_settlement\s+none/);
assert.equal(db.read("chamas/pb").settlementSplitCode, "SPL_OLD_pb", "dry run must not write");
assert.ok(!r.out.includes("123456") && !r.out.includes("0011223344"), "account numbers must be masked");

delete process.env.MYCHAMA_PAYSTACK_NEW_KEY;
r = await runScript("--apply");                                                    // no key => refuses
assert.equal(r.code, 1); assert.equal(fetchCalls.length, 0);

process.env.MYCHAMA_PAYSTACK_NEW_KEY = "sk_test_NEWACCOUNT";
r = await runScript("--apply");                                                    // placeholder codes need confirmation
assert.equal(r.code, 1);
assert.equal(fetchCalls.length, 0, "must refuse BEFORE calling Paystack when placeholder bank codes are unconfirmed");

r = await runScript("--apply", "--confirm-bank-codes");
assert.equal(r.code, 0, r.out);
for (const id of ["pb", "tl", "bk"]) {
  const c = db.read(`chamas/${id}`);
  assert.equal(c.settlementSplitKeyVersion, 2, id); assert.match(c.settlementSplitCode, /^SPL_NEW_/, id);
  assert.equal(c.legacySettlementSplitCode, `SPL_OLD_${id}`, id); assert.ok(c.settlementSplitMigratedAt); assert.ok(!c.settlementMigration, id);
}
const bx = db.read("chamas/bx"); assert.equal(bx.settlementSplitCode, "SPL_OLD_bx"); assert.equal(bx.settlementSplitKeyVersion, undefined);
const bkSub = fetchCalls.find((c) => c.url.endsWith("/subaccount") && c.body.account_number === "0011223344");
assert.equal(bkSub.body.settlement_bank, "063", "latest approved request's bankCode is used"); assert.equal(bkSub.body.percentage_charge, 0);
assert.equal(fetchCalls.find((c) => c.url.endsWith("/subaccount") && c.body.account_number === "123456").body.settlement_bank, "MPESA");
assert.ok(fetchCalls.every((c) => c.auth === "Bearer sk_test_NEWACCOUNT"));
const splitCall = fetchCalls.find((c) => c.url.endsWith("/split"));
assert.deepEqual(Object.keys(splitCall.body).sort(), ["bearer_type", "currency", "name", "subaccounts", "type"]);
assert.equal(splitCall.body.subaccounts[0].share, 100);
assert.ok(!r.out.includes("sk_test_NEWACCOUNT"), "key must never be printed");

const callsBefore = fetchCalls.length;
r = await runScript("--apply", "--confirm-bank-codes");                           // idempotent re-run
assert.equal(fetchCalls.length, callsBefore, "re-run must not create anything again");
// rollback: dry run changes nothing, apply restores the legacy codes and removes the marker
r = await runScript("--rollback");
assert.match(r.out, /would_rollback\s+pb/); assert.equal(db.read("chamas/pb").settlementSplitKeyVersion, 2);
r = await runScript("--rollback", "--apply");
const pb = db.read("chamas/pb");
assert.equal(pb.settlementSplitCode, "SPL_OLD_pb"); assert.ok(pb.rolledBackSplitCode.startsWith("SPL_NEW_")); assert.ok(!pb.settlementSplitKeyVersion);
assert.equal(db.read("chamas/bx").settlementSplitCode, "SPL_OLD_bx");
console.log("migrate-splits: all assertions passed");
