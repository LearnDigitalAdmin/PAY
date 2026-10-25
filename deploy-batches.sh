#!/usr/bin/env bash
# Deploy Firebase functions in small batches so Cloud Build / the CLI don't run out of memory.
# Run from the Firebase project root (the folder containing firebase.json), in Git Bash:
#   bash deploy-batches.sh
#
# Optional:  BATCH_SIZE=3 PAUSE=45 bash deploy-batches.sh
#            bash deploy-batches.sh chargeSmsTopUp setupAccount     (deploy only these, still batched)

set -u

BATCH_SIZE="${BATCH_SIZE:-4}"     # functions per deploy
PAUSE="${PAUSE:-30}"              # seconds to wait between batches
RETRIES="${RETRIES:-2}"           # attempts per batch

# More heap for the CLI and a longer code-analysis timeout (the "Cannot determine backend specification" error)
export NODE_OPTIONS="--max-old-space-size=4096"
export FUNCTIONS_DISCOVERY_TIMEOUT="${FUNCTIONS_DISCOVERY_TIMEOUT:-120}"

# ── Functions defined in index.ts ───────────────────────────────────────────
FUNCS=(
  chargeSmsTopUp
  setupAccount
  processPayment
  chargeCustomer
  paystackCallback
  getUserPayments
  verifyTransaction
  listBanks
  createUserWithFirebaseAuth
  expireBusinessTrials
  reconcileMyChamaIntents
  desk_runRentBatch

  # Re-exported from other files
  deskSmsCommission
  reconcileIdentityDuplicates
  lwLookupProperty lwConnect lwDisconnect lwListConnections
  lwUnlockSendOtp lwUnlockVerifyOtp lwGetSnapshot
  lwTranscriptQuota lwTranscriptStart lwTranscriptResendOtp lwTranscriptVerifyOtp
  lwTranscriptPay lwTranscriptStatus lwTranscriptList lwBotApi

  # TODO: add the function names exported by ./mychama and ./auth (export * hides them from this file), e.g.
  # myFirstMychamaFunction
  # myFirstAuthFunction
)

# Override the list from the command line if names were given
if [ "$#" -gt 0 ]; then
  FUNCS=("$@")
fi

total=${#FUNCS[@]}
echo "Deploying $total function(s) in batches of $BATCH_SIZE"

failed=()
i=0
batch_no=0
while [ "$i" -lt "$total" ]; do
  batch=("${FUNCS[@]:$i:$BATCH_SIZE}")
  batch_no=$((batch_no + 1))
  only=$(printf 'functions:%s,' "${batch[@]}")
  only="${only%,}"

  echo
  echo "=== Batch $batch_no: ${batch[*]} ==="

  ok=0
  attempt=1
  while [ "$attempt" -le "$RETRIES" ]; do
    if firebase deploy --only "$only" --non-interactive; then
      ok=1
      break
    fi
    echo "Batch $batch_no failed (attempt $attempt/$RETRIES)."
    attempt=$((attempt + 1))
    [ "$attempt" -le "$RETRIES" ] && { echo "Waiting ${PAUSE}s before retry..."; sleep "$PAUSE"; }
  done

  if [ "$ok" -eq 0 ]; then
    failed+=("${batch[@]}")
  fi

  i=$((i + BATCH_SIZE))
  [ "$i" -lt "$total" ] && { echo "Pausing ${PAUSE}s..."; sleep "$PAUSE"; }
done

echo
if [ "${#failed[@]}" -eq 0 ]; then
  echo "All batches deployed."
else
  echo "These functions failed:"
  printf '  %s\n' "${failed[@]}"
  echo
  echo "Re-run just those with:"
  echo "  bash deploy-batches.sh ${failed[*]}"
  exit 1
fi
