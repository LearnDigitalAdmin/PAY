# LMMX pricing v2.1: lower tenant fees, desks still paid

What changed (in the shared contract, 4 identical copies):
- `SERVICE_BANDS` 6 / 4 / 3 / 2 / 1.5 %  ->  4 / 3 / 2 / 1.5 / 1 %
- `DESK_SHARE_BPS` 6000 -> 7500 (desk keeps 75% of the service fee, platform 25%)
- UNCHANGED on purpose (safe for excise): transfer reserve = Paystack cost x 1.2 + KES 5; Paystack 1.5% collection gross-up.
- The landlord is still sent EXACTLY the rent credited (`lmmx/settle.ts`, untouched).

## 1. Apply, build, test (PAY repo root)
```bash
git apply --check lmmx-pricing-pay.patch && git apply lmmx-pricing-pay.patch
node tools/check-lmmx-contract.mjs
cd functions && npm run build && node test/lmmx.check.js && node test/lmm.check.js && node test/lmm-flow.check.js && node test/no-env-credentials.check.js
```
Expected: 46 / 19 / 28 passed, `no-env-credentials: OK`.

## 2. Deploy ONLY the functions that price (PAY repo root, nothing else is redeployed)
```bash
# preview first
DRY_RUN=1 SKIP_BUILD=1 bash deploy-batches.sh lmmx_tenant_quote lmmx_tenant_pay lmmx_bot_quote lmmx_bot_pay lmmx_desk_preview lmmx_desk_getTenant
# then for real
bash deploy-batches.sh lmmx_tenant_quote lmmx_tenant_pay lmmx_bot_quote lmmx_bot_pay lmmx_desk_preview lmmx_desk_getTenant
```
Why these six: quotes and payments (`makeQuote`, `startPayment`: tenant app and WhatsApp bot) and the desk earnings table / projection (`lmmx_desk_preview`, `lmmx_desk_getTenant`).
Deploy the quote and pay functions together: a quote signed by the old code (valid 10 minutes) is rejected by the new `pay` and the tenant just asks for a new price.
NOT needed: `paystackCallback` and the schedulers (they only read amounts already stored on each payment), `lmmx_desk_earnings` (sums stored shares), `lmm_*` (Lipa Mos Mos is a different rule, untouched).

## 3. Screens (previews use the same contract)
```bash
# PAY repo: tenant app preview (PayPanel) shows the new price before the server quote
npm run build && firebase deploy --only hosting --project plot-9fd6e
# DESK repo: desk fallback estimate (only used if the server call fails)
cd ../DESK && npm run build && firebase deploy --only hosting --project plot-9fd6e
```
DESK `functions/` (WhatsApp bot) need NO redeploy: the bot asks PAY for its price; its copy of the contract is only used by mock mode and tests.

## 4. Roll back
`git apply -R lmmx-pricing-pay.patch` and the same function deploy in section 2.
