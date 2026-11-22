# Samuhia Perks backend

Lives in `functions/src/perks/`, deployed with the rest of PAY's functions (region `africa-south1`). Shares the Firebase project, the `app-secrets-bundle` secret and the HostPinnacle `HP_SMS_*` credentials.

## Entry points
- `perks_op` - operator actions. Caller must be listed in Firestore doc `perks_config/operators` as `{ uids: ["<firebase uid>", ...] }` (create it in the console; no client can write it).
- `perks_me` - the signed-in customer's own account. Identity is the phone proven by `verifyLoginOtp` (`otp_phone` claim). The phone is never taken from the request body.

Actions: `recordSale, redeem, reverseSale, registerReferral, createVoucher, bulkVouchers, assignVoucher, setVoucherStatus, saveCampaign, setCampaignActive, setActiveCampaign, saveTemplate, updateSettings, getSettings, retrySms, setConsent, getCustomer, list, runDraw` (operator) and `summary, setMarketing` (customer). There is no customer redeem action.

## Guarantees
- Every points change is one Firestore transaction (record + ledger + cached balance). Ledger rows are never edited or deleted; reversals add a negative row.
- Idempotency keys on sales and redemptions: a repeated request returns the original result.
- Referral reward (50 inviter / 30 invitee) only above KES 50, once per invitee (`perks_referrals/{inviteeId}`), atomic with the qualifying sale.
- Marketing adverts are appended only when the customer has marketing consent and an active, in-date campaign exists; templates cannot contain links.
- `runDraw` always refuses until `drawProductionApproved` is set in the console (the API cannot set it). Keep it off pending Kenyan legal review.

## Data (default database, all server-only in firestore.rules)
`perks_settings/main, perks_customers/{e164 digits}, perks_codes/{referralCode}, perks_tx, perks_ledger, perks_referrals/{inviteeId}, perks_redemptions, perks_vouchers/{code}, perks_campaigns, perks_templates/{type}, perks_smsLog, perks_audit, perks_consentLog, perks_config/operators`

Composite indexes (customerId asc, createdAt desc) are in PMS `firestore.indexes.json`; rules are in PMS `plot-rules/firestore.rules`.

## Moving it out of PAY later
Only `perks/deps.ts` imports from the rest of PAY (Firestore handle, region, secrets binding, SMS sender). Copy the folder, re-implement those four exports, done. `test/perks.check.js` fails if another file reaches outside the folder.

## Known gaps
- The sender ID is transactional (no replies), so there is no STOP keyword: promotional SMS point to the opt-out toggle in the Perks app (`Opt out: perks.samuhia.co.ke`).
- Delivery status comes from the shared HostPinnacle webhook (`docs/sms/HP_WEBHOOK.md`): `perks_smsLog.delivery` is `UNKNOWN`, `DELIVERED`, `UNDELIVERED`, `EXPIRED`, `REJECTED` or `FAILED`; a failure report flips a `SENT` row to `FAILED` so the operator can retry.
- Operators with the same uid in `perks_config/operators` have full access; there is no per-action role split yet.
- Reversing a sale does not claw back a referral reward it triggered.
