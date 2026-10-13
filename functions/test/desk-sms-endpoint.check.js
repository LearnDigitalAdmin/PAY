/* Request handling for the MyRegister -> PAY desk SMS planning call (injected deps, no Firestore/Paystack).
 * Run:  cd functions && npm run build && node test/desk-sms-endpoint.check.js   (exit 1 on failure) */
process.env.PAYSTACK_SECRET_KEY = "sk_test_unit";
const assert = require("assert"), path = require("path");
const { handleDeskSmsRequest, SCHOOL_KES_RATE_PER_TOKEN } = require(path.join(__dirname, "..", "lib", "desk", "smsRequest"));
const fs = require("fs");

let failed = 0, calls;
const deps = {
  plan: async (p) => { calls.push(["plan", p]); return p.entityKey === "school:99999" ? { applied: false, reason: "no_desk_owner" } : { applied: true, splitCode: "SPL_x", commission: { agentCode: "COG-0001", agentId: "ag1", sharePct: 28.4, rule: "sms_standard", entityKey: p.entityKey }, reservedFirstPurchase: false }; },
  release: async (k, r) => { calls.push(["release", k, r]); return true; },
};
async function t(name, fn) { calls = []; try { await fn(); console.log("  ✓", name); } catch (e) { failed++; console.error("  ✗", name, "\n", e.message); } }
const good = { action: "plan", entityKey: "school:12345", reference: "SMS_u1_1700000000000", tier: "medium", tokens: 400 };

(async () => {
  await t("plan derives the gross from tier x tokens and ignores any amount the caller sends", async () => {
    const r = await handleDeskSmsRequest({ ...good, grossMinor: 1, amountKes: 1 }, deps);
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.applied, true); assert.strictEqual(r.body.splitCode, "SPL_x");
    assert.deepStrictEqual(calls[0][1], { entityKey: "school:12345", reference: good.reference, grossMinor: 20000, credits: 400 });
  });
  await t("no desk owner is a normal 200 with applied:false (Register then charges plainly)", async () => {
    const r = await handleDeskSmsRequest({ ...good, entityKey: "school:99999" }, deps);
    assert.deepStrictEqual(r, { status: 200, body: { applied: false, reason: "no_desk_owner" } });
  });
  await t("release frees the reservation", async () => {
    const r = await handleDeskSmsRequest({ action: "release", entityKey: "school:12345", reference: good.reference }, deps);
    assert.deepStrictEqual(r, { status: 200, body: { released: true } }); assert.deepStrictEqual(calls[0], ["release", "school:12345", good.reference]);
  });
  await t("only school: entities, SMS_ references, known tiers and whole token counts are accepted", async () => {
    for (const bad of [null, [], {}, { ...good, entityKey: "pms:ABC" }, { ...good, entityKey: "chama:X" }, { ...good, entityKey: "school:../x" },
      { ...good, reference: "x" }, { ...good, tier: "huge" }, { ...good, tokens: 0 }, { ...good, tokens: 1.5 }, { ...good, tokens: "400" }, { ...good, action: "drop" }]) {
      const r = await handleDeskSmsRequest(bad, deps); assert.strictEqual(r.status, 400, JSON.stringify(bad));
    }
    assert.strictEqual(calls.length, 0);
  });
  await t("rates mirror KES_RATE_PER_TOKEN in index.ts", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "index.ts"), "utf8");
    const m = src.match(/const KES_RATE_PER_TOKEN:[^=]*=\s*\{([^}]*)\}/)[1];
    for (const [k, v] of Object.entries(SCHOOL_KES_RATE_PER_TOKEN)) assert.match(m, new RegExp(`${k}:\\s*${v}`));
  });
  console.log(failed ? `${failed} failed` : "all passed"); process.exit(failed ? 1 : 0);
})();
