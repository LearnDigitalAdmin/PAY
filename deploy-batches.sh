#!/usr/bin/env bash
# Deploy ALL Firebase functions in small batches so Cloud Build / the CLI don't run out of memory
# or hit quota limits. Each batch is retried with a growing cool-down, and there is a cool-down
# between batches.
#
# Run from the Firebase project root (the folder containing firebase.json), in Git Bash:
#   bash deploy-batches.sh                         deploy every function, 4 at a time
#   bash deploy-batches.sh chargeSmsTopUp lwBotApi deploy only these (still batched)
#
# Options (environment variables):
#   BATCH_SIZE=4         functions per deploy
#   RETRIES=3            attempts per batch
#   PAUSE=30             seconds to cool down between batches
#   RETRY_PAUSE=60       seconds before the first retry (doubles on each further retry)
#   PROJECT=plot-9fd6e   Firebase project (default: whatever .firebaserc says)
#   FUNCTIONS_DIR=functions
#   DRY_RUN=1            print the batches and exit without deploying
#   SKIP_BUILD=1         don't run `npm run build` first (only for discovery; firebase still runs predeploy)
#
# The function list is discovered from the compiled code, so new functions are picked up
# automatically and nothing needs to be listed here by hand.

set -u

BATCH_SIZE="${BATCH_SIZE:-4}"
RETRIES="${RETRIES:-3}"
PAUSE="${PAUSE:-30}"
RETRY_PAUSE="${RETRY_PAUSE:-60}"
FUNCTIONS_DIR="${FUNCTIONS_DIR:-functions}"
PROJECT="${PROJECT:-}"

# More heap for the CLI and a longer code-analysis timeout (the "Cannot determine backend specification" error)
export NODE_OPTIONS="--max-old-space-size=4096"
export FUNCTIONS_DISCOVERY_TIMEOUT="${FUNCTIONS_DISCOVERY_TIMEOUT:-120}"

PROJECT_ARGS=()
[ -n "$PROJECT" ] && PROJECT_ARGS=(--project "$PROJECT")

# ── Which functions? ────────────────────────────────────────────────────────
FUNCS=()
if [ "$#" -gt 0 ]; then
  FUNCS=("$@")
else
  if [ "${SKIP_BUILD:-0}" != "1" ]; then
    echo "Building $FUNCTIONS_DIR to discover functions..."
    if ! npm --prefix "$FUNCTIONS_DIR" run build >/dev/null; then
      echo "Build failed. Fix the TypeScript errors first (cd $FUNCTIONS_DIR && npm run build)." >&2
      exit 2
    fi
  fi

  # Every export of the compiled bundle that is a v1/v2 Cloud Function.
  discovered=$(cd "$FUNCTIONS_DIR" && GCLOUD_PROJECT="${PROJECT:-plot-9fd6e}" node -e '
    const m = require(require("path").resolve("lib/index.js"));
    const names = Object.keys(m).filter((k) => {
      const f = m[k];
      return f && (typeof f === "function" || typeof f === "object") && (f.__endpoint || f.__trigger);
    });
    console.log(names.sort().join("\n"));
  ' 2>/dev/null) || discovered=""

  while IFS= read -r name; do
    name="${name%$'\r'}"
    [ -n "$name" ] && FUNCS+=("$name")
  done <<< "$discovered"

  if [ "${#FUNCS[@]}" -eq 0 ]; then
    echo "Could not discover any functions from $FUNCTIONS_DIR/lib/index.js." >&2
    echo "Pass the names explicitly: bash deploy-batches.sh fnA fnB ..." >&2
    exit 2
  fi
fi

total=${#FUNCS[@]}
batches=$(( (total + BATCH_SIZE - 1) / BATCH_SIZE ))
echo "Deploying $total function(s) in $batches batch(es) of up to $BATCH_SIZE"
echo "Retries per batch: $RETRIES | cool-down between batches: ${PAUSE}s | first retry wait: ${RETRY_PAUSE}s (doubles)"

if [ "${DRY_RUN:-0}" = "1" ]; then
  i=0; n=0
  while [ "$i" -lt "$total" ]; do
    n=$((n + 1))
    echo "  Batch $n: ${FUNCS[*]:$i:$BATCH_SIZE}"
    i=$((i + BATCH_SIZE))
  done
  exit 0
fi

# ── Deploy ──────────────────────────────────────────────────────────────────
failed=()
succeeded=0
i=0
batch_no=0
while [ "$i" -lt "$total" ]; do
  batch=("${FUNCS[@]:$i:$BATCH_SIZE}")
  batch_no=$((batch_no + 1))
  only=$(printf 'functions:%s,' "${batch[@]}")
  only="${only%,}"

  echo
  echo "=== Batch $batch_no/$batches: ${batch[*]} ==="

  ok=0
  attempt=1
  wait_s="$RETRY_PAUSE"
  while [ "$attempt" -le "$RETRIES" ]; do
    if firebase deploy --only "$only" --non-interactive "${PROJECT_ARGS[@]}"; then
      ok=1
      break
    fi
    echo "Batch $batch_no failed (attempt $attempt/$RETRIES)."
    attempt=$((attempt + 1))
    if [ "$attempt" -le "$RETRIES" ]; then
      echo "Cooling down ${wait_s}s before retry..."
      sleep "$wait_s"
      wait_s=$((wait_s * 2))
    fi
  done

  if [ "$ok" -eq 1 ]; then
    succeeded=$((succeeded + ${#batch[@]}))
  else
    failed+=("${batch[@]}")
  fi

  i=$((i + BATCH_SIZE))
  if [ "$i" -lt "$total" ]; then
    echo "Cooling down ${PAUSE}s before the next batch..."
    sleep "$PAUSE"
  fi
done

echo
echo "Deployed $succeeded of $total function(s)."
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
