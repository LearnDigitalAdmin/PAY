# TRACK A — Data plane (linking + sync + snapshot) — PROMPT

You are **Track A** of three AIs building the MyChama⇄PAY connector in parallel. Tracks B (money plane) and C (experience) work on disjoint files; a foundation patch **P0** already fixed every shared contract. Your output must drop in next to theirs without conflicts.

## Repos & base
* **PAY** (company payments hub, TypeScript, Firebase Functions v2, region `africa-south1`) at commit `1aef012`, with **P0 applied** (the rebased `mychama-connector-P0-foundation.v2.patch`, produced by `apply-p0.mjs`; `git apply` it on that base).
* **Chama** (MyChama app, Python Cloud Functions, project `mychama1`) at commit `1c83e40` — you ship one small patch here.
**Read first, fully:** `docs/mychama/CONNECTOR_CONTRACT.md` and `functions/src/mychama/contract.ts`. `contract.ts`, `config.ts`, `errors.ts`, `sms.ts`, `paths.ts` are FROZEN (use them; don't edit). If you truly need a change, follow §10 of the contract (write `CONTRACT_CHANGE_REQUEST.md`, keep going with a workaround).

## Deliverables (two patches, `git diff` format, applyable with `git apply`)
1. `track-A-pay-data-plane.patch` (PAY) — touches ONLY `functions/src/mychama/link/**` and `functions/src/mychama/sync/**` (new files + replacing the P0 stub bodies; keep the exported function names and request/response types).
2. `track-A-chama-idkey.patch` (Chama) — touches ONLY: a new Firestore trigger + backfill, `functions/shared/secrets.py` (add `MYCHAMA_ID_PEPPER`), `firestore.indexes.json`, and the docs (`docs/ARCHITECTURE.md`, `INDEXES.md`, `TOUCH_BASE.md` — short notes). Do NOT remove the `members.idNumber` index exemption.
Also deliver `docs/mychama/track-A-notes.md` (inside the PAY patch): manual test matrix + emulator steps + anything the integrator must know.

## What to build
### A1. Chama: `idKey` on member docs
* Why: `members.idNumber` is index-exempt, so PAY cannot query it. Add `idKey = HMAC_SHA256_hex(pepper, "id:" + normalizeIdNumber(idNumber))` on every `chamas/{c}/members/{m}` doc; `normalizeIdNumber` = uppercase and strip every non-alphanumeric. **Byte-for-byte identical** to `functions/src/mychama/config.ts::computeIdKey` — ship shared test vectors (≥5 incl. spaces/hyphens/lowercase/passport-style IDs) in both patches' notes.
* Firestore trigger (Python, 2nd gen `on_document_written`, same `REGION`/secret conventions as the repo) that sets `idKey` (and removes it if `idNumber` is empty). Write only when the value changes (no trigger loops). CYBER also writes members, so a trigger (not call-site changes) is required.
* One-off backfill (admin-only callable or `scripts/` Python run with ADC) — idempotent, batched, dry-run flag, logs counts. Never log raw ID numbers.
* Index: single-field **collection-group** index on `members.idKey` (ASCENDING) in `firestore.indexes.json`.
### A2. PAY: caller identity (`sync/identity.ts`)
`resolveCaller(request) → {uid, role, idNumber, verifiedPhoneE164|null}`. Tenants: PAY profile docs in `users/*` (inspect `createUserWithFirebaseAuth` for the exact doc id/fields); landlords: `agents/{agentId}` where `agentId` comes from the custom claim set by Track C (`{role:"landlord", agentId}`). Verified phone = `request.auth.token.phone_number` only. Read ONLY profile docs (ID number, phone) — never rent/payment/booking collections.
### A3. PAY: linking (`link/*`)
Implement exactly the rules in contract §5: match by `idKey` via collection-group query on mychama1 (`mychamaDb()`, read-only), silent-link on verified-phone match, `pending[]` for other phones (stable opaque `pendingId`, masked phone, `chamaCount`), `mychamaLinkRequestCode` (tap-to-send; HostPinnacle via `sendMyChamaSms`; **bind `...MYCHAMA_HP_SECRETS`**; SMS text e.g. "Samuhia Payments: your MyChama linking code is 123456. Valid for 10 minutes. Never share it."), `mychamaLinkVerifyCode`. Security: 6-digit CSPRNG code, store only an HMAC, constant-time compare, TTL, `CODE_MAX_ATTEMPTS`, resend cooldown, per-phone/day and per-user/day send caps (counters in server-only docs, transactional), challenge deleted on success, never reveal the full phone or the ID number, ambiguous-ID handling, per-phone grants only (a verified phone links only chamas registered on that phone), `boundPhoneKey` binding and `needs_reverify` transitions. Links are written under `chamaLinks/{uid}/links/{chamaId__memberId}`.
### A4. PAY: sync (`sync/*`) — `mychamaSync`
* Auth required. Cooldown/lease via `chamaSyncState/{uid}` (transactional; concurrent calls must not double-sync). `reason:"login"` with no prior snapshot ⇒ forced. Respect `SYNC_COOLDOWN_SECONDS` / `SYNC_MANUAL_COOLDOWN_SECONDS`; throttled calls return stored status without touching mychama1.
* Order: resolve identity → refresh links (run the silent-link pass; re-check `boundPhoneKey` ⇒ `needs_reverify`) → for each ACTIVE link read member/chama/contributions/loans/MGR from mychama1 → write `chamaSnapshots/{uid}` (`ChamaSnapshotDoc`).
* Per-section `try/catch`: a failing section ⇒ that field `null` + `missing[]` + `dataStatus:"partial"|"unavailable"`; never `0`. If everything fails: keep the last good `chamas[]`, update only `status/lastAttemptAt/lastError` (`stale` if old data exists, else `unavailable`).
* Data to compute (all KES, `round2`, dates in Africa/Nairobi): **contributions** (unpaid/partial for the member, capped at `SNAPSHOT_MAX_ITEMS_PER_LIST`); **loans** (active/disbursed loans: outstanding = sum of unpaid installment amounts, next installment, remaining count — mirror Chama `shared/loan_schedule.py`); **MGR** per pot where the member is in `memberIds`: current-period paid? (`records`), `dueNow`, open `arrears` (use the arrear id), `nextDueDate`, and **wins** — `won` from `payouts` (this member, current cycle) and `scheduled` from `queue` position × `recipientsPerRound` × `frequency` (mirror `shared/mgr_engine.py::pool_for_round/pool_estimate`; if the amount/date can't be known set `null` — never guess). `onlineCollectionEnabled` = plan has `onlineCollection` (Chama `constants.PLANS`) **and** `settlementSplitCode` present. Totals per contract (`overdue`, `dueThisMonth`, `expectedInflowThisMonth`; no double counting).
* Read only from mychama1. **Never write to mychama1** (your only mychama1 change is the Chama patch). **Never read or write rental data.**

## Hard rules
* Files outside `link/**`, `sync/**` are off-limits (other tracks own them); don't touch `functions/src/index.ts`, the contract, or frontend.
* No new npm dependencies unless unavoidable (then list them explicitly).
* Don't log ID numbers, full phones, codes, or keys.
* Keep pure logic (id/phone normalising, totals, MGR wins, date maths) in side-effect-free modules so they are unit-testable.

## Acceptance (run and paste results in your notes)
`cd functions && npx tsc --noEmit` · `npm run check:mychama-contract` · `git apply --check` on a P0-only tree and again with B and C applied · cross-language `idKey` vectors match · emulator walkthrough: silent link, pending → code → verify, wrong-code lockout, cooldown, partial/unavailable data.
