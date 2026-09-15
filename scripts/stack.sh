#!/usr/bin/env bash
# The launcher both entry points share: `scripts/dev.sh` (a development server)
# and `scripts/prod.sh` (built assets, production process). SOURCED, never run.
#
# What is here is everything the two have in common, which is nearly all of it:
# the environment preflight, the R2 preflight, the mongodb replica set in Docker,
# and the supervision of two host processes with prefixed logs and one shutdown
# path. What differs between them is three commands and a label, and those are
# the caller's to declare:
#
#   STACK_NAME       "dev" or "prod" — every log line and error message
#   STACK_USAGE      the usage text, printed by -h and by a bad flag
#   STACK_ENV_FILE   the environment file, resolved by the caller from its own
#                    override variable (DEV_ENV_FILE / PROD_ENV_FILE)
#   STACK_WEB_CMD    array: the BFF process
#   STACK_WORKER_CMD array: the worker process
#   stack_build()    optional; runs after the preflight and before either child
#                    starts, and aborts the run by returning non-zero
#   stack_preflight_extra()  optional; the mode's own requirements, checked with
#                    the rest of the preflight and in `--check` too
#
# The two processes are host processes in both modes. Docker runs the mongodb
# replica set and nothing else; neither entry point builds or starts an image.
set -Eeuo pipefail

STACK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$STACK_ROOT/infra/dev/docker-compose.yml"
ENV_TEMPLATE="$STACK_ROOT/.env.example"

c_reset=$'\033[0m'; c_dev=$'\033[36m'; c_err=$'\033[31m'
log() { printf '%s[%s]%s %s\n' "$c_dev" "$STACK_NAME" "$c_reset" "$*"; }
die() { printf '%s[%s]%s %s\n' "$c_err" "$STACK_NAME" "$c_reset" "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"; }

# --- flags -------------------------------------------------------------------
stack_parse_flags() {
  STACK_MODE="run"
  START_INFRA=1
  for arg in "$@"; do
    case "$arg" in
      --check) STACK_MODE="check" ;;
      --no-infra) START_INFRA=0 ;;
      -h | --help)
        printf '%s\n' "$STACK_USAGE"
        exit 0
        ;;
      *)
        printf '[%s] unknown flag: %s\n' "$STACK_NAME" "$arg" >&2
        printf 'usage: %s\n' "$(printf '%s' "$STACK_USAGE" | tail -1)" >&2
        exit 2
        ;;
    esac
  done
}

# --- environment and storage preflight ---------------------------------------
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
    "R2_BUCKET|the name of the bucket this stack writes to"
  )
  local entry name hint
  for entry in "${hints[@]}"; do
    name="${entry%%|*}"
    hint="${entry#*|}"
    if r2_unset_or_placeholder "${!name:-}"; then missing+=("$name — $hint"); fi
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    printf '%s[%s]%s media storage requires Cloudflare R2 (there is no local S3 emulator):\n' "$c_err" "$STACK_NAME" "$c_reset" >&2
    printf '  - %s\n' "${missing[@]}" >&2
    die "fill these in $STACK_ENV_FILE (see .env.example) and re-run"
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

stack_preflight_env() {
  [[ -f "$STACK_ENV_FILE" ]] || die "missing $STACK_ENV_FILE — run: cp .env.example .env"
  [[ -f "$ENV_TEMPLATE" ]] || die "missing $ENV_TEMPLATE — this repository ships it; restore it before running the stack"
  # The environment file is SOURCED (never eval'd): `set -a` exports what it
  # assigns and quoting inside it is honoured by the shell parser itself.
  #
  # It is read once in a subshell first, and only then here. A value containing an
  # unquoted `$` — the owner password hash `bun run auth:hash` prints is
  # `scrypt$16384$8$1$…` — is expanded by the shell, and under `set -u` that aborts
  # the whole script: the operator would get bash's own "unbound variable" against
  # a line number and nothing telling them which file or what to do about it.
  if ! (set -a; . "$STACK_ENV_FILE") >/dev/null; then
    die "could not read $STACK_ENV_FILE — the file is sourced by the shell, so a value containing \$ must be quoted. The password hash from 'bun run auth:hash' is written OWNER_PASSWORD_HASH='scrypt\$16384\$…' (single quotes); see the note in .env.example"
  fi
  set -a
  # shellcheck disable=SC1090
  . "$STACK_ENV_FILE"
  set +a
  : "${MONGODB_URI:?MONGODB_URI is not set — see .env.example}"
  validate_r2
  # A mode's own requirements, which are the ones the other mode must not be held
  # to. Defined by `scripts/prod.sh`, absent in development.
  if declare -F stack_preflight_extra >/dev/null; then stack_preflight_extra; fi
  log "config: mongo_db=\"${MONGODB_DB:-group_butler}\" r2_bucket=\"$R2_BUCKET\" endpoint=$R2_ENDPOINT_DERIVED"
}

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

stack_start_infra() {
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
}

# --- child processes ---------------------------------------------------------
# Each child gets its own process group (setsid) so one signal reaches `go run`
# and its compiled worker process. Output goes through a FIFO so prefixing also
# covers Go compilation errors without placing a child in a pipeline whose exit
# status we would lose.
RUNDIR=""
CHILD_PIDS=()
LOGGER_PIDS=()
HAVE_SETSID=0
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

stack_cleanup() {
  local status=$?
  [[ "$CLEANED" == "1" ]] && return
  CLEANED=1
  # Repeated INT/TERM are ignored, not restored to their default action: the
  # default disposition kills this shell mid-shutdown and abandons everything
  # below — the escalation, the reaping, the FIFO cleanup and any teardown.
  trap '' INT TERM
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

  # Docker is only stopped when this run actually started it AND teardown was
  # explicitly opted into: re-initialising the replica set on every Ctrl-C would
  # waste the operator's time, and a --no-infra run must never stop a stack that
  # belongs to whoever started it.
  if [[ "$START_INFRA" == "1" && "${DEV_STOP_INFRA:-0}" == "1" ]]; then
    log "stopping infra (DEV_STOP_INFRA=1)"
    compose down || true
  elif [[ "$START_INFRA" == "1" ]]; then
    log "infra left running — stop it with: bun run dev:down"
  fi
  exit "$status"
}

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

# --- main --------------------------------------------------------------------
stack_main() {
  stack_parse_flags "$@"
  stack_preflight_env
  stack_start_infra

  if [[ "$STACK_MODE" == "check" ]]; then
    log "check ok: env present and complete (incl. R2), no application process started"
    exit 0
  fi

  RUNDIR="$(mktemp -d "${TMPDIR:-/tmp}/butler-$STACK_NAME.XXXXXX")"
  HAVE_SETSID=0
  command -v setsid >/dev/null 2>&1 && HAVE_SETSID=1
  trap stack_cleanup EXIT
  trap 'exit $((128 + 2))' INT
  trap 'exit $((128 + 15))' TERM

  # The caller's build (if it has one) runs once the environment is proven and
  # before either child starts: a stack that half-started around a failed build
  # would serve whatever was built last, which is the thing a production run
  # exists to rule out.
  if declare -F stack_build >/dev/null; then
    log "building"
    stack_build || die "build failed (exit $?) — nothing was started"
  fi

  start_child web "${STACK_WEB_CMD[@]}"
  start_child worker "${STACK_WORKER_CMD[@]}"

  log "started; Ctrl-C stops both"
  set +e
  wait -n "${CHILD_PIDS[@]}"
  child_status=$?
  set -e
  log "a child process exited (status $child_status) — stopping the other"
  exit "$child_status"
}
