# Accounting v2 (PAY side): new rent fee schedule, cost contract, billing callable

What changed in PAY
- Platform fee on rent by plan: free 0.75 | solo 0.50 | business 0.40 | pro 0.25 | enterprise 0.15 (was 0.95 / 0.95 / 0.65 / 0.40 / 0.20). The Starter plan has no row: legacy `starter` / `low` pay the Free rate.
- Every rent transaction now carries `collectionCostMinor` and `feeVersion: 2` (same number as `deductionsMinor`, named for who bears it: the account holder, i.e. an agency takes it out of its commission).
- New read-only callable `pmsAccountingBilling`: the signed-in account holder's own plan and SMS payments, for the agent's expense accounts.
- Landlord Watch estimate path: commission is on rent actually collected, rent-first (a part-paid invoice no longer counts its full rent). Same rule as the PMS engine.

## 1. Apply, build, test (PAY repo root)
```bash
git apply --check pay-accounting-v2.patch && git apply pay-accounting-v2.patch
cd functions && npm ci && npm run build
for t in rent-flat-split desk-money rent-settlement desk-rentbatch landlord-watch-calc landlord-watch-service pms-billing; do node test/$t.check.js || break; done
```
Expected: 8 / 16 / 12 / 9 / 19 / 17 / 6 passed. (`desk-webhooks` has one failing MyChama commission test that fails the same way before this patch: unrelated.)

## 2. Deploy ONLY the affected functions (PAY repo root; the other 90+ are not redeployed)
```bash
FUNCS="processPayment setupAccount desk_runRentBatch pmsAccountingBilling lwGetSnapshot lwTranscriptStart lwTranscriptPay lwTranscriptVerifyOtp lwTranscriptStatus lwBotApi"
DRY_RUN=1 SKIP_BUILD=1 bash deploy-batches.sh $FUNCS      # preview the batches
bash deploy-batches.sh $FUNCS                              # for real
```
Why these ten: `processPayment` and `desk_runRentBatch` start rent charges (new fees + cost fields); `setupAccount` sets the subaccount percentage from the same table;
`pmsAccountingBilling` is new; the six `lw*` functions compute Landlord Watch snapshots/transcripts (new collected-rent rule).
NOT needed: `paystackCallback` and the schedulers (they only read amounts stored on each payment), the other `lw*` functions (no snapshot maths), everything else.
Equivalent plain CLI: `firebase deploy --only functions:processPayment,functions:setupAccount,...`.

Accounts already set up keep the percentage stored on their Paystack subaccount until `setupAccount` runs again for them; rent CHARGES use the flat split from the new table immediately.

## 3. Tenant payment screen (PAY hosting, optional but keeps the preview honest)
```bash
npm run build && firebase deploy --only hosting
```

## Order of rollout (whole project)
1. PAY functions (this file, step 2).
2. PMS Firestore rules + indexes (`firebase deploy --only firestore:rules,firestore:indexes --project plot-9fd6e`) BEFORE releasing the PMS app, or expense/income sync will be refused until you do.
3. PMS app release.
4. Outside these two repos: stop selling Starter in `processWebSubscription` (CYBER) and the Firestore `plans` collection; update samuhia.co.ke/pricing (it still quotes 1.5% platform fee for rent).
