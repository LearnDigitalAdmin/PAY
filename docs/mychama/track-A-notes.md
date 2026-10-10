# Track A — data plane: notes for the integrator

Patches: `track-A-pay-data-plane.patch` (PAY, base `9af8741`) and `track-A-chama-idkey.patch` (Chama, base `1c83e40`).
PAY files touched: `functions/src/mychama/link/**`, `functions/src/mychama/sync/**`, this note, and `functions/test/mychama-track-a.check.js`. Nothing else (no `index.ts`, no contract, no frontend).

## What was built
| Piece | Where | Notes |
|---|---|---|
| `mychamaSync` | `sync/index.ts`, `sync/service.ts` | Lease + cooldown gate in a transaction on `chamaSyncState/{uid}`; first `login` with no snapshot is forced; `manual`/`force` use the 30 s floor, auto uses 600 s; throttled calls return stored status and never touch mychama1. |
| Caller identity | `sync/identity.ts` | Reads only the caller's profile doc: tenants `tenants/{uid}`; landlords `users/{agentId}` (`agentId` = claim, else uid). Verified phone = Firebase `phone_number` token only. |
| Link engine | `link/actions.ts` (pure), `link/match.ts`, `link/engine.ts` | idKey lookup (collection group on `members.idKey`), silent link on verified-phone match, `pending[]` per MyChama phone, `needs_reverify` when a member's phone stops matching, `revoked` when the member disappears, ambiguous IDs (2 members, one ID, one chama) never link. Only `status:"active"` members link. |
| SMS code | `link/challenge.ts`, `link/index.ts` | Tap-to-send. One live challenge per (user, pending group); code stored as HMAC only; 6 digits, 10 min TTL, 5 attempts, 60 s resend cooldown, 5 sends/phone/day, 10/user/day (counters in `chamaLinkChallenges/lim_*`, server-only). Per-phone grants. `mychamaLinkVerifyCode` also runs a cooldown-bypassing sync so the snapshot is fresh when it returns. |
| Calculations | `sync/compute.ts` (pure) | Contributions, loans, MGR (due now, arrears, won + scheduled wins), totals — KES `round2`, EAT dates. |
| Chama `idKey` | Chama patch | Trigger `on_member_id_key`, `tools/backfill_id_key.py`, collection-group index, `MYCHAMA_ID_PEPPER` secret, docs, tests. The `idNumber` index exemption is untouched. |

## Behaviours worth knowing
* **Never 0 for unknown.** A section that can't be read is `null` + listed in `missing[]`; the chama gets `dataStatus: partial|unavailable`. If every linked chama is unreadable, or the link query itself fails, the sync fails as a whole: the last good `chamas[]/pending[]` are **kept**, status becomes `stale` (or `unavailable` if there never was one), `lastError` is set.
* **Staleness over time is a client decision.** The server only writes `stale` on failure. A snapshot that is simply old still says `ok` — Track C should compute `now - lastSyncedAt > SNAPSHOT_STALE_AFTER_SECONDS` (contract constant) and show "as of …".
* **MGR dates.** mychama1 stores no period/round dates (periods are closed manually), so scheduled wins have `expectedDate: null` and `expectedInflowThisMonth` is only non-zero if a future version supplies dates. Scheduled amount = pool / `recipientsPerRound` (mirrors `mgr_engine.py`); a "short round" (queue smaller than recipients) gives `amount: null`. `won` wins come from `payouts` of the pot's current cycle. "Due now" for MGR is counted in `dueThisMonth`; open arrears in `overdue`.
* **Contributions without `dueDate`** fall back to `periodKey` (before this month ⇒ overdue, this month ⇒ due this month).
* **Link doc contents:** never the ID number or a full phone — only `boundPhoneKey` (HMAC) and a masked phone.
* **Rate limits by phone** return `send_limit_reached` (same code as the per-user cap) so the response doesn't reveal that a phone is being hammered.

## Contract change request (non-blocking)
`verifyCode` reports wrong codes as an error, but `MyChamaErrorDetails` has no field for the attempts left, so the error `details` carries an **extra key** `remainingAttempts: number` next to `code` (only for `code_invalid`). Track C can read it via `(err as any).details.remainingAttempts` today. Proposed P0.1: add `remainingAttempts?: number` to `MyChamaErrorDetails` (and update the frontend copy). `VerifyCodeResponse.remainingAttempts` is never set by Track A (success has nothing remaining to report).

## Findings the integrator must act on
1. **Landlord ID = `users/{userId}` (PMS convention, confirmed by the owner).** The resolver uses the `users` doc id as the landlord's ID number when it looks like one (5–12 alphanumerics); a stored `idNumber` field, if present, wins; self-signup landlords with a random 28-char Firebase uid are skipped (`never_linked`). Track C/PMS must keep the `agentId` custom claim equal to that `userId`. The phone proof (verified phone or SMS code to the MyChama phone) is what protects the data, so even a forged doc id cannot expose a chama.
2. **Landlord Firebase Auth users already exist** for accounts made by `createUserWithFirebaseAuth` (uid = `localId`/doc id, with email/phone/password) — the custom `localStorage` login just doesn't use them. Track C's migration may be simpler than its prompt assumes; Track A's resolver already accepts "uid == users doc id".
3. **Ordering:** deploy the Chama patch first (trigger + index), run the backfill, wait for the `idKey` index to finish building, **then** deploy PAY — otherwise the collection-group query fails (the sync then reports `unavailable`/`stale`, it does not crash).

## Deploy checklist (Track A only)
1. `firebase functions:secrets:set MYCHAMA_ID_PEPPER` in **both** projects with the **same** value (use a long random string).
2. Chama: `firebase deploy --only functions:on_member_id_key,firestore:indexes` (or your usual deploy); then `MYCHAMA_ID_PEPPER=… python tools/backfill_id_key.py` (dry run) and `--apply`.
3. Merge `docs/mychama/firestore.rules.fragment` into the plot rules.
4. PAY: deploy `mychamaSync`, `mychamaLinkRequestCode`, `mychamaLinkVerifyCode` (the pepper and `MYCHAMA_HP_SMS_*` secrets must exist in the PAY project).
5. The PAY default service account needs read access to mychama1 Firestore (already granted for the payment handlers).

## Tests run
* `python functions/tests/test_id_key.py` (Chama): 7 vectors + pepper sensitivity — pass.
* `cd functions && npm run build && node test/mychama-track-a.check.js` (PAY): **19 checks pass** — pure compute and link-action logic, plus an end-to-end run against an in-memory fake Firestore (first-login silent link, ambiguous/removed members excluded, cooldown throttling, SMS code request/resend/wrong-code/lockout/single-use, per-phone grant, post-link refresh, mychama1 outage keeps last good data, partial sections, phone change ⇒ needs_reverify, no-ID caller, identity resolution).
* **Cross-language idKey vectors** — Node `computeIdKey` and Python `compute_id_key` agree on all of these (pepper `test-pepper-123`):

| input | normalised | idKey (hex) |
|---|---|---|
| `12345678` | `12345678` | `5f2b4873088e9d4ee7cb39de1b6f4723ba83bed014d882f445fc4b1e4a487d92` |
| `12 345-678` | `12345678` | `5f2b4873088e9d4ee7cb39de1b6f4723ba83bed014d882f445fc4b1e4a487d92` |
| `a1234567` | `A1234567` | `cc0d2069f3bb9ab2a64e6766739737d4c8cb6352e158ee4eebbc14cf8a342fdc` |
| ` 0012.3456 ` | `00123456` | `d3286373afc9a2dde04e1ed56437c3088b820d5d2d2bab9c48459139b5a8b896` |
| `K-1234 567` | `K1234567` | `8a11729bb5c2011f3ac0d43820ee9fc3995e567c5d8614ca7c154910af94ae21` |
| `` / `!!!` | `` | `` (empty) |

## Not verified here
No Firebase emulator or live project was available in this environment, so nothing ran against real Firestore/Functions/SMS. Real-Firestore behaviours to watch on first deploy: the `idKey` collection-group index build time, transaction contention on `chamaSyncState` (not expected), and HostPinnacle delivery of the code SMS.
