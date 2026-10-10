/* Track A checks — pure logic + an end-to-end flow against an in-memory fake Firestore.
 * Run:  cd functions && npm run build && node test/mychama-track-a.check.js   (exit 1 on failure) */
process.env.MYCHAMA_ID_PEPPER = "test-pepper-123";
const assert = require("assert");
const path = require("path");
const lib = (p) => require(path.join(__dirname, "..", "lib", "mychama", p));

let passed = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { passed++; console.log("  ✓", name); }, (e) => { console.error("  ✗", name, "\n", e); process.exitCode = 1; });

// ───────────── fake Firestore ─────────────
function makeDb() {
  const store = new Map();
  const segs = (p) => p.split("/");
  const colRef = (p) => ({
    path: p, id: segs(p).pop(),
    get parent() { const s = segs(p); return s.length > 1 ? docRef(s.slice(0, -1).join("/")) : null; },
    where: (f, op, v) => query(() => [...store.keys()].filter((k) => { const s = segs(k); return s.length === segs(p).length + 1 && k.startsWith(p + "/"); }), [[f, op, v]]),
    get: () => query(() => [...store.keys()].filter((k) => segs(k).length === segs(p).length + 1 && k.startsWith(p + "/")), []).get(),
  });
  const snap = (k) => ({ id: segs(k).pop(), exists: store.has(k), data: () => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : undefined), ref: docRef(k) });
  const docRef = (p) => ({
    path: p, id: segs(p).pop(),
    get parent() { return colRef(segs(p).slice(0, -1).join("/")); },
    get: async () => snap(p),
    set: async (d, o) => { store.set(p, o && o.merge ? { ...(store.get(p) || {}), ...d } : { ...d }); },
    update: async (d) => { if (!store.has(p)) throw new Error("NOT_FOUND " + p); store.set(p, { ...store.get(p), ...d }); },
    delete: async () => { store.delete(p); },
  });
  const matches = (data, [f, op, v]) => (op === "==" ? data[f] === v : op === "array-contains" ? Array.isArray(data[f]) && data[f].includes(v) : false);
  function query(keysFn, wheres, lim) {
    const q = {
      where: (f, op, v) => query(keysFn, [...wheres, [f, op, v]], lim),
      limit: (n) => query(keysFn, wheres, n),
      get: async () => {
        let ks = keysFn().filter((k) => wheres.every((w) => matches(store.get(k), w)));
        if (lim) ks = ks.slice(0, lim);
        return { docs: ks.map(snap), empty: ks.length === 0, size: ks.length };
      },
    };
    return q;
  }
  const db = {
    store, doc: docRef, collection: colRef,
    collectionGroup: (name) => query(() => [...store.keys()].filter((k) => { const s = segs(k); return s.length % 2 === 0 && s[s.length - 2] === name; }), []),
    getAll: async (...refs) => refs.map((r) => snap(r.path)),
    batch: () => { const ops = []; return { set: (r, d) => ops.push(() => r.set(d)), update: (r, d) => ops.push(() => r.update(d)), commit: async () => { for (const o of ops) await o(); } }; },
    runTransaction: async (fn) => fn({
      get: async (r) => r.get(), set: (r, d, o) => { r.set(d, o); }, update: (r, d) => { r.update(d); }, delete: (r) => { r.delete(); },
    }),
  };
  return db;
}

(async () => {
  console.log("pure: compute");
  const C = lib("sync/compute");
  const t = { today: "2026-10-09", month: "2026-10" };

  await ok("contributions: overdue vs this-month, paid skipped, cap & outstanding", () => {
    const r = C.buildContributions([
      { id: "a", periodKey: "2026-08", dueDate: "2026-08-05", amount: 1000, paidAmount: 0, status: "overdue" },
      { id: "b", periodKey: "2026-09", dueDate: "2026-09-05", amount: 1000, paidAmount: 400, status: "partial" },
      { id: "c", periodKey: "2026-10", dueDate: "2026-10-20", amount: 1000, paidAmount: 0, status: "pending" },
      { id: "d", periodKey: "2026-07", dueDate: "2026-07-05", amount: 1000, paidAmount: 1000, status: "paid" },
    ], t);
    assert.strictEqual(r.snap.items.length, 3);
    assert.strictEqual(r.overdue, 1600);          // 1000 (Aug) + 600 (Sep partial)
    assert.strictEqual(r.dueThisMonth, 1000);
    assert.strictEqual(r.snap.outstanding, 2600);
    assert.deepStrictEqual(r.snap.items.map((i) => i.contributionId), ["a", "b", "c"]);
  });

  await ok("loans: outstanding, next instalment, overdue/this-month split; completed ignored", () => {
    const r = C.buildLoans([
      { id: "L1", status: "active", principal: 5000, schedule: [
        { n: 1, due: 1000, paid: true, paidAmount: 1000, dueDate: "2026-08-10" },
        { n: 2, due: 1000, paid: false, paidAmount: 250, dueDate: "2026-09-10" },
        { n: 3, due: 1000, paid: false, paidAmount: 0, dueDate: "2026-10-10" },
        { n: 4, due: 1000, paid: false, paidAmount: 0, dueDate: "2026-11-10" } ] },
      { id: "L2", status: "completed", principal: 1000, schedule: [] },
    ], t);
    assert.strictEqual(r.snap.items.length, 1);
    assert.strictEqual(r.snap.items[0].outstanding, 2750);
    assert.strictEqual(r.snap.items[0].installmentsRemaining, 3);
    assert.deepStrictEqual(r.snap.items[0].nextInstallment, { installmentNo: 2, due: 750, dueDate: "2026-09-10" });
    assert.strictEqual(r.overdue, 750);
    assert.strictEqual(r.dueThisMonth, 1000);
  });

  await ok("mgr: due now, partial, arrears, won + scheduled (equal split) and short round => null amount", () => {
    const pot = { id: "P1", name: "Pot", amount: 500, frequency: "weekly", status: "active", period: 3, periodsPerRound: 1, recipientsPerRound: 2, memberIds: ["m1", "m2", "m3", "m4"], queue: ["m3", "m1", "m4"], drawDone: true, cycleNumber: 1 };
    const b = { pot, records: [{ period: 3, memberId: "m1", status: "partial", amount: 200 }], payouts: [{ memberId: "m1", round: 1, amount: 1000, date: "2026-09-20" }, { memberId: "m2", round: 1, amount: 1000, date: "2026-09-20" }], arrears: [{ id: "A1", memberId: "m1", amount: 300, status: "open" }, { id: "A2", memberId: "m1", amount: 99, status: "settled" }] };
    const r = C.buildMgr([b], "m1");
    const p = r.snap.pots[0];
    assert.strictEqual(p.dueNow, 300); assert.strictEqual(p.currentPeriodPaid, false);
    assert.strictEqual(p.arrearsOpen, 300); assert.strictEqual(p.arrearId, "A1");
    const won = p.wins.find((w) => w.kind === "won"), sch = p.wins.find((w) => w.kind === "scheduled");
    assert.strictEqual(won.amount, 1000); assert.strictEqual(won.expectedDate, "2026-09-20");
    assert.strictEqual(sch.queuePosition, 2); assert.strictEqual(sch.amount, 1000);   // 500*4*1 / 2
    assert.strictEqual(sch.round, 2 + 0);                                              // 2 payouts / 2 per round => round 2, idx 1 => same round
    assert.strictEqual(sch.expectedDate, null);
    assert.strictEqual(r.overdue, 300); assert.strictEqual(r.dueThisMonth, 300);
    const short = C.buildMgr([{ ...b, pot: { ...pot, queue: ["m1"] } }], "m1").snap.pots[0].wins.find((w) => w.kind === "scheduled");
    assert.strictEqual(short.amount, null);
    const notIn = C.buildMgr([b], "zzz"); assert.strictEqual(notIn.snap.pots.length, 0);
  });

  await ok("totals: null only when every section is unavailable", () => {
    assert.strictEqual(C.combineTotals([null, null, null], null, t), null);
    assert.deepStrictEqual(C.combineTotals([{ overdue: 5, dueThisMonth: 7 }, null, null], null, t), { overdue: 5, dueThisMonth: 7, expectedInflowThisMonth: 0 });
  });

  console.log("pure: link actions");
  const A = lib("link/actions");
  const cand = (chamaId, memberId, phoneKey) => ({ chamaId, memberId, phoneKey, phoneE164: "+2547" + phoneKey });
  await ok("silent link only on verified-phone match; others pending grouped by phone", () => {
    const r = A.computeLinkActions({ candidates: [cand("c1", "m1", "A"), cand("c2", "m2", "B"), cand("c3", "m3", "B")], existing: [], verifiedPhoneKey: "A", provenSmsPhoneKeys: [] });
    assert.deepStrictEqual(r.activate.map((a) => [a.linkId, a.via]), [["c1__m1", "firebase_phone"]]);
    assert.strictEqual(r.pending.length, 1); assert.strictEqual(r.pending[0].candidates.length, 2);
  });
  await ok("per-phone grant: an SMS-proven phone links only chamas on that phone", () => {
    const r = A.computeLinkActions({ candidates: [cand("c2", "m2", "B"), cand("c4", "m4", "C")], existing: [], verifiedPhoneKey: null, provenSmsPhoneKeys: ["B"] });
    assert.deepStrictEqual(r.activate.map((a) => a.linkId), ["c2__m2"]);
    assert.deepStrictEqual(r.pending.map((p) => p.phoneKey), ["C"]);
  });
  await ok("phone change => needs_reverify + pending; member gone => revoked; phone back => restored", () => {
    const ex = [{ linkId: "c1__m1", state: "active", boundPhoneKey: "A", verifiedVia: "sms_code" }, { linkId: "c9__m9", state: "active", boundPhoneKey: "Z", verifiedVia: "sms_code" }];
    const r = A.computeLinkActions({ candidates: [cand("c1", "m1", "A2")], existing: ex, verifiedPhoneKey: null, provenSmsPhoneKeys: [] });
    assert.deepStrictEqual(r.reverify, ["c1__m1"]); assert.deepStrictEqual(r.revoke, ["c9__m9"]); assert.strictEqual(r.pending.length, 1);
    const back = A.computeLinkActions({ candidates: [cand("c1", "m1", "A")], existing: [{ linkId: "c1__m1", state: "needs_reverify", boundPhoneKey: "A", verifiedVia: "sms_code" }], verifiedPhoneKey: null, provenSmsPhoneKeys: [] });
    assert.deepStrictEqual(back.activate.map((a) => [a.linkId, a.via]), [["c1__m1", "sms_code"]]);
  });

  // ───────────── end-to-end with fakes ─────────────
  console.log("end-to-end (fake Firestore)");
  const cfg = lib("config");
  const smsMod = lib("sms");
  const plot = makeDb(), mc = makeDb();
  cfg.plotDb = () => plot; cfg.mychamaDb = () => mc;
  const sent = [];
  smsMod.sendMyChamaSms = async (phone, msg) => { sent.push({ phone, msg }); };

  const idKey = cfg.computeIdKey("12345678");
  const member = (name, phone, extra = {}) => ({ name, phoneNormalized: phone, status: "active", role: "member", idKey, ...extra });
  const put = (db, p, d) => db.store.set(p, d);
  put(plot, "tenants/u1", { idNumber: "12 345-678", phone: "0712345678" });
  // chama c1: phone matches the verified Firebase phone
  put(mc, "chamas/c1", { name: "Alpha", plan: "growth", status: "active", settlementSplitCode: "SPL_1" });
  put(mc, "chamas/c1/members/m1", member("T", "+254712345678"));
  put(mc, "chamas/c1/contributions/k1", { memberId: "m1", periodKey: "2026-10", dueDate: "2026-10-25", amount: 1000, paidAmount: 0, status: "pending" });
  put(mc, "chamas/c1/loans/l1", { memberId: "m1", status: "active", principal: 3000, schedule: [{ n: 1, due: 1100, paid: false, paidAmount: 0, dueDate: "2026-10-15" }] });
  put(mc, "chamas/c1/mgrPots/p1", { name: "Pot", amount: 500, frequency: "weekly", status: "active", period: 1, periodsPerRound: 1, recipientsPerRound: 1, memberIds: ["m1"], queue: ["m1"], drawDone: true, cycleNumber: 1 });
  // chama c2: same person, DIFFERENT registered phone
  put(mc, "chamas/c2", { name: "Beta", plan: "starter", status: "active", settlementSplitCode: "" });
  put(mc, "chamas/c2/members/m2", member("T", "+254722000111"));
  // chama c3: two members share the ID => ambiguous, never links
  put(mc, "chamas/c3", { name: "Gamma", plan: "basic", status: "active", settlementSplitCode: "SPL_3" });
  put(mc, "chamas/c3/members/m3a", member("X", "+254733000111")); put(mc, "chamas/c3/members/m3b", member("Y", "+254733000222"));
  // removed member in c4 never links
  put(mc, "chamas/c4", { name: "Delta", plan: "basic", status: "active" });
  put(mc, "chamas/c4/members/m4", member("T", "+254712345678", { status: "removed" }));

  const caller = { uid: "u1", role: "tenant", idNumber: "12 345-678", verifiedPhoneE164: "+254712345678" };
  const S = lib("sync/service");
  const ID = lib("sync/identity");
  const Ch = lib("link/challenge");
  const Eng = lib("link/engine");
  let pendingId, challengeId, code;

  await ok("first login: forced sync silently links c1 only; c2 pending; c3/c4 excluded", async () => {
    const r = await S.runSyncFor(caller, "login");
    assert.strictEqual(r.throttled, false); assert.strictEqual(r.status, "ok");
    const snap = plot.store.get("chamaSnapshots/u1");
    assert.deepStrictEqual(snap.chamas.map((c) => c.chamaId), ["c1"]);
    const c1 = snap.chamas[0];
    assert.strictEqual(c1.dataStatus, "ok"); assert.strictEqual(c1.onlineCollectionEnabled, true);
    assert.strictEqual(c1.contributions.outstanding, 1000); assert.strictEqual(c1.loans.outstanding, 1100);
    assert.strictEqual(c1.mgr.pots[0].dueNow, 500);
    assert.strictEqual(snap.pending.length, 1); assert.strictEqual(snap.pending[0].chamaCount, 1);
    assert.ok(/^07•• ••• 111$/.test(snap.pending[0].maskedPhone), snap.pending[0].maskedPhone);
    assert.ok(!JSON.stringify(snap).includes("12345678") && !JSON.stringify(snap).includes("+2547"), "no ID or full phone in snapshot");
    assert.strictEqual(plot.store.get("chamaLinks/u1/links/c1__m1").verifiedVia, "firebase_phone");
    pendingId = snap.pending[0].pendingId;
  });

  await ok("reload inside the cooldown is throttled and does not touch mychama1", async () => {
    const before = JSON.stringify(plot.store.get("chamaSnapshots/u1"));
    const r = await S.runSyncFor(caller, "reload");
    assert.strictEqual(r.throttled, true); assert.ok(r.nextAllowedAt > Date.now());
    assert.strictEqual(JSON.stringify(plot.store.get("chamaSnapshots/u1")), before);
  });

  await ok("request code: SMS goes to the MyChama-registered phone; resend cooldown enforced", async () => {
    const r = await Ch.requestCode(caller, pendingId);
    assert.strictEqual(sent.length, 1); assert.strictEqual(sent[0].phone, "+254722000111");
    code = /(\d{6})/.exec(sent[0].msg)[1];
    challengeId = r.challengeId;
    const stored = JSON.stringify([...plot.store.entries()].filter(([k]) => k.startsWith("chamaLinkChallenges/")));
    assert.ok(!stored.includes(code), "plain code must never be stored");
    await assert.rejects(() => Ch.requestCode(caller, pendingId), (e) => e.details && e.details.code === "rate_limited");
    await assert.rejects(() => Ch.requestCode(caller, "bogus"), (e) => e.details && e.details.code === "invalid_target");
  });

  await ok("wrong code decrements attempts; another user's challenge is rejected", async () => {
    await assert.rejects(() => Ch.verifyCode("u1", challengeId, code === "000000" ? "111111" : "000000"), (e) => e.details.code === "code_invalid" && e.details.remainingAttempts === 4);
    await assert.rejects(() => Ch.verifyCode("someone-else", challengeId, code), (e) => e.details.code === "code_invalid");
  });

  await ok("attempt lockout after CODE_MAX_ATTEMPTS", async () => {
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i++) await assert.rejects(() => Ch.verifyCode("u1", challengeId, wrong));
    await assert.rejects(() => Ch.verifyCode("u1", challengeId, code), (e) => e.details.code === "code_attempts_exceeded");
    // fresh challenge for the rest of the flow (reset the resend cooldown the way real time would)
    const ch = plot.store.get("chamaLinkChallenges/" + challengeId); ch.lastSentAt -= 120000; plot.store.set("chamaLinkChallenges/" + challengeId, ch);
    const r = await Ch.requestCode(caller, pendingId);
    challengeId = r.challengeId; code = /(\d{6})/.exec(sent[sent.length - 1].msg)[1];
  });

  await ok("correct code links ONLY the chamas on that phone and consumes the challenge", async () => {
    const phoneKey = await Ch.verifyCode("u1", challengeId, code);
    assert.ok(!plot.store.has("chamaLinkChallenges/" + challengeId));
    const pass = await Eng.runLinkPass(caller, [phoneKey]);
    assert.strictEqual(pass.activatedForPhoneKeys[phoneKey], 1);
    assert.strictEqual(plot.store.get("chamaLinks/u1/links/c2__m2").verifiedVia, "sms_code");
    assert.ok(!plot.store.has("chamaLinks/u1/links/c3__m3a"));
    await assert.rejects(() => Ch.verifyCode("u1", challengeId, code), (e) => e.details.code === "code_invalid");   // single use
  });

  await ok("post-link sync (bypass) shows both chamas, nothing pending", async () => {
    const r = await S.runSyncFor(caller, "manual", { bypassCooldown: true });
    assert.strictEqual(r.status, "ok");
    const snap = plot.store.get("chamaSnapshots/u1");
    assert.deepStrictEqual(snap.chamas.map((c) => c.chamaId), ["c1", "c2"]);
    assert.strictEqual(snap.chamas[1].onlineCollectionEnabled, false);   // no split code
    assert.strictEqual(snap.pending.length, 0);
  });

  await ok("mychama1 down: last good data is kept, status becomes stale, lastError set", async () => {
    const good = JSON.parse(JSON.stringify(plot.store.get("chamaSnapshots/u1")));
    cfg.mychamaDb = () => { throw new Error("mychama1 unavailable"); };
    const r = await S.runSyncFor(caller, "manual", { bypassCooldown: true });
    assert.strictEqual(r.status, "stale");
    const snap = plot.store.get("chamaSnapshots/u1");
    assert.deepStrictEqual(snap.chamas, good.chamas);
    assert.strictEqual(snap.lastSyncedAt, good.lastSyncedAt); assert.strictEqual(snap.lastError.code, "upstream_failure");
    assert.ok(plot.store.get("chamaSyncState/u1").leaseUntil === 0, "lease released");
    cfg.mychamaDb = () => mc;
  });

  await ok("one section failing yields partial data with null (not 0) and missing[]", async () => {
    const realCol = mc.collection;
    mc.collection = (p) => (p.endsWith("/loans") ? { where: () => ({ get: async () => { throw new Error("boom"); } }) } : realCol(p));
    await S.runSyncFor(caller, "manual", { bypassCooldown: true });
    mc.collection = realCol;
    const c1 = plot.store.get("chamaSnapshots/u1").chamas.find((c) => c.chamaId === "c1");
    assert.strictEqual(c1.dataStatus, "partial"); assert.deepStrictEqual(c1.missing, ["loans"]); assert.strictEqual(c1.loans, null);
    assert.ok(c1.contributions && c1.mgr);
  });

  await ok("member phone changes in MyChama => link needs_reverify, chama data hidden, shows pending", async () => {
    put(mc, "chamas/c2/members/m2", member("T", "+254799888777"));
    const r = await S.runSyncFor(caller, "manual", { bypassCooldown: true });
    const snap = plot.store.get("chamaSnapshots/u1");
    assert.strictEqual(plot.store.get("chamaLinks/u1/links/c2__m2").state, "needs_reverify");
    assert.deepStrictEqual(snap.chamas.map((c) => c.chamaId), ["c1"]);
    assert.strictEqual(snap.pending.length, 1); assert.strictEqual(r.status, "ok");
  });

  await ok("caller without an ID number: never_linked, no matching attempted", async () => {
    const r = await S.runSyncFor({ uid: "u2", role: "landlord", idNumber: "", verifiedPhoneE164: null }, "login");
    assert.strictEqual(r.status, "never_linked");
    const snap = plot.store.get("chamaSnapshots/u2");
    assert.deepStrictEqual([snap.chamas, snap.pending], [[], []]);
  });

  await ok("identity: tenant doc, landlord users doc (claim + uid fallback), unknown user", async () => {
    put(plot, "users/L1", { firebaseAuthUid: "L1", phone: "+254700000001", idNumber: "99887766" });
    put(plot, "tenants/T9", { idNumber: "55443322" });
    const tok = (o) => ({ uid: o.uid, token: o.token || {} });
    const t9 = await ID.resolveCaller(tok({ uid: "T9", token: { phone_number: "+254711111111" } }));
    assert.deepStrictEqual([t9.role, t9.idNumber, t9.verifiedPhoneE164], ["tenant", "55443322", "+254711111111"]);
    const l1 = await ID.resolveCaller(tok({ uid: "L1" }));
    assert.deepStrictEqual([l1.role, l1.idNumber, l1.verifiedPhoneE164], ["landlord", "99887766", null]);
    const l2 = await ID.resolveCaller(tok({ uid: "newuid", token: { role: "landlord", agentId: "L1" } }));
    assert.strictEqual(l2.role, "landlord");
    const none = await ID.resolveCaller(tok({ uid: "ghost" }));
    assert.strictEqual(none.idNumber, "");
    // PMS convention: landlord userId IS the ID number (no idNumber field needed)
    put(plot, "users/23456789", { firebaseAuthUid: "23456789", phone: "+254700000002" });
    const pms = await ID.resolveCaller(tok({ uid: "23456789" }));
    assert.deepStrictEqual([pms.role, pms.idNumber], ["landlord", "23456789"]);
    const viaClaim = await ID.resolveCaller(tok({ uid: "fb-uid-xyz", token: { role: "landlord", agentId: "23456789" } }));
    assert.strictEqual(viaClaim.idNumber, "23456789");
    // self-signup landlord: random 28-char uid is NOT an ID number
    const rnd = "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9v";
    put(plot, "users/" + rnd, { firebaseAuthUid: rnd });
    assert.strictEqual((await ID.resolveCaller(tok({ uid: rnd }))).idNumber, "");
    // a stored idNumber field wins over the doc id
    put(plot, "users/34567890", { firebaseAuthUid: "34567890", idNumber: "A1234567" });
    assert.strictEqual((await ID.resolveCaller(tok({ uid: "34567890" }))).idNumber, "A1234567");
  });

  console.log(process.exitCode ? "\nFAILED" : `\nAll ${passed} checks passed`);
})();
