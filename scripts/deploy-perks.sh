#!/usr/bin/env bash
# Deploys ONLY the Perks + delivery-webhook functions (not the other 100+). Builds and tests first.
#   bash scripts/deploy-perks.sh                  perks_op, perks_me, hpSmsWebhook (new) + sendLoginOtp, verifyLoginOtp (Perks customer login)
#   bash scripts/deploy-perks.sh --with-senders   ...plus the SMS-sending functions whose sends should now be delivery-tracked
# Payment/reconcile callbacks are deliberately NOT included; redeploy those by name only when you want their SMS tracked.
set -euo pipefail
PROJECT="${PROJECT:-plot-9fd6e}"
cd "$(dirname "$0")/.."
ONLY="functions:perks_op,functions:perks_me,functions:hpSmsWebhook,functions:sendLoginOtp,functions:verifyLoginOtp"
if [ "${1:-}" = "--with-senders" ]; then
  ONLY="$ONLY,functions:mychamaLinkRequestCode,functions:lmm_dailySweep,functions:lmmx_dailySweep,functions:lwBotApi,functions:crScheduler"
fi
( cd functions && npm run build && node test/perks.check.js && node test/sms-dlr.check.js && node test/no-env-credentials.check.js )
echo "Deploying: $ONLY"
firebase deploy --only "$ONLY" --project "$PROJECT"
