#!/usr/bin/env bash
# deploy-batches.sh - deploy this repo's Firebase functions in small, retried batches.
#
# The SAME script lives in DESK, PAY and PMS. Only the CONFIG block below differs.
# All three repos deploy into ONE Firebase project, so the script is built around that:
#   * it only ever deploys NAMED functions (functions:<codebase>:<name>), never a bare "functions"
#     deploy, and it never passes --force. Without --force the CLI aborts instead of deleting, so one
#     repo can never delete another repo's functions.
#   * names that exist in more than one repo (e.g. healthCheck) are skipped and reported.
#
# Run it from the repo root (Git Bash, Cloud Shell, Linux or macOS). Needs: git, node, npm, firebase CLI.
#
#   bash deploy-batches.sh                 deploy EVERY function of this repo (asks to confirm)
#   bash deploy-batches.sh fnA fnB         only these (a name, or codebase:name)
#   bash deploy-batches.sh --pinned        only functions still pinned to an OLD secret version
#   bash deploy-batches.sh --dry-run       show the plan and deploy nothing
#   bash deploy-batches.sh --yes           do not ask for confirmation
#   bash deploy-batches.sh --fresh         ignore the resume list (redeploy even if done at this commit)
#   bash deploy-batches.sh --ref=<commit>  deploy that commit from a temporary clean checkout, leaving your
#                                          working tree (and anything else editing it) untouched
#   bash deploy-batches.sh --help
#
# Options (environment variables):
#   BATCH_SIZE=4          functions per deploy
#   RETRIES=3             attempts per batch
#   PAUSE=30              seconds between batches
#   RETRY_PAUSE=60        seconds before the first retry (doubles each retry)
#   PROJECT=<id>          Firebase project (default: see CONFIG)
#   EXCLUDE="a b"         extra function names to skip
#   ALLOW_DIRTY=1         deploy even if the source folders have uncommitted changes
#   ALLOW_UNPUSHED=1      deploy even if HEAD has commits that are not on origin
#   SKIP_INSTALL=1        never run npm ci          FORCE_INSTALL=1  always run it
#   SKIP_BUILD=1          do not run npm run build before discovering functions
#   NO_CANARY=1           keep going even if the very first batch fails
#   VERIFY=0              skip the post-deploy secret-version check
#   ENV_AUDIT=0           skip the before/after environment-variable name audit
#   DEPLOY_STATE_DIR=...  where logs and the resume list are kept
#
# Notes:
#   * Deploying replaces a function's plain environment variables with what is in its .env files. The
#     script lists variable NAMES (never values) before and after and shows any that disappeared.
#   * Each batch also runs the repo's predeploy build, so a full run takes a few hours. Run it inside
#     tmux (Cloud Shell) so a dropped connection does not kill it; re-running resumes where it stopped.

set -u

# ===== CONFIG (the only part that differs between repos) ====================================================
REPO_LABEL="PAY"
DEFAULT_PROJECT="plot-9fd6e"
# "codebase:source-folder" pairs, exactly as in firebase.json
CODEBASES=("default:functions")
# Function names that ALSO exist in another repo of this project; skipped in bulk deploys
EXCLUDE_DEFAULT=""
# Files that are not in git but must be present (Firebase deploys .env files as environment variables)
REQUIRED_UNTRACKED=()
# ===== end CONFIG ===========================================================================================

BATCH_SIZE="${BATCH_SIZE:-4}"
RETRIES="${RETRIES:-3}"
PAUSE="${PAUSE:-30}"
RETRY_PAUSE="${RETRY_PAUSE:-60}"
PROJECT="${PROJECT:-$DEFAULT_PROJECT}"
MODE="${MODE:-all}"
REF="${REF:-}"
EXCLUDE="${EXCLUDE:-}"
DRY_RUN="${DRY_RUN:-0}"
YES="${YES:-0}"
FRESH="${FRESH:-0}"

# More heap for the CLI and a longer code-analysis timeout ("Cannot determine backend specification")
export NODE_OPTIONS="--max-old-space-size=4096"
export FUNCTIONS_DISCOVERY_TIMEOUT="${FUNCTIONS_DISCOVERY_TIMEOUT:-120}"

say()  { printf '%s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: bash deploy-batches.sh [options] [function ...]
  (no names)       deploy every function of this repo, in batches (asks to confirm)
  fnA codebase:fnB deploy only these
  --pinned         only functions still pinned to an old secret version (needs gcloud + jq)
  --dry-run        show the plan, deploy nothing
  --yes, -y        do not ask for confirmation
  --fresh          ignore the resume list for this commit
  --ref=<commit>   deploy that commit from a temporary clean checkout
  --project=<id>   Firebase project
  -h, --help       this help
Environment options (BATCH_SIZE, RETRIES, PAUSE, ...) are listed at the top of the script.
EOF
}

NAMES=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help)   usage; exit 0 ;;
    --dry-run)   DRY_RUN=1 ;;
    -y|--yes)    YES=1 ;;
    --pinned)    MODE=pinned ;;
    --all)       MODE=all ;;
    --fresh)     FRESH=1 ;;
    --ref=*)     REF="${1#--ref=}" ;;
    --project=*) PROJECT="${1#--project=}" ;;
    --)          shift; while [ "$#" -gt 0 ]; do NAMES+=("$1"); shift; done; break ;;
    -*)          die "Unknown option: $1 (try --help)" ;;
    *)           NAMES+=("$1") ;;
  esac
  shift
done
case "$MODE" in all|pinned) ;; *) die "MODE must be 'all' or 'pinned' (got '$MODE')" ;; esac

# ----- locate the repo root ------------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || die "cannot resolve the script folder"
ORIG_ROOT="$SCRIPT_DIR"
cd "$ORIG_ROOT" || die "cannot cd to $ORIG_ROOT"
[ -f firebase.json ] || die "firebase.json not found in $ORIG_ROOT - keep this script in the repo root"
git rev-parse --git-dir >/dev/null 2>&1 || die "$ORIG_ROOT is not a git repository"

SRC_DIRS=()
for cb in "${CODEBASES[@]}"; do SRC_DIRS+=("${cb#*:}"); done

for tool in git node npm firebase; do
  command -v "$tool" >/dev/null 2>&1 || die "'$tool' is not installed or not on PATH"
done
HAVE_GCLOUD=0
{ command -v gcloud >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; } && HAVE_GCLOUD=1
if [ "$MODE" = "pinned" ] && [ "$HAVE_GCLOUD" -ne 1 ]; then
  die "--pinned needs both 'gcloud' and 'jq' (Cloud Shell has them). Without them run without --pinned."
fi
node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$node_major" -lt 22 ] && warn "Node $node_major found; these functions declare Node 22. Builds usually still work, but 'nvm use 22' is safer."

STATE="${DEPLOY_STATE_DIR:-$HOME/.deploy-batches/$REPO_LABEL-$PROJECT}"
mkdir -p "$STATE" || die "cannot create $STATE"
LOCK_DIR="$STATE/lock"
mkdir "$LOCK_DIR" 2>/dev/null || die "another run looks active (or crashed). If none is running: rmdir '$LOCK_DIR'"

WT=""; WT_BASE=""
cleanup() {
  local rc=$?
  cd "$ORIG_ROOT" 2>/dev/null || cd /
  if [ -n "$WT" ]; then
    git -C "$ORIG_ROOT" worktree remove --force "$WT" >/dev/null 2>&1
    git -C "$ORIG_ROOT" worktree prune >/dev/null 2>&1
  fi
  [ -n "$WT_BASE" ] && rm -rf "$WT_BASE"
  rmdir "$LOCK_DIR" 2>/dev/null
  return "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# ----- decide which code gets deployed -------------------------------------------------------------------
if [ -n "$REF" ]; then
  git rev-parse --verify --quiet "$REF^{commit}" >/dev/null || die "'$REF' is not a commit in this repo (run 'git fetch' first?)"
  WT_BASE="$(mktemp -d)" || die "mktemp failed"
  WT="$WT_BASE/$REPO_LABEL"
  git worktree add --detach "$WT" "$REF" >/dev/null 2>&1 || die "could not create a clean checkout of $REF"
  say "Deploying $REPO_LABEL at $REF from a temporary clean checkout (your working tree is not touched)."
  # Firebase deploys .env files as environment variables, but they are not in git: bring them along.
  for d in "${SRC_DIRS[@]}"; do
    for f in .env ".env.$PROJECT"; do
      if [ -f "$ORIG_ROOT/$d/$f" ] && [ ! -f "$WT/$d/$f" ]; then
        cp "$ORIG_ROOT/$d/$f" "$WT/$d/$f" && say "  copied $d/$f (not tracked by git)"
      fi
    done
  done
  cd "$WT" || die "cannot cd to $WT"
else
  dirty="$(git status --porcelain -- firebase.json .firebaserc "${SRC_DIRS[@]}" 2>/dev/null)"
  if [ -n "$dirty" ] && [ "${ALLOW_DIRTY:-0}" != "1" ]; then
    printf '%s\n' "$dirty" | head -15 >&2
    die "uncommitted changes in the folders that get deployed. Commit/stash them, use --ref=<commit> to deploy a clean commit, or ALLOW_DIRTY=1."
  fi
  branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
  if [ "$branch" != "HEAD" ] && git fetch --quiet origin "$branch" 2>/dev/null; then
    ahead="$(git rev-list --count "origin/$branch..HEAD" 2>/dev/null || echo 0)"
    behind="$(git rev-list --count "HEAD..origin/$branch" 2>/dev/null || echo 0)"
    if [ "$ahead" -gt 0 ] && [ "${ALLOW_UNPUSHED:-0}" != "1" ]; then
      die "HEAD is $ahead commit(s) ahead of origin/$branch, i.e. not on GitHub. Push first, or ALLOW_UNPUSHED=1."
    fi
    [ "$behind" -gt 0 ] && warn "origin/$branch has $behind newer commit(s) than what you are about to deploy."
  else
    warn "could not compare HEAD with origin (detached HEAD, offline, or no access) - continuing."
  fi
fi
HEAD_SHA="$(git rev-parse --short HEAD)"

# required untracked files (checked after any .env copy above)
for f in ${REQUIRED_UNTRACKED[@]+"${REQUIRED_UNTRACKED[@]}"}; do
  if [ ! -f "$f" ]; then
    if [ "${ALLOW_MISSING_ENV:-0}" = "1" ]; then
      warn "'$f' is missing - the deployed functions will have none of the environment variables it defines."
    else
      die "required file '$f' is missing (it is not in git). Without it the deployed functions lose their environment variables. Deploy from your normal checkout, create the file, or ALLOW_MISSING_ENV=1 if this repo genuinely has none."
    fi
  fi
done

# ----- install, build and discover functions -------------------------------------------------------------
discover() {   # $1 = source dir; prints deployable function ids, one per line
  ( cd "$1" && GCLOUD_PROJECT="$PROJECT" GOOGLE_CLOUD_PROJECT="$PROJECT" node -e '
    const path = require("path");
    const m = require(path.resolve("lib/index.js"));
    const out = new Set();
    const isFn = (v) => v && (typeof v === "function" || typeof v === "object") && (v.__endpoint || v.__trigger);
    const walk = (o, prefix, depth) => {
      let keys = [];
      try { keys = Object.keys(o); } catch (e) { return; }
      for (const k of keys) {
        let v; try { v = o[k]; } catch (e) { continue; }
        if (isFn(v)) out.add(prefix + k);
        else if (v && typeof v === "object" && !Array.isArray(v) && depth < 3 &&
                 Object.getPrototypeOf(v) === Object.prototype) walk(v, prefix + k + "-", depth + 1);
      }
    };
    walk(m, "", 0);
    console.log([...out].sort().join("\n"));
  ' 2>"$STATE/discover-err.log" )
}

ALL=()
SEEN=" "
for cb in "${CODEBASES[@]}"; do
  codebase="${cb%%:*}"; dir="${cb#*:}"
  [ -f "$dir/package.json" ] || die "$dir/package.json not found (codebase '$codebase')"
  if [ "${SKIP_INSTALL:-0}" != "1" ] && { [ ! -d "$dir/node_modules" ] || [ "${FORCE_INSTALL:-0}" = "1" ]; }; then
    say "Installing dependencies in $dir ..."
    if [ -f "$dir/package-lock.json" ]; then
      npm --prefix "$dir" ci --no-audit --no-fund >"$STATE/install-$codebase.log" 2>&1 || { tail -25 "$STATE/install-$codebase.log" >&2; die "npm ci failed in $dir"; }
    else
      npm --prefix "$dir" install --no-audit --no-fund >"$STATE/install-$codebase.log" 2>&1 || { tail -25 "$STATE/install-$codebase.log" >&2; die "npm install failed in $dir"; }
    fi
  fi
  if [ "${SKIP_BUILD:-0}" != "1" ]; then
    say "Building $dir (codebase '$codebase') ..."
    npm --prefix "$dir" run build >"$STATE/build-$codebase.log" 2>&1 || { tail -30 "$STATE/build-$codebase.log" >&2; die "build failed in $dir - fix the TypeScript errors first"; }
  fi
  names="$(discover "$dir")"
  [ -n "$names" ] || { cat "$STATE/discover-err.log" >&2; die "no functions discovered in $dir/lib/index.js"; }
  while IFS= read -r n; do
    n="${n%$'\r'}"; [ -z "$n" ] && continue
    case "$SEEN" in
      *" $n "*) warn "'$n' is defined in two codebases of this repo - keeping the first, skipping $codebase:$n"; continue ;;
    esac
    SEEN="$SEEN$n "
    ALL+=("$codebase:$n")
  done <<< "$names"
done
[ "${#ALL[@]}" -gt 0 ] || die "no functions found"

# ----- helpers for secret versions / env audit (need gcloud + jq) ----------------------------------------
norm() { printf '%s' "$1" | tr 'A-Z_' 'a-z-'; }   # function id -> Cloud Run service name

JQ_AMAP='def amap: ((.spec.template.metadata.annotations // {}) + (.metadata.annotations // {}))["run.googleapis.com/secrets"] // "" | split(",") | map(select(length > 0) | split(":") | {(.[0]): (.[1:] | join(":") | split("/") | last)}) | add // {};'

list_pinned() {   # prints Cloud Run service names that pin an OLD secret version, one per line
  local json="$STATE/run-services.json" secrets s v newest='{}'
  gcloud run services list --project "$PROJECT" --format=json >"$json" 2>"$STATE/gcloud-err.log" || return 1
  secrets="$(jq -r "$JQ_AMAP"' [.[] | amap | to_entries[].value] | unique[]' "$json")" || return 1
  for s in $secrets; do
    v="$(gcloud secrets versions list "$s" --project "$PROJECT" --filter='state=enabled' --sort-by='~createTime' --limit=1 --format='value(name.basename())' 2>/dev/null)"
    [ -n "$v" ] || warn "could not read the newest version of secret '$s' - every numbered pin of it will count as old"
    newest="$(jq -c --arg s "$s" --arg v "$v" '. + {($s): $v}' <<<"$newest")"
  done
  jq -r --argjson newest "$newest" "$JQ_AMAP"'
    .[] | . as $svc | amap as $al
    | [ $svc.spec.template.spec.containers[]? | .env[]? | select(.valueFrom.secretKeyRef) | .valueFrom.secretKeyRef
        | select(.key != "latest" and .key != ($newest[$al[.name] // ""] // "")) ]
    | select(length > 0) | $svc.metadata.name' "$json" | sort -u
}

env_names() {   # $1 = outfile; plain (non-secret) env var NAMES per Cloud Run service, never values
  gcloud run services list --project "$PROJECT" --format=json 2>/dev/null \
    | jq -r '.[] | .metadata.name as $n | .spec.template.spec.containers[]? | .env[]? | select(.value != null) | "\($n)\t\(.name)"' 2>/dev/null \
    | sort -u >"$1"
}

# ----- build the plan ------------------------------------------------------------------------------------
excluded=" $EXCLUDE_DEFAULT $EXCLUDE "
PLAN=()
SKIPPED=()
if [ "${#NAMES[@]}" -gt 0 ]; then
  for want in "${NAMES[@]}"; do
    found=""
    case "$want" in
      *:*) for e in "${ALL[@]}"; do [ "$e" = "$want" ] && found="$e"; done ;;
      *)   for e in "${ALL[@]}"; do [ "${e#*:}" = "$want" ] && found="$e"; done ;;
    esac
    [ -n "$found" ] || die "'$want' is not a function of this repo (codebases: ${CODEBASES[*]}). Names are case-sensitive."
    case "$excluded" in *" ${found#*:} "*) warn "'${found#*:}' also exists in another repo; deploying it by name may be refused by the CLI (no deletion happens)." ;; esac
    PLAN+=("$found")
  done
else
  for e in "${ALL[@]}"; do
    case "$excluded" in *" ${e#*:} "*) SKIPPED+=("$e"); continue ;; esac
    PLAN+=("$e")
  done
fi

if [ "$MODE" = "pinned" ]; then
  say "Checking which Cloud Run services pin an old secret version ..."
  list_pinned >"$STATE/pinned-services.txt" || { cat "$STATE/gcloud-err.log" >&2; die "could not read Cloud Run services (gcloud auth / project / permissions?)"; }
  filtered=()
  for e in "${PLAN[@]}"; do
    grep -Fxq -- "$(norm "${e#*:}")" "$STATE/pinned-services.txt" && filtered+=("$e")
  done
  PLAN=(${filtered[@]+"${filtered[@]}"})
fi

DONE_FILE="$STATE/done-$HEAD_SHA.list"
if [ "${#NAMES[@]}" -eq 0 ]; then
  [ "$FRESH" = "1" ] && rm -f "$DONE_FILE"
  if [ -s "$DONE_FILE" ]; then
    remaining=()
    for e in ${PLAN[@]+"${PLAN[@]}"}; do grep -Fxq -- "$e" "$DONE_FILE" || remaining+=("$e"); done
    say "Resuming: $(( ${#PLAN[@]} - ${#remaining[@]} )) function(s) already deployed at commit $HEAD_SHA are skipped (use --fresh to redo them)."
    PLAN=(${remaining[@]+"${remaining[@]}"})
  fi
fi

total=${#PLAN[@]}
if [ "$total" -eq 0 ]; then
  say "Nothing to deploy ($REPO_LABEL, mode: $MODE)."
  [ "$MODE" = "pinned" ] && say "No function of this repo is pinned to an old secret version."
  exit 0
fi

batches=$(( (total + BATCH_SIZE - 1) / BATCH_SIZE ))
say
say "Repo: $REPO_LABEL | project: $PROJECT | commit: $HEAD_SHA | mode: $MODE"
say "Plan: $total function(s) in $batches batch(es) of up to $BATCH_SIZE | retries: $RETRIES | pause: ${PAUSE}s"
if [ "${#SKIPPED[@]}" -gt 0 ]; then say "Skipped (name also used by another repo): ${SKIPPED[*]#*:}"; fi
i=0; n=0
while [ "$i" -lt "$total" ]; do
  n=$((n + 1)); say "  Batch $n: ${PLAN[*]:$i:$BATCH_SIZE}"
  i=$((i + BATCH_SIZE))
done

if [ "$DRY_RUN" = "1" ]; then say; say "Dry run - nothing deployed."; exit 0; fi

if [ "$YES" != "1" ]; then
  if [ -t 0 ]; then
    printf '\nDeploy these %s function(s) to %s now? [y/N] ' "$total" "$PROJECT"
    read -r reply
    case "$reply" in y|Y|yes|YES) ;; *) say "Cancelled."; exit 1 ;; esac
  else
    die "not running in a terminal: pass --yes to confirm."
  fi
fi

# ----- deploy ----------------------------------------------------------------------------------------------
CLEANUP_WARN=0
LOG="$STATE/last-deploy.log"

run_deploy() {   # args: codebase:name ...   returns 0 ok, 1 failed (retryable), 2 blocked (CLI refused a deletion)
  local only="" e rc
  for e in "$@"; do only="$only,functions:$e"; done
  only="${only#,}"
  firebase deploy --only "$only" --non-interactive --project "$PROJECT" 2>&1 | tee "$LOG"
  rc=${PIPESTATUS[0]}
  [ "$rc" -eq 0 ] && return 0
  # The functions deployed fine; only the one-time Artifact Registry cleanup-policy step complained.
  if grep -q "could not set up cleanup policy" "$LOG" && grep -q "Functions successfully deployed" "$LOG"; then
    CLEANUP_WARN=1; return 0
  fi
  # The CLI refused to delete a same-named function that is not in this repo's source. Retrying cannot help.
  if grep -q "do not exist in your local source code" "$LOG"; then return 2; fi
  return 1
}

attempt() {   # args: label, codebase:name ...
  local label="$1" attempt_no=1 wait_s="$RETRY_PAUSE" rc; shift
  while [ "$attempt_no" -le "$RETRIES" ]; do
    run_deploy "$@"; rc=$?
    [ "$rc" -eq 0 ] && return 0
    [ "$rc" -eq 2 ] && return 2
    say "$label failed (attempt $attempt_no/$RETRIES)."
    attempt_no=$((attempt_no + 1))
    if [ "$attempt_no" -le "$RETRIES" ]; then
      say "Cooling down ${wait_s}s before retry..."; sleep "$wait_s"; wait_s=$((wait_s * 2))
    fi
  done
  return 1
}

if [ "${ENV_AUDIT:-1}" = "1" ] && [ "$HAVE_GCLOUD" -eq 1 ]; then env_names "$STATE/env-before.txt"; fi

failed=(); blocked=(); okd=()

isolate() {   # args: codebase:name ... ; deploys each one alone (single attempt) so one bad function cannot hold back the rest
  local e rc2 saved="$RETRIES"
  RETRIES=1
  for e in "$@"; do
    attempt "  $e" "$e"; rc2=$?
    if   [ "$rc2" -eq 0 ]; then okd+=("$e"); printf '%s\n' "$e" >>"$DONE_FILE"
    elif [ "$rc2" -eq 2 ]; then blocked+=("$e")
    else failed+=("$e"); fi
  done
  RETRIES="$saved"
}

i=0; batch_no=0
while [ "$i" -lt "$total" ]; do
  batch=("${PLAN[@]:$i:$BATCH_SIZE}")
  batch_no=$((batch_no + 1))
  say
  say "=== Batch $batch_no/$batches: ${batch[*]} ==="
  attempt "Batch $batch_no" "${batch[@]}"; rc=$?
  if [ "$rc" -eq 0 ]; then
    for e in "${batch[@]}"; do okd+=("$e"); printf '%s\n' "$e" >>"$DONE_FILE"; done
  elif [ "$rc" -eq 2 ]; then
    if [ "${#batch[@]}" -gt 1 ]; then
      say "The CLI refused part of this batch. Deploying its functions one by one to isolate the blocker..."
      isolate "${batch[@]}"
    else
      blocked+=("${batch[@]}")
    fi
  else
    if [ "$batch_no" -eq 1 ] && [ "${NO_CANARY:-0}" != "1" ]; then
      failed+=("${batch[@]}")
      say
      say "The first batch failed after $RETRIES attempts - that usually means a systemic problem (login, permissions, build, quota)."
      say "Stopping. Look at: $LOG   (NO_CANARY=1 to keep going anyway)"
      break
    elif [ "${#batch[@]}" -gt 1 ]; then
      say "Batch $batch_no failed after $RETRIES attempts. Trying its functions one by one so a single bad function does not hold the others back..."
      isolate "${batch[@]}"
    else
      failed+=("${batch[@]}")
    fi
  fi
  i=$((i + BATCH_SIZE))
  if [ "$i" -lt "$total" ]; then say "Cooling down ${PAUSE}s before the next batch..."; sleep "$PAUSE"; fi
done

# ----- report ----------------------------------------------------------------------------------------------
say
say "Deployed ${#okd[@]} of $total function(s)."
if [ "$CLEANUP_WARN" -eq 1 ]; then
  say
  say "Note: no Artifact Registry cleanup policy exists yet (old container images pile up). Set it once per region:"
  say "  firebase functions:artifacts:setpolicy --project $PROJECT --location us-central1 --days 3"
  say "  firebase functions:artifacts:setpolicy --project $PROJECT --location africa-south1 --days 3"
fi
if [ "${#blocked[@]}" -gt 0 ]; then
  say
  say "Blocked by the CLI (a function with the same name exists in the project but not in this repo's source, so"
  say "the CLI would have had to delete it - it refused, nothing was deleted):"
  printf '  %s\n' "${blocked[@]}"
  say "These are usually names shared with another repo or region. Deploy them from the repo that owns them."
fi
if [ "${#failed[@]}" -gt 0 ]; then
  say
  say "These functions failed:"
  printf '  %s\n' "${failed[@]}"
  say "Re-run just those with:"
  say "  bash deploy-batches.sh ${failed[*]}"
fi

if [ "$HAVE_GCLOUD" -eq 1 ] && [ "${#okd[@]}" -gt 0 ]; then
  if [ "${ENV_AUDIT:-1}" = "1" ] && [ -s "$STATE/env-before.txt" ]; then
    env_names "$STATE/env-after.txt"
    lost="$(comm -23 "$STATE/env-before.txt" "$STATE/env-after.txt")"
    if [ -n "$lost" ]; then
      say
      say "WARNING: these environment variables existed before the deploy and are gone now (service<TAB>NAME):"
      printf '%s\n' "$lost" | sed 's/^/  /'
      say "They were set outside the repo's .env files. Re-add them to the right .env file and redeploy those functions."
    else
      say "Environment audit: no plain environment variable disappeared."
    fi
  fi
  if [ "${VERIFY:-1}" = "1" ]; then
    if list_pinned >"$STATE/pinned-after.txt" 2>/dev/null; then
      stale=()
      for e in "${okd[@]}"; do grep -Fxq -- "$(norm "${e#*:}")" "$STATE/pinned-after.txt" && stale+=("$e"); done
      if [ "${#stale[@]}" -eq 0 ]; then
        say "Secret check: every function deployed in this run uses the newest secret versions."
      else
        say "Secret check: still pinned to an old secret version: ${stale[*]}"
      fi
    else
      warn "could not run the secret-version check (gcloud access?)."
    fi
  fi
fi

[ "${#failed[@]}" -eq 0 ] && [ "${#blocked[@]}" -eq 0 ] && { say "All batches deployed."; exit 0; }
exit 1
