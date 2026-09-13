#!/usr/bin/env bash
# Local development entry point (docs/architecture-draft.md §13).
#
#   bun run dev:local                    # infra up, then web + worker as host processes
#   bun run dev:check                    # validate env + R2 + mongo, start no app
#   bash scripts/dev.sh --check --no-infra   # offline validation, never touches Docker
#   DEV_STOP_INFRA=1 bun run dev:local   # also stop the infra containers on exit
#
# Docker runs the local infrastructure ONLY (the mongodb replica set). The BFF and
# the Go worker always run as host processes; this script never builds or starts
# their images. Media storage is a real Cloudflare R2 bucket in every environment,
# so the R2 credentials are preflighted before anything starts.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT/infra/dev/docker-compose.yml"
ENV_TEMPLATE="$ROOT/.env.example"
# The environment file is SOURCED (never eval'd): `set -a` exports what it assigns
# and quoting inside it is honoured by the shell parser itself.
ENV_FILE="${DEV_ENV_FILE:-$ROOT/.env}"

MODE="run"
START_INFRA=1
for arg in "$@"; do
  case "$arg" in
    --check) MODE="check" ;;
    --no-infra) START_INFRA=0 ;;
    -h | --help) sed -n '2,14p' "$0"; exit 0 ;;
    *)
      printf '[dev] unknown flag: %s\n' "$arg" >&2
      printf 'usage: scripts/dev.sh [--check] [--no-infra]\n' >&2
      exit 2
      ;;
  esac
done

c_reset=$'\033[0m'; c_dev=$'\033[36m'; c_err=$'\033[31m'
log() { printf '%s[dev]%s %s\n' "$c_dev" "$c_reset" "$*"; }
die() { printf '%s[dev]%s %s\n' "$c_err" "$c_reset" "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"; }

# --- environment -------------------------------------------------------------
[[ -f "$ENV_FILE" ]] || die "missing $ENV_FILE — run: cp .env.example .env"
[[ -f "$ENV_TEMPLATE" ]] || die "missing $ENV_TEMPLATE — this repository ships it; restore it before running the stack"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
: "${MONGODB_URI:?MONGODB_URI is not set — see .env.example}"

R2_ENDPOINT_DERIVED=""
r2_unset_or_placeholder() { [[ -z "${1:-}" || "${1}" == REPLACE_WITH_* ]]; }

# Validates the four R2 inputs media persistence needs, then derives the only
# endpoint this project can use. There is no endpoint variable and no emulator:
# an override would be the first step towards a second, divergent storage path.
validate_r2() {
  local missing=()
  local hints=(
    "R2_ACCOUNT_ID|Cloudflare dashboard → R2 → Overview → Account ID"
    "R2_ACCESS_KEY_ID|Cloudflare dashboard → R2 → Manage API Tokens → Access Key ID"
    "R2_SECRET_ACCESS_KEY|Cloudflare dashboard → R2 → Manage API Tokens → Secret Access Key"
    "R2_BUCKET|the name of your DEV bucket (do not point local dev at production)"
  )
  local entry name hint
  for entry in "${hints[@]}"; do
    name="${entry%%|*}"
    hint="${entry#*|}"
    if r2_unset_or_placeholder "${!name:-}"; then missing+=("$name — $hint"); fi
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    printf '%s[dev]%s media storage requires Cloudflare R2 (there is no local S3 emulator):\n' "$c_err" "$c_reset" >&2
    printf '  - %s\n' "${missing[@]}" >&2
    die "fill these in $ENV_FILE (see .env.example) and re-run: bun run dev:local"
  fi

  R2_ENDPOINT_DERIVED="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
  local endpoint="$R2_ENDPOINT_DERIVED"

  # An authenticated probe runs when the AWS CLI is present; otherwise a
  # reachability probe. 403 is a success here: it proves the endpoint is live and
  # credential-gated, which is what an unauthenticated request should see.
  if command -v aws >/dev/null 2>&1; then
    if ! AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
      aws --endpoint-url "$endpoint" s3api head-bucket --bucket "$R2_BUCKET" >/dev/null 2>&1; then
      die "R2 rejected the credentials or bucket '$R2_BUCKET' at $endpoint — check the token's R2 permissions and the bucket name"
    fi
    log "r2 ok (authenticated): bucket=$R2_BUCKET endpoint=$endpoint"
    return 0
  fi

  need curl
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$endpoint/$R2_BUCKET" || echo 000)"
  case "$code" in
    200 | 301 | 403) log "r2 ok (reachable): bucket=$R2_BUCKET endpoint=$endpoint" ;;
    000) die "cannot reach $endpoint — check your network/VPN and that R2_ACCOUNT_ID is correct" ;;
    *) die "unexpected response $code from $endpoint/$R2_BUCKET — check R2_ACCOUNT_ID and the bucket name" ;;
  esac
}

validate_r2
log "config: mongo_db=\"${MONGODB_DB:-group_butler}\" r2_bucket=\"$R2_BUCKET\" endpoint=$R2_ENDPOINT_DERIVED"

# --- infrastructure ----------------------------------------------------------
compose() { docker compose -f "$COMPOSE_FILE" "$@"; }

wait_for_mongo() {
  local i out
  for i in $(seq 1 60); do
    out="$(compose exec -T mongo mongosh --quiet --eval 'try{rs.status().ok}catch(e){0}' 2>/dev/null || echo 0)"
    [[ "$out" == "1" ]] && return 0
    sleep 1
  done
  return 1
}

if [[ "$START_INFRA" == "1" ]]; then
  need docker
  docker compose version >/dev/null 2>&1 || die "docker compose v2 plugin is required"
  log "starting infra (mongodb replica set) — apps run on the host, not in Docker"
  compose up -d
  log "waiting for the mongodb replica set..."
  wait_for_mongo || die "mongodb replica set never became ready — inspect: docker compose -f infra/dev/docker-compose.yml logs mongo-init"
else
  log "infra untouched (--no-infra)"
fi

if [[ "$MODE" == "check" ]]; then
  log "check ok: env present and complete (incl. R2), no application process started"
  exit 0
fi

# --- application processes ---------------------------------------------------
need bun
need go

# Each child gets its own process group (setsid) so one signal reaches `go run`
# AND the compiled binary it spawns. Output goes through a FIFO so the prefixing
# happens here — which also covers `go run` compile errors — without putting a
# child inside a pipeline whose exit status we would lose.
RUNDIR="$(mktemp -d "${TMPDIR:-/tmp}/butler-dev.XXXXXX")"
CHILD_PIDS=()
LOGGER_PIDS=()
HAVE_SETSID=0
command -v setsid >/dev/null 2>&1 && HAVE_SETSID=1
CLEANED=0

signal_children() {
  local sig="$1" pid
  for pid in "${CHILD_PIDS[@]:-}"; do
    [[ -z "$pid" ]] && continue
    if [[ "$HAVE_SETSID" == "1" ]]; then kill "-$sig" "-$pid" 2>/dev/null || true
    else kill "-$sig" "$pid" 2>/dev/null || true; fi
  done
}

# Liveness is read from the job table rather than `kill -0`: a child that has
# exited but not yet been reaped is still signalable (a zombie), so `kill -0`
# would report a finished process as running and stall the shutdown loop.
# `jobs -rp` lists only *running* jobs. The redirect is intentional: running
# `jobs` inside a command substitution would inspect the subshell's empty job
# table instead of ours.
children_alive() {
  jobs -rp >"$RUNDIR/running" 2>/dev/null || true
  local line pid
  while read -r line; do
    for pid in "${CHILD_PIDS[@]:-}"; do
      [[ -n "$pid" && "$line" == "$pid" ]] && return 0
    done
  done <"$RUNDIR/running"
  return 1
}

cleanup() {
  local status=$?
  [[ "$CLEANED" == "1" ]] && return
  CLEANED=1
  trap - INT TERM EXIT
  log "shutting down"

  signal_children TERM
  local i
  for i in $(seq 1 100); do
    children_alive || break
    sleep 0.05
  done
  signal_children KILL
  for pid in "${CHILD_PIDS[@]:-}"; do [[ -n "$pid" ]] && wait "$pid" 2>/dev/null || true; done
  for pid in "${LOGGER_PIDS[@]:-}"; do [[ -n "$pid" ]] && kill -TERM "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  rm -rf "$RUNDIR"

  # Docker is only stopped when explicitly opted in: re-initialising the replica
  # set on every Ctrl-C would waste the operator's time.
  if [[ "${DEV_STOP_INFRA:-0}" == "1" ]]; then
    log "stopping infra (DEV_STOP_INFRA=1)"
    compose down || true
  elif [[ "$START_INFRA" == "1" ]]; then
    log "infra left running — stop it with: bun run dev:down"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit $((128 + 2))' INT
trap 'exit $((128 + 15))' TERM

start_child() {
  local name="$1"; shift
  local fifo="$RUNDIR/$name.fifo"
  mkfifo "$fifo"
  sed -u "s/^/[$name] /" <"$fifo" &
  LOGGER_PIDS+=("$!")
  if [[ "$HAVE_SETSID" == "1" ]]; then
    setsid "$@" >"$fifo" 2>&1 &
  else
    "$@" >"$fifo" 2>&1 &
  fi
  CHILD_PIDS+=("$!")
  log "started [$name] pid=$!"
}

start_child web bun run --cwd "$ROOT/apps/web" dev
start_child worker bash -c "cd '$ROOT/apps/worker' && exec go run ./..."

log "web=http://127.0.0.1:3000  worker=http://127.0.0.1:${PORT:-4000}  (Ctrl-C stops both)"
set +e
wait -n "${CHILD_PIDS[@]}"
child_status=$?
set -e
log "a child process exited (status $child_status) — stopping the other"
exit "$child_status"
