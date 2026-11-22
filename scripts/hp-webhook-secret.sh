#!/usr/bin/env bash
# Manages HP_WEBHOOK_TOKEN inside the shared secret bundle `app-secrets-bundle` (same convention as lmmx-secrets.sh).
#   bash scripts/hp-webhook-secret.sh           add the token if missing (generated with openssl; never overwrites an existing one)
#   bash scripts/hp-webhook-secret.sh rotate    replace it with a new one (then update the HostPinnacle callback URL and redeploy hpSmsWebhook)
#   bash scripts/hp-webhook-secret.sh url       print the full callback URL for the HostPinnacle portal (PRINTS THE TOKEN, run it privately)
# Needs: gcloud (logged in with access to the project), python3, openssl.
set -euo pipefail
PROJECT="${PROJECT:-plot-9fd6e}"; SECRET="${SECRET:-app-secrets-bundle}"; REGION="${REGION:-africa-south1}"; CMD="${1:-ensure}"
for t in gcloud python3 openssl; do command -v "$t" >/dev/null || { echo "missing tool: $t" >&2; exit 1; }; done
umask 077
tmp="$(mktemp)"; trap 'shred -u "$tmp" 2>/dev/null || rm -f "$tmp"' EXIT
gcloud secrets versions access latest --secret="$SECRET" --project="$PROJECT" > "$tmp"
case "$CMD" in
  ensure|rotate)
    NEW="$(openssl rand -hex 32)"
    status="$(NEW="$NEW" MODE="$CMD" python3 - "$tmp" <<'PY'
import json, os, sys
p = sys.argv[1]
b = json.load(open(p))
if not isinstance(b, dict): raise SystemExit("the secret is not a JSON object")
k = "HP_WEBHOOK_TOKEN"
if b.get(k) and os.environ["MODE"] != "rotate":
    print("exists")
else:
    b[k] = os.environ["NEW"]; json.dump(b, open(p, "w")); print("set")
PY
)"
    if [ "$status" = "exists" ]; then echo "HP_WEBHOOK_TOKEN already exists in $SECRET. Nothing changed (use: bash scripts/hp-webhook-secret.sh rotate)."; exit 0; fi
    gcloud secrets versions add "$SECRET" --project="$PROJECT" --data-file="$tmp" >/dev/null
    echo "HP_WEBHOOK_TOKEN written to $SECRET (value not shown)."
    echo "Next: deploy the functions so they read the new version (bash scripts/deploy-perks.sh), then: bash scripts/hp-webhook-secret.sh url"
    ;;
  url)
    token="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("HP_WEBHOOK_TOKEN",""))' "$tmp")"
    [ -n "$token" ] || { echo "HP_WEBHOOK_TOKEN is not set yet. Run: bash scripts/hp-webhook-secret.sh" >&2; exit 1; }
    base="$(gcloud functions describe hpSmsWebhook --gen2 --region="$REGION" --project="$PROJECT" --format='value(serviceConfig.uri)' 2>/dev/null || true)"
    [ -n "$base" ] || { echo "hpSmsWebhook is not deployed yet. Run: bash scripts/deploy-perks.sh" >&2; exit 1; }
    echo "${base%/}/?t=${token}"
    ;;
  *) echo "usage: $0 [ensure|rotate|url]" >&2; exit 2 ;;
esac
