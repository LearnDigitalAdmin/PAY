# Landlord Watch (backend)

Owner-ID lookup, masked snapshots, OTP unlock, monthly landlord transcripts (1 free per property per month, KES 99 each extra)
and the WhatsApp endpoint. Source of truth for the wire format: `LANDLORD_WATCH_CONTRACT.md` (v1.1).

## Functions (region `africa-south1`)
Callables for PMS and CYBER web: `lwLookupProperty`, `lwConnect`, `lwDisconnect`, `lwListConnections`, `lwUnlockSendOtp`,
`lwUnlockVerifyOtp`, `lwGetSnapshot`, `lwTranscriptQuota`, `lwTranscriptStart`, `lwTranscriptResendOtp`,
`lwTranscriptVerifyOtp` (2 GiB), `lwTranscriptPay`, `lwTranscriptStatus` (2 GiB), `lwTranscriptList`.
HTTPS for the WhatsApp bot: `lwBotApi` (header `x-lw-key`).

## Before the first deploy
1. Create the shared secret used by `lwBotApi` and the WhatsApp bot:
   `firebase functions:secrets:set LW_BOT_API_KEY` (use a long random value; give the same secret to the bot's function).
2. The runtime service account must be able to sign URLs (`roles/iam.serviceAccountTokenCreator` on itself). The sign-in OTP
   functions already need this for custom tokens, so it is normally in place.
3. A default Cloud Storage bucket must exist (transcript PDFs are stored under `landlord-watch/transcripts/…`).
   Optional: a lifecycle rule deleting that prefix after 30 days (a transcript can only be re-fetched for 24 h).
4. The PMS patch that allocates `PYP-NNNN` owner ids and mirrors transcripts to `users/{id}/transcripts` must be deployed
   (functions first, then rules). Properties without an owner id/phone cannot be looked up.
5. `npm ci` (adds `puppeteer-core` and `@sparticuz/chromium`).

## Firestore collections written (all server-only; no client rules needed)
`lwActors` (connections), `lwUnlocks`, `lwOtp`, `lwOtpRate`, `lwRate`, `lwSnapshots` (cache), `lwQuota`, `lwTranscripts`
(requests), and company revenue in `platform_revenue/{reference}` + `platform_stats/totals`
(`totalLandlordWatchTranscripts`, `totalLandlordWatchRevenue`). No desk events, no splits.

## Payments
Reference prefix `LWT_` routes the Paystack webhook (`paystackCallback`) to `settleTranscriptPayment`. The charge is exactly
KES 99.00 (9900 subunits); Paystack's fee is ours. `lwTranscriptStatus` also verifies with Paystack when the webhook is late.

## Tests
`npm run build && node test/landlord-watch-calc.check.js && node test/landlord-watch-service.check.js`
