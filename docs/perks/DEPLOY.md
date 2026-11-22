# Perks + delivery webhook: deploy runbook (PAY and PMS)

Only 3 functions are new, plus 2 existing login functions that gained a Perks variant. Everything below deploys just those 5, never the other 100+.

| Function | Status | Purpose |
|---|---|---|
| `perks_op` | new | operator actions |
| `perks_me` | new | customer's own account |
| `hpSmsWebhook` | new | HostPinnacle delivery reports (shared by all products) |
| `sendLoginOtp`, `verifyLoginOtp` | updated | add `product: "perks"`: Perks wording, the shared `HP_SMS_*` sender, any Kenyan network (payments behaviour unchanged) |

Optional, only to start delivery-tracking their SMS (they keep working unchanged if not redeployed): `mychamaLinkRequestCode`, `lmm_dailySweep`, `lmmx_dailySweep`, `lwBotApi`, `crScheduler`. Payment/reconcile callbacks that also send SMS (`paystackCallback`, `chargeSmsTopUp`, `reconcileMyChamaIntents`, `mychamaPaystackCallback`, `reconcileMyChamaIntentsV2`) are not included by the script; redeploy them by name later if wanted.

## Steps (in this order)
```bash
# 0. Apply the patches (PAY, then PMS). --check first; patches are applied in this order.
cd PAY && for p in perks-backend-pay hp-webhook-pay perks-deploy-pay; do git apply --check ../$p.patch && git apply ../$p.patch; done
cd ../PMS && for p in perks-rules-pms hp-webhook-pms; do git apply --check ../$p.patch && git apply ../$p.patch; done

# 1. Rules + indexes (PMS)
cd PMS/plot-rules && firebase deploy --only firestore:rules --project plot-9fd6e
cd .. && firebase deploy --only firestore:indexes --project plot-9fd6e      # indexes take a few minutes to build

# 2. Webhook token into the bundle (openssl-generated, never overwrites)
cd ../PAY && bash scripts/hp-webhook-secret.sh

# 3. Build, test, deploy ONLY the new functions
bash scripts/deploy-perks.sh                    # add --with-senders to also redeploy the 5 other SMS-sending functions

# 4. Allow the shop owner as Perks operator (uid from Firebase Console > Authentication)
cd functions && gcloud auth application-default login && GOOGLE_CLOUD_PROJECT=plot-9fd6e node scripts/perks-operators.js add <UID>

# 5. Auto-expire delivery records (90 days)
for c in sms_dispatch sms_dlr_inbox sms_dlr_events; do gcloud firestore fields ttls update expireAt --collection-group=$c --enable-ttl --project plot-9fd6e; done

# 6. Callback URL for the HostPinnacle portal (prints the token: run privately)
cd .. && bash scripts/hp-webhook-secret.sh url
```
## Smoke test the webhook
```bash
URL="$(bash scripts/hp-webhook-secret.sh url)"
curl -s -o /dev/null -w "no token  -> %{http_code} (expect 401)\n" "${URL%%\?*}"
curl -s -o /dev/null -w "with token -> %{http_code} (expect 200)\n" "$URL&msgid=SMOKE1&mobile=254700000000&status=DELIVRD"
```
Then check Firestore `sms_dlr_inbox` for the new row (`events: 1`, `matched: 0` because SMOKE1 is not a real send). Send one real SMS and confirm a real report arrives with `matched: 1`; if not, see "Verify with real traffic" in `docs/sms/HP_WEBHOOK.md`.

## Rotate or roll back
- New token: `bash scripts/hp-webhook-secret.sh rotate`, redeploy `hpSmsWebhook`, update the HostPinnacle URL.
- Remove: `firebase functions:delete perks_op perks_me hpSmsWebhook --region africa-south1 --project plot-9fd6e`.
