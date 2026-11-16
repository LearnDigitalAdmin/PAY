# CORE (PAY backend) for standalone Lipa Mdogo Mdogo: deploy notes

Patches (made against PAY `400c8744` and PMS `dfccf1ab`, branch main):
- `lmmx-core-pay.patch`  : PAY `functions/**`, `scripts/`, this file
- `lmmx-core-pms-indexes.patch` : PMS `firestore.indexes.json` only (the project's Firestore indexes live in the PMS repo)

## 1. Apply and check (nothing is deployed yet)
```bash
cd PAY && git apply --check lmmx-core-pay.patch && git apply lmmx-core-pay.patch
cd ../PMS && git apply --check lmmx-core-pms-indexes.patch && git apply lmmx-core-pms-indexes.patch
cd ../PAY/functions && npm ci && npm run build
node test/lmmx.check.js && node test/lmm.check.js && node test/lmm-flow.check.js && node test/no-env-credentials.check.js
```
Expected: 36 / 19 / 28 passed and `no-env-credentials: OK`. (`test/desk-webhooks.check.js` has 1 failure on the untouched base commit too, about a MyChama commission; it is not caused by this work.)

## 2. Secrets (one time; prints key names only, never values)
```bash
cd PAY && bash scripts/lmmx-secrets.sh        # needs gcloud logged in; adds LMMX_HASH_PEPPER, LMMX_OTP_PEPPER, LMMX_FIELD_KEY, LMMX_QUOTE_KEY, LMMX_BOT_KEY if missing
```
`LMMX_BOT_KEY` is the key the WhatsApp bot signs with. It lives in the same bundle, so the bot (DESK `functions`) reads it as `bundleSecret("LMMX_BOT_KEY")` with no extra step. Never change LMMX_HASH_PEPPER or LMMX_FIELD_KEY after tenants exist.

## 3. Indexes (from the PMS repo; takes a few minutes to build, wait until they are READY)
```bash
cd PMS && firebase deploy --only firestore:indexes --project plot-9fd6e
```
No Firestore rules change is needed: the rules end with "every other path is denied by default", so every new `lmm_tenants`, `lmm_pay_records` and `lmmx_*` collection is closed to clients.

## 4. Functions (from the PAY repo root; batches of 3 with retries, exactly like the existing script)
```bash
cd PAY && bash deploy-batches.sh lmmx_desk_checkRecipient lmmx_desk_createTenant lmmx_desk_setupStatus lmmx_desk_confirmSetup lmmx_desk_resendOtp lmmx_desk_listTenants lmmx_desk_getTenant lmmx_desk_requestChange lmmx_desk_confirmChange lmmx_desk_cancelChange lmmx_desk_earnings lmmx_desk_preview lmmx_desk_pipeline lmmx_top_reviewQueue lmmx_top_reviewDecision lmmx_top_freeze lmmx_top_unfreeze lmmx_top_reassign lmmx_top_reveal lmmx_top_updateTenant lmmx_top_auditList lmmx_top_auditVerify lmmx_top_leadsList lmmx_top_leadGet lmmx_top_leadUpdate lmmx_top_stats lmmx_tenant_link lmmx_tenant_summary lmmx_tenant_history lmmx_tenant_quote lmmx_tenant_pay lmmx_tenant_setDueDay lmmx_tenant_setPlan lmmx_tenant_confirmSetup lmmx_tenant_confirmChange lmmx_tenant_cancelChange lmmx_bot_lookup lmmx_bot_quote lmmx_bot_pay lmmx_bot_joinInfo lmmx_bot_confirmCode lmmx_dailySweep lmmx_settlementWorker lmmx_reconcileDaily lmmx_auditAnchor lmm_dailySweep paystackCallback
```
That is the 41 callables, 4 schedulers, `paystackCallback` (the Paystack webhook, now also routes `LMX_` charges and `lmx-` transfers) and `lmm_dailySweep` (its SMS text is rebranded). Preview first with `DRY_RUN=1 SKIP_BUILD=1 bash deploy-batches.sh <same names>`.

## 5. Seed the switch (feature stays OFF)
```bash
cd PAY/functions && gcloud auth application-default login && GOOGLE_CLOUD_PROJECT=plot-9fd6e node scripts/lmmx-seed.js
```

## 6. Check these before you switch it on
1. **Paystack transfer fee:** the fee table is copied from your confirmed Paystack Kenya page (wallet 20/40/60, till 40/80/140/180, bank 80/120/140). The reserve adds a x1.2 uplift for excise and KES 5 (`TRANSFER_UPLIFT_BPS`, `TRANSFER_BUFFER_MINOR` in `functions/src/lmmx/contract.ts`; they live in the shared contract, so a change goes through a contract change request). Look at one real transfer fee line on the Paystack dashboard; if it is already inclusive of excise, tell me and I will issue contract v1.1.
2. **Recipient formats:** M-PESA phone recipients are created with the national format (`0712345678`) and tills with digits only. Create ONE test recipient with a number you own and confirm Paystack accepts it (the legacy flow already does the same for landlords). Bank name resolution uses `/bank/resolve`; if Paystack Kenya does not resolve, the name match shows "unavailable" and the first-payout guard still applies.
3. **Transfer confirmation:** Paystack must NOT ask for an OTP on transfers (same setting the legacy flow needs); otherwise you get an `OTP_REQUIRED` alert.
4. **Support phone:** `SUPPORT_PHONE` in `functions/src/lmmx/config.ts` is `0791286165` (the ops alert number). Change it if tenants should call another number, then redeploy.
5. **Holidays:** the pay-by date uses `config/kenya_holidays.dates` (the same document the rent settlement reads).
6. **Desks need a payout account:** a desk creates tenants only when its `agents/{uid}.paymentInfo.accountId` starts with `ACCT_` (otherwise `LMMX_E_DESK_NOT_READY`).

## 7. Staged switch-on
```bash
cd PAY/functions && GOOGLE_CLOUD_PROJECT=plot-9fd6e node scripts/lmmx-seed.js --enable
```
Then, as COG-0000: register a test tenant with your own phone and a landlord account you own (rent KES 1,000), confirm with the code (or send it to the bot), pay KES 10, and watch `lmmx_cycles`. The first payout to any new landlord account is held until 48 hours after the account was created and 24 hours after the landlord notice (by design), so a test payout shows `held:first_payout_window` at first. `lmmx_top_auditVerify` should return ok.

## 8. Operations
- Pause every standalone payout at once: `node scripts/lmmx-seed.js --pause` (`--resume` undoes it). Switch the feature off for new activity: `--disable` (money already credited still pays out).
- Freeze one tenant, landlord account or desk: top-desk screen (`lmmx_top_freeze`), reason required, audited.
- Nightly `lmmx_reconcileDaily` checks every live cycle adds up and Paystack holds at least what is owed; a mismatch pauses payouts and texts the ops number.
- The audit trail is hash-chained: `lmmx_top_auditVerify` recomputes it; `lmmx_auditAnchor` records the head every night.

## 9. What changed in existing files
- `functions/src/index.ts`: exports `./lmmx`; the Paystack webhook routes `LMX_` charges (`handleLmmxCharge`), failed `LMX_` charges, and `lmx-` transfer events (`handleLmmxTransfer`); bad-signature alert also covers the new prefixes.
- `functions/src/lmm/sms.ts`, `lmm/index.ts`, `lmm/settle.ts`: user-facing text "Lipa Mos Mos" -> "Lipa Mdogo Mdogo" (no behaviour change); `test/lmm.check.js` and `test/lmm-flow.check.js` updated to match; `test/lmm-fake-firestore.js` gained `>=` and `<=`.
- New: `functions/src/lmmx/*` (contract.ts is the shared contract, byte-identical to `lmmx.contract.ts`), `functions/test/lmmx.check.js`, `functions/scripts/lmmx-seed.js`, `scripts/lmmx-secrets.sh`.

## 10. Where this differs from the contract (Contract Change Requests, already handled)
- CCR-1: no `lmmxTenantId` custom claim is set. The tenant is found by `authUid` stored on the tenant at `lmmx_tenant_link` (safer: it cannot go stale). `lmmx_tenant_link` also creates the `tenants/{uid}` profile (role tenant) when missing, as the contract said.
- CCR-2: `lmmx_bot_lookup` finds a legacy tenant with a collection-group query on `tenants.localId` (an index for it already exists in PMS).
- CCR-3: `lmmx_top_leadUpdate` and `lmmx_top_leadGet` do not need a written reason from the UI (the CRM is routine); they still need COG-0000 and a recent sign-in, and are audited.
- CCR-4: landlord and migration detection runs in the daily sweep (10:00) rather than on every `users/*` write, so a landlord joining Plot Yangu is noticed within a day.
- CCR-5: a desk's frozen state is a lock document checked on every desk call (`LMMX_E_FROZEN`).
