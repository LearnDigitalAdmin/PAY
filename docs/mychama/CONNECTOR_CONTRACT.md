# MyChama ⇄ PAY connector — CONTRACT v1 (P0)

Base commits: **PAY `1aef012`** (the PAY HEAD at the moment P0 was applied; P0 was first cut on `6547b3a`, and `index.ts` has drifted since — P0 is applied by the rebasing script `apply-p0.mjs`, which stamps the real hash here), **Chama `1c83e40`**. Patches are applied in this order:
`P0` → `A` → `B` → `C` (A/B/C touch disjoint files, so any order after P0 works).
Gate for every patch: `git apply --check` on a tree with P0 (and, in the integration run, the other two) applied;
`cd functions && npx tsc --noEmit`; `npm run check:mychama-contract`.

## 1. Goal
1. MyChama gets its **own Paystack account** (new key, new webhook) — independent of PAY's shared account.
2. PAY landlords/tenants get a **chama connector**: auto-linked chama memberships, MyChama payments (contributions, loans, MGR), and chama-side obligation/balance data persisted in the plot project.
3. Rental data is **never read or written** by any new backend code. Deductions are computed in the *client* by combining rent totals the UI already has with the snapshot.

## 2. Ownership (who may edit what)
| Path | Owner |
|---|---|
| `functions/src/mychama/{contract,config,errors,paths,sms}.ts`, `src/mychama/{contract,api,index}.ts`, `tools/`, `docs/mychama/CONNECTOR_CONTRACT.md`, `firestore.rules.fragment` | **P0 (frozen)** — change via §10 |
| `functions/src/mychama/link/**`, `functions/src/mychama/sync/**` (+ Chama patch: `idKey`) | **Track A** |
| `functions/src/mychama/pay/**`, `functions/src/mychama/webhook/**` (incl. `handlers.ts`), `scripts/mychama/**`, `docs/mychama/cutover.md` | **Track B** |
| `src/**` (except `src/mychama/{contract,api,index}.ts`), `functions/src/auth/**`, `index.html`, `public/**` | **Track C** |
| `functions/src/index.ts` | P0 only (wiring + the moves in §3). The legacy MyChama branches and the legacy `reconcileMyChamaIntents` sweep stay in it until the final cutover patch (§11). Hardening of existing rent callables = a separate later patch |

## 3. What P0 changed in existing code (behaviour-neutral)
* `functions/src/index.ts`: the **current** MyChama payment handlers (transactional apply, idempotency inside the transaction, `paidKobo` vs `intent.grossAmount` check — i.e. whatever is in `index.ts` at apply time) + HostPinnacle SMS are **moved verbatim** to `mychama/webhook/handlers.ts` and `mychama/sms.ts`; `mychamaDb()` moved to `mychama/config.ts`; legacy `paystackCallback` still uses them (it keeps handling MyChama references until cutover). Two wiring lines `export * from "./mychama"; export * from "./auth";` are added in the import block near the top of `index.ts` (position is cosmetic — `export *` is hoisted).
* `reconcileMyChamaIntents` (the 10-minute missed-webhook sweep) **stays in `index.ts`**; the only change is that it now binds `...MYCHAMA_HP_SECRETS` instead of four inline secrets (they moved to `sms.ts`). It still verifies with the OLD key `PAYSTACK_SECRET_KEY` — see §9.
* New deployable functions (stubs return `not_implemented` / HTTP 501): `mychamaSync`, `mychamaLinkRequestCode`, `mychamaLinkVerifyCode`, `mychamaPayInitiate`, `mychamaPaystackCallback` (all `africa-south1`).

## 4. Data model (plot project) — see `contract.ts`
`chamaSnapshots/{uid}` (UI listens; client read-only) · `chamaLinks/{uid}/links/{chamaId__memberId}` (client read-only) · `chamaLinkChallenges/{id}` and `chamaSyncState/{uid}` (server only). Rules: `firestore.rules.fragment` (the plot rules file is not in this repo — merge manually).
Snapshot semantics: a section that could not be read is `null` (never `0`); `dataStatus`/`missing[]` say why; a failed sync **never wipes** the last good data (only `status`/`lastError`/`lastAttemptAt` change). `status`: `ok` | `stale` (no success for `SNAPSHOT_STALE_AFTER_SECONDS`, or last attempt failed while old data exists) | `unavailable` (never had data and mychama1 unreachable) | `never_linked` | `needs_reverify`.

## 5. Identity & linking (decided)
* Key = **ID number**. mychama1 stores `members.idNumber` but that field is **index-exempt** (Chama `firestore.indexes.json`/`INDEXES.md`), so it cannot be queried. Contract: every member doc gets **`idKey = HMAC_SHA256_hex(MYCHAMA_ID_PEPPER, "id:" + normalizeIdNumber(idNumber))`**, with a collection-group index on `members.idKey`. `normalizeIdNumber` = uppercase + strip all non-alphanumerics (see `config.ts`). Same pepper value in **both** projects. (Track A ships the Chama-side trigger + backfill + index.)
* Phone proof key = `computePhoneKey(E.164)` = HMAC(pepper, `"ph:"+e164`); phones normalised exactly like Chama `phone.py::normalize_phone`.
* Rules: (1) find all members with the caller's `idKey`; (2) **silent link** a record when the caller's *verified* Firebase phone (`request.auth.token.phone_number`) equals that member's `phoneNormalized`; (3) otherwise the record goes to `pending[]` (masked phone shown) and the user taps **Send code** → SMS code (HostPinnacle, MyChama sender) to the *MyChama-registered* phone → `mychamaLinkVerifyCode` links **only the chamas registered on that phone** (per-phone grants); (4) email/password landlords have no verified phone → always path 3; (5) no automatic SMS on login (tap-to-send, abuse limits in `MYCHAMA_LIMITS`); (6) ambiguous IDs (two members with one idKey in the *same* chama) never link — flagged; (7) a link is bound to `boundPhoneKey`; if the member's phone later stops matching → `needs_reverify`, chama data hidden until re-verified. PMS/PAY phone and MyChama phone are never edited.
* Landlord identity after Track C: Firebase Auth user with custom claims `{ role: "landlord", agentId }` (profile doc `agents/{agentId}`); tenants: `users/*` docs, `role` claim optional. Track A must resolve caller → `{uid, role, idNumber, verifiedPhone|null}` in one function (`sync/identity.ts`).

## 6. Callables (I/O in `contract.ts`)
`mychamaSync({reason, force?})` — first login forces a sync; later calls inside `SYNC_COOLDOWN_SECONDS` return stored data with `throttled:true`; manual floor `SYNC_MANUAL_COOLDOWN_SECONDS`. `mychamaLinkRequestCode({pendingId})`, `mychamaLinkVerifyCode({challengeId, code})`, `mychamaPayInitiate({...})` (self-pay only; targets validated server-side; idempotent on `clientRequestId`). Errors: `HttpsError.details = {code: MyChamaErrorCode}`; clients use `mychamaErrorCode(err)`.

## 7. Deductions boundary
Backend snapshot = chama-side numbers only (`items` with due dates, `totals.overdue/dueThisMonth/expectedInflowThisMonth`, MGR `wins`). The pure functions in `src/mychama/calc.ts` (Track C) take rent totals as **arguments** (landlord: collected rent for a period; tenant: rent + bills due) and return deductions/“need this month”. No new backend code touches rental collections.

## 8. Payments (money plane)
* References: `MCA-{chamaId}-{CNT|LNR|MGR}-{epochMs}-{rand6}` (purpose codes from Chama `IntentPurposeCode`; note loan = **LNR**). PAY-portal payments use `channel:"app"` (the Chama `IntentChannel` type only allows `whatsapp|app`) plus extra audit fields `via:"pay_portal"`, `initiatedBy:{uid,role}`.
* Intent doc = same shape as Chama `mychama/payments.py::initiatePayment` (amount NET, grossAmount, paystackFee, ourFee, currency KES, phone, provider, status pending, splitCode, expiresAt = +30 min, …). Fee engine mirrors Chama `functions/shared/money.py` / `src/lib/money.ts` (Paystack 1.5% capped KES 3000; markups: contribution/MGR 0.5%, loan per plan).
* Only the webhook marks money received (existing handlers). New account → **new webhook** `mychamaPaystackCallback`: HMAC-SHA512 of the raw body with `MYCHAMA_PAYSTACK_SECRET_KEY`, MyChama references only (`MCW- MCA- MCS- MCP- MCX- MCR-`), same handlers as legacy. Legacy `paystackCallback` keeps its MyChama branch until cutover (in-flight refs from the old account).
* Secrets: `MYCHAMA_PAYSTACK_SECRET_KEY`, `MYCHAMA_ID_PEPPER` (declared once in `config.ts`), HostPinnacle `MYCHAMA_HP_SMS_*` (declared once in `sms.ts`; **bind `...MYCHAMA_HP_SECRETS` on any function that sends SMS**).

## 9. Known facts & gotchas (verified in the repos)
* Legacy `paystackCallback` binds only `PAYSTACK_SECRET_KEY`; `sendMyChamaSms` inside `handleMyChamaPayment` is try/catch-wrapped, so the confirmation SMS has probably been **failing silently**. The new webhook must bind `MYCHAMA_HP_SECRETS`.
* The PAY repo has **no `firestore.rules`**; rules for plot live elsewhere.
* Landlords currently authenticate with a custom login stored in `localStorage` (`agentAuthUser`), profile in `agents/{id}`; tenants use Firebase phone auth. Existing rent callables take `agentId` from the client — hardening is a later separate patch.
* Split codes/subaccounts (`chama.settlementSplitCode`) belong to the **old** Paystack account and cannot be moved: they must be re-created under the new key before any MyChama charge uses the new key (Track B script / re-onboarding).
* CYBER (WhatsApp bot, not provided) creates `MCW-` intents and charges with a key: its MyChama flow must switch to the new key; its other `CYBER_` flows stay on the old account.
* `reconcileMyChamaIntents` verifies pending `MCW-`/`MCA-` intents with the OLD `PAYSTACK_SECRET_KEY`. After the key switch, Paystack (old account) returns 404 for new-account references, and the sweep retires intents older than 1 h as `expired`. A late webhook still applies (the handler does not skip `expired`), but the UI would briefly show a wrong state. Track B ships `webhook/reconcile.ts` (same logic, `MYCHAMA_PAYSTACK_SECRET_KEY`) and the cutover removes/replaces the legacy sweep (§11).
* The handlers moved by P0 are already hardened (transactional, amount check against `grossAmount`, audit log on mismatch). Track B adds only what is missing (currency, MCS/MCP/MCX/MCR amount checks).
* Repo-root `pay_security.patch` and `PAY_reports_engine_webhook.patch` are **already applied** at the base commit.

## 10. Change protocol
`contract.ts` is frozen. If a track needs a change: stop, write `CONTRACT_CHANGE_REQUEST.md` (what/why/proposed diff) in your patch notes, and continue against the *current* contract with a documented workaround. The integrator re-cuts P0 (`contract.ts` is mirrored by `tools/check-mychama-contract.mjs`).

## 11. Deploy / cutover checklist (summary — Track B writes `cutover.md`)
1. Create secrets: `MYCHAMA_PAYSTACK_SECRET_KEY` (plot + mychama1 for the Chama functions), `MYCHAMA_ID_PEPPER` (identical in plot + mychama1).
2. Deploy mychama1 (idKey trigger, backfill, index) → backfill → verify.
3. Merge rules fragment into plot rules; deploy PAY functions + hosting.
4. Re-create chama split codes under the new account; register `mychamaPaystackCallback` URL in the new Paystack dashboard (test keys first).
5. Switch Chama + CYBER MyChama flow to the new key; live smoke test; keep the legacy MyChama webhook branch **and** legacy `reconcileMyChamaIntents` until old in-flight references clear (deploy Track B's new sweep at the switch); then remove both in a final patch.
