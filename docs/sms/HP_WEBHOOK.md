# HostPinnacle delivery reports (shared by every product)

Code: `functions/src/sms/` (webhook `hpSmsWebhook`, parser, dispatch records) plus a hook in `hpSms.ts`.

## What it does
- Every SMS sent through `sendHpSms` (Perks, LMM, OTP login, notifications...) now leaves a row in `sms_dispatch` once HostPinnacle accepts it: product, a reference, the recipient, the provider message id(s), message length and a short hash. **The message body is never stored** (it can contain OTPs). Rows expire after 90 days (`expireAt`).
- HostPinnacle calls `hpSmsWebhook` with delivery reports. Each report is matched to its send (provider id first, otherwise the newest unfinished send to that number), the status moves forward only (`SENT` to `DELIVERED` or a failure state; `DELIVERED` is never downgraded), and the owning product's handler is called once per change.
- Every authenticated request is also saved raw in `sms_dlr_inbox` and each event is de-duplicated in `sms_dlr_events`. Inbound or unrecognised callbacks are recorded and ignored (the transactional sender cannot receive replies).
- MyChama's two direct senders call `trackDispatch` as well, so its sends are tracked too.

## Setup (one time)
1. Add `HP_WEBHOOK_TOKEN` (a long random string) to the JSON in the `app-secrets-bundle` secret. Without it the webhook answers 503 to everything.
2. Deploy: `firebase deploy --only functions:hpSmsWebhook` (and the PMS rules/indexes patch).
3. In the HostPinnacle portal, set the delivery-report callback URL to `https://<hpSmsWebhook URL>/?t=<HP_WEBHOOK_TOKEN>` (GET or POST). If a separate HostPinnacle account is used (MyChama), set the same URL there.
4. Enable Firestore TTL so old rows disappear:
   `gcloud firestore fields ttls update expireAt --collection-group=sms_dispatch --enable-ttl` (repeat for `sms_dlr_inbox`, `sms_dlr_events`).
5. **Verify with real traffic.** The exact callback parameter names are set by HostPinnacle and are not assumed: the parser matches many common names case-insensitively. Send one real SMS, then open `sms_dlr_inbox` and `sms_dispatch`. If `events` is 0 or `matched` is 0 on the inbox row, adjust the alias lists at the top of `sms/parse.ts` (the test file shows how), or ask HostPinnacle for their callback specification.

## Using it from a product
- Tag the send: `sendHpSms({ mobile, message, track: { product: "lmm", ref: "lmm_sms/<docId>" } })`. The result has `providerIds`.
- React to reports: `registerSmsProduct("lmm", async (event, dispatch) => { /* update your own log row from dispatch.ref */ })`. Perks does this in `perks/deps.ts` + `perks/dlr.ts`.
- Untagged sends are still tracked under product `unknown`.

## Limits
- The token travels in the URL (HostPinnacle callback config usually allows only a URL). Keep the function logs private and rotate the token if it leaks. If HostPinnacle publishes source IPs, add an allow-list in front.
- Mobile-number fallback matching can mis-attribute when two sends to the same number are unfinished at once; provider-id matching is exact.
