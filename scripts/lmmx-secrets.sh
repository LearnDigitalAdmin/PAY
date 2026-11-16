#!/usr/bin/env bash
# Adds the five LMMX keys to the shared secret bundle `app-secrets-bundle` (a JSON object in Secret Manager).
# - Only ADDS keys that are missing. It never changes or deletes an existing key, and it never prints a value (key NAMES only).
# - The keys are 32 random bytes (base64). LMMX_HASH_PEPPER and LMMX_FIELD_KEY must NEVER change once tenants exist
#   (they fingerprint and encrypt stored data); the others can be rotated by deleting the key and re-running.
# Needs: gcloud (logged in with access to the project), python3.   Run from anywhere:  bash scripts/lmmx-secrets.sh
set -euo pipefail
PROJECT="${PROJECT:-plot-9fd6e}"; SECRET="${SECRET:-app-secrets-bundle}"
umask 077
tmp="$(mktemp)"; trap 'shred -u "$tmp" 2>/dev/null || rm -f "$tmp"' EXIT
gcloud secrets versions access latest --secret="$SECRET" --project="$PROJECT" > "$tmp"
added="$(python3 - "$tmp" <<'PY'
import base64, json, os, sys
p = sys.argv[1]
b = json.load(open(p))
if not isinstance(b, dict): raise SystemExit("the secret is not a JSON object")
added = []
for k in ["LMMX_HASH_PEPPER", "LMMX_OTP_PEPPER", "LMMX_FIELD_KEY", "LMMX_QUOTE_KEY", "LMMX_BOT_KEY"]:
    if not b.get(k):
        b[k] = base64.b64encode(os.urandom(32)).decode(); added.append(k)
json.dump(b, open(p, "w"))
print(",".join(added))
PY
)"
if [ -z "$added" ]; then echo "All LMMX keys already exist. Nothing to do."; exit 0; fi
gcloud secrets versions add "$SECRET" --project="$PROJECT" --data-file="$tmp" >/dev/null
echo "Added to $SECRET: $added"
echo "Redeploy the functions that read secrets (see DEPLOY_CORE.md) so they pick up the new version."
