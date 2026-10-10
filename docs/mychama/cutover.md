# MyChama → new Paystack account: cutover runbook (Track B)

Applies after patches P0, A, B, C are merged. **PAY/plot project** = the PAY Firebase project (`{{PLOT_PROJECT}}`);
**mychama1** = the Chama Firebase project. Commands marked `[plot]` / `[mychama1]` run against that project.

## 0. What is changing, in one paragraph
MyChama gets its own Paystack account. Every MyChama charge (Chama app, CYBER WhatsApp bot, PAY portal) must use the **new**
key and a **new-account split code**; Paystack sends the new account's events to the **new webhook** `mychamaPaystackCallback`
(PAY project). The old account keeps working for old in-flight references through the legacy `paystackCallback` and the legacy
`reconcileMyChamaIntents` sweep until they are deleted (§9). Nothing in rent/PMS code changes.

## 1. Facts that shape the order (verified in the repos)
| Fact | Consequence |
|---|---|
| Chama already reads the key from secret `MYCHAMA_PAYSTACK_SECRET_KEY` in all four money modules (`payments.py`, `billing.py`, `sms.py`, `reports.py`) | Switching Chama = **new secret version + redeploy**, no code change for the key itself |
| A split code only works for the Paystack account that created it | Every chama needs a **new split** before any charge uses the new key (§4) |
| Chama's STK charge sent `splitCode` only in `metadata`, not as `split_code` (CYBER always sent it) | `track-B-chama.patch` sends `split_code`. **Without it nothing is routed to the chama subaccount** |
| Chama's plan-billing sends `metadata.toPlan`; the legacy webhook read `metadata.plan` | Paid plan upgrades were silently dropped. Fixed in the shared handler (applies to the legacy webhook too, the moment PAY functions deploy) |
| Legacy webhook binds no HostPinnacle secrets | Confirmation SMS has probably been failing. `mychamaPaystackCallback` binds `...MYCHAMA_HP_SECRETS` |
| `reconcileMyChamaIntents` (legacy) verifies with the OLD key | After the switch it gets 404 for new references and expires them after 1 h. `reconcileMyChamaIntentsV2` + the cutover timestamp cover the new ones (§5) |

## 2. Prerequisites (before the maintenance window)
1. New Paystack account is KYC-complete for **Kenya mobile money (M-Pesa + Airtel)** and live keys exist.
2. **Confirm the settlement bank codes** with Paystack for the new account (`GET /bank?country=kenya`). Chama's
   `PAYBILL_BANK_CODE`/`TILL_BANK_CODE` are placeholders (`"MPESA"`, marked "go-live blocker" in `payments.py`). If the real codes differ,
   pass them to the migration script (`--paybill-bank-code`, `--till-bank-code`). **Do not go live on the placeholder unconfirmed.**
3. `MYCHAMA_ID_PEPPER` identical in both projects; Track A deployed (idKey trigger + backfill + index) and verified.
4. `functions/` builds clean: `cd functions && npx tsc --noEmit && npm run build`, `npm run check:mychama-contract`,
   `node scripts/mychama/test-fees.mjs`, `node scripts/mychama/test-money-plane.mjs`, `node scripts/mychama/test-migrate.mjs`.
5. Announce a 30-minute low-traffic window (early Sunday morning, Nairobi time).

## 3. Test-key rehearsal (do this first, end to end, with `sk_test_…`)
Run §4–§7 against a **staging pair** (or the real projects with the new account's *test* key and test-mode webhook), using a test
chama. Pass criteria: dry-run report clean; migrated chama has `settlementSplitKeyVersion: 2`; a PAY-portal payment, a Chama-app
payment and a CYBER payment each end `status: "success"` with the contribution applied **once**; a cancelled STK ends `failed`; a
replayed webhook (Paystack dashboard → resend) changes nothing. Only then repeat with live keys.

## 4. Secrets, deploy, webhook registration, split migration (no customer impact yet)
1. **Secrets** (`firebase functions:secrets:set NAME --project …`):
   - `[plot]` `MYCHAMA_PAYSTACK_SECRET_KEY` = **new** key · `MYCHAMA_ID_PEPPER` · `MYCHAMA_HP_SMS_USERID|PASSWORD|APIKEY|SENDERID`
   - `[mychama1]` `MYCHAMA_ID_PEPPER`. **Do not touch `MYCHAMA_PAYSTACK_SECRET_KEY` in mychama1 yet** — it still holds the OLD key and any
     Chama redeploy would pick up a new version. Freeze Chama deploys from now until §6.
2. **Deploy PAY functions + hosting** `[plot]`. Safe at this point: `mychamaPayInitiate` refuses every chama (no `settlementSplitKeyVersion: 2` yet),
   `reconcileMyChamaIntentsV2` idles (no cutover doc), `mychamaPaystackCallback` only answers events signed with the new key.
   Merge `firestore.rules.fragment` into the plot rules first (P0 §11).
3. **Register the webhook** in the **new** Paystack dashboard → Settings → API Keys & Webhooks → webhook URL
   `https://africa-south1-{{PLOT_PROJECT}}.cloudfunctions.net/mychamaPaystackCallback` (test URL field for test mode, live URL for live).
   Check: `curl -i -X POST <url> -d '{}'` → **400** (bad signature); `curl -i <url>` → **405**.
   Leave the **old** account's webhook URL (legacy `paystackCallback`) registered.
4. **Migrate splits** `[mychama1]` (Application Default Credentials):
   ```
   node scripts/mychama/migrate-splits.mjs --dry-run --report dry.json
   MYCHAMA_PAYSTACK_NEW_KEY=sk_live_… node scripts/mychama/migrate-splits.mjs --apply --confirm-bank-codes --report apply.json
   ```
   (`--confirm-bank-codes` only if you accept the placeholder; otherwise pass the real codes.) Re-run until no `failed`. Each migrated chama keeps
   its old code in `legacySettlementSplitCode` and gets `settlementSplitKeyVersion: 2`.
   **`needs_reonboarding`** = bank-type accounts whose `bankCode` was never stored. Those chamas cannot pay online until their chair and another
   official re-submit settlement details with `requestSettlementChange` → `approveSettlementChange` **after** Chama runs on the new key (§6).
   Notify those chairs. PAY and Chama both refuse (`online_collection_disabled`) for them meanwhile.

## 5. The two sweeps never fight
`reconcileMyChamaIntentsV2` only acts on intents with `createdAt ≥ cutoverAt`, where `cutoverAt` lives in the **plot** project at
`mychamaConfig/cutover` (`{ cutoverAt: <epoch ms> }`). Missing doc ⇒ V2 does nothing. Intents with `applyBlockedAt` (a permanent amount/currency
mismatch awaiting a human) are skipped by V2. The legacy sweep cannot be edited, so after the switch it still scans new intents, gets 404
from the old account and may mark a never-confirmed intent `expired` after 1 h — the same outcome V2 would reach; a genuine payment is applied by the webhook or
by V2 within 10 minutes, and the handler applies even to an `expired` intent.

## 6. Cutover (inside the window, in this order)
1. `[mychama1]` set the new secret version: `firebase functions:secrets:set MYCHAMA_PAYSTACK_SECRET_KEY --project mychama1` (paste the **new** key).
2. Apply `track-B-chama.patch` to Chama and deploy: `firebase deploy --only functions --project mychama1`. This switches the key **and** turns on the
   guard (`settlementSplitKeyVersion` must be 2) and sends `split_code`. Because every migrated chama already has the marker, payments keep flowing.
3. CYBER: create the `MYCHAMA_PAYSTACK_SECRET_KEY` secret, apply `track-B-cyber.patch`, deploy (see `docs/mychama/cyber-key-swap.md`).
4. `[plot]` `node scripts/mychama/set-cutover.mjs --project {{PLOT_PROJECT}} --apply` — **last**, right after the deploys finish.
5. Re-onboard `needs_reonboarding` chamas (their officials use the app; the new account creates the subaccount+split and writes the marker).

In-flight window: an intent created between 2–3 and 4 uses the new key and is handled by the **new webhook**; one created before 2 uses the old key and is
handled by the **old webhook** (still registered) + legacy sweep. Both webhooks stay live, so no payment is lost either way.

## 7. Smoke tests (live, small amounts — KES 10–20)
- [ ] Wrong signature → 400; old-key-signed body → 400 (`curl` or Paystack "resend" from the old account to the new URL).
- [ ] **PAY portal**: linked tenant pays a contribution → STK → `paymentIntents/{ref}` `success`, contribution applied once, `transactions/{ref}` written, **confirmation SMS received** (proves the HP secrets).
- [ ] **Chama app** payment and **CYBER (WhatsApp)** payment succeed; funds show under the chama's subaccount on the new account's dashboard (proves `split_code`).
- [ ] Cancel an STK → intent `failed` (via `charge.failed`).
- [ ] Resend the success event from the Paystack dashboard → nothing changes (idempotent).
- [ ] Plan upgrade (MCP) and SMS top-up (MCS) each apply once.
- [ ] Logs: `reconcileMyChamaIntentsV2` runs every 10 minutes; no `NOT applied` lines except expected tests.

## 8. Rollback
Before step 6.4 nothing customer-facing changed except the key; after it:
1. `[mychama1]` re-set `MYCHAMA_PAYSTACK_SECRET_KEY` to the **old** key; redeploy the **previous** Chama release (without `track-B-chama.patch`).
2. Restore split codes **before** traffic resumes: `node scripts/mychama/migrate-splits.mjs --rollback --apply` (puts `legacySettlementSplitCode` back, removes the marker). The old key must never meet a new-account split code.
3. Revert CYBER to its previous release.
4. Keep the cutover doc and **keep the new webhook registered ≥ 24 h** so new-account in-flight payments still apply; then `set-cutover.mjs --clear --apply`.
5. PAY portal payments stay refused for rolled-back chamas (no marker) — expected.

## 9. Delete afterwards (description only — NOT applied by Track B)
Do this once: (a) no `paymentIntents` with `status:"pending"` and `createdAt < cutoverAt` remain in any chama, and (b) the old Paystack account has shown no
MyChama (`MC*-`) webhook traffic for ≥ 72 h. Both in `functions/src/index.ts`:
1. **The legacy MyChama branches of `paystackCallback`** (≈ lines 2073–2086): the `else if (chargeType === 'mychama_payment' || reference.startsWith('MCW-') || reference.startsWith('MCA-'))` branch and the MCS/MCP/MCX/MCR branches below it (all the `handleMyChama*` calls), the MyChama classification line in the reference→type helper (≈ line 563), and the MyChama prefix branch of the `charge.failed` handling (≈ line 2179, the `MCW-/MCA-/MCS-/MCP-/MCX-/MCR-` condition).
2. **The legacy `reconcileMyChamaIntents` sweep** (≈ lines 583–640, the whole `onSchedule` export) — verify it with the old key and is superseded by `reconcileMyChamaIntentsV2`.
3. Now-unused imports at the top (≈ lines 41–49: `mychamaDb`, `MYCHAMA_HP_SECRETS`, the five `handleMyChama*`) — keep any still used elsewhere.
4. Optional: drop the `createdAt >= cutoverAt` guard from `webhook/reconcile.ts` and delete `mychamaConfig/cutover`.
5. Close the old account's MyChama webhook entry; remove `legacySettlementSplitCode` fields after the old account's subaccounts are archived.

## 10. Open items for other tracks / the integrator
- **Track A/C**: the snapshot's "online collection enabled" must also require `settlementSplitKeyVersion === 2` (plan + split code alone will say yes for an un-migrated chama; payment then fails with `online_collection_disabled`).
- **Contract gap (§10 change request)**: there is no generic `invalid_request` code. `mychamaPayInitiate` uses `invalid_target` for a missing/malformed `chamaId`, `purpose`, `clientRequestId` or id. Proposed: add `invalid_request`.
- **Role**: `initiatedBy.role` is `"landlord"` iff the `role` custom claim says so, else `"tenant"` (Track A's `sync/identity.ts` is off-limits to Track B).
- **Rounding**: `pay/fees.ts` reproduces Python's round-half-even (the code that creates the charge). Chama's `src/lib/money.ts` uses `Math.round`, so a quote can differ by KES 0.01 when gross×100 is exactly x.5.
- **Mobile-money limit**: self-pay refuses a gross charge above KES 250,000 (`MAX_GROSS_KES` in `pay/fees.ts`) — adjust if Safaricom/Paystack limits differ for your account.
- **Idempotency**: the key is per chama, not per member; `mychamaPayInitiate` verifies the stored result belongs to the caller before replaying it, and takes over a `pending` placeholder older than 3 minutes. Chama's Python still leaves a `pending` key behind when its Paystack call fails.
