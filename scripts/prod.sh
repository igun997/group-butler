#!/usr/bin/env bash
# Production entry point: the built BFF and the compiled worker, on this host.
#
#   bun run prod                         # build what is missing, then run
#   bun run prod --force                 # rebuild both, then run
#   bun run prod:check                   # validate env + R2 + mongo, build nothing
#   bash scripts/prod.sh --check --no-infra  # offline validation, never touches Docker
#   DEV_STOP_INFRA=1 bun run prod        # also stop the infra containers on exit
#
# Docker runs the mongodb replica set and nothing else, exactly as in development.
# The difference from `scripts/dev.sh` is what runs on the host:
#
#   web     `next build`, then the standalone server the image runs
#   worker  `go build`, then the binary     — not `go run`
#
# The web side is the deployment's own entry point, not `next start`: this app is
# built with `output: "standalone"` as a contract with `apps/web/Dockerfile`, and
# Next warns that `next start` does not work with that output. What the image
# copies in — `apps/web/.next/static` and `apps/web/public`, which the standalone
# trace leaves out — is linked from the build here, so the host run serves the same
# tree the container does.
#
# A build is kept, not repeated: `next build` writes `apps/web/.next` and the worker
# is compiled to `apps/worker/whatsapp-worker`, so a restart after a code change
# rebuilds only what is missing and a run over an unchanged tree starts in seconds.
# `--force` rebuilds both, which is what a change to the code needs when the
# artifacts are already there — neither tool can tell this working tree from the
# one it built last.
#
# `next start` sets NODE_ENV=production, which is not cosmetic here: the owner
# console refuses the development plaintext password and marks its session cookie
# `Secure` — see the preflight below, which fails before anything starts rather
# than at a login that cannot succeed.
#
# The launcher itself (preflight, infra, supervision, shutdown) is
# `scripts/stack.sh`, shared with `scripts/dev.sh`.
set -Eeuo pipefail

STACK_NAME="prod"
STACK_USAGE='usage: scripts/prod.sh [--check] [--no-infra] [--force]'
STACK_ENV_FILE="${PROD_ENV_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.env}"

# shellcheck source=scripts/stack.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/stack.sh"

# Where the compiled worker lives between runs, and whether this run was asked to
# rebuild whatever is already there. The name is the one .gitignore already
# excludes as this worker's build output.
PROD_WORKER_BIN="$STACK_ROOT/apps/worker/whatsapp-worker"
# The standalone trace root is the repository root (`next.config.ts`), so the
# server lands at `apps/web/server.js` inside the standalone tree — the file the
# Dockerfile's CMD names, relative to where it is copied.
PROD_WEB_STANDALONE="$STACK_ROOT/apps/web/.next/standalone"
PROD_WEB_SERVER="$PROD_WEB_STANDALONE/apps/web/server.js"
# The port this app's BFF listens on. It is not `.env`'s PORT: that one belongs to
# the worker (4000), and the image sets 3000 for the web container explicitly.
PROD_WEB_PORT="${WEB_PORT:-3000}"
PROD_FORCE=0

# `--force` is this mode's only flag, so it is taken out of the arguments here and
# the rest is left to the shared parser: a flag the launcher does not know is still
# rejected there, with the usage line above.
stack_args=()
for arg in "$@"; do
  case "$arg" in
    --force) PROD_FORCE=1 ;;
    *) stack_args+=("$arg") ;;
  esac
done

# The two things a production run needs that a development run does not, checked
# before anything is built.
#
# `verifyOwnerCredentials` reads `OWNER_PASSWORD_HASH` and refuses the plaintext
# `OWNER_PASSWORD` whenever either production marker is set — and `next start`
# sets one. A deployment that only ever ran `next dev` therefore has a console
# that cannot be logged into at all, and it should say so here, with the command
# that fixes it, rather than after a build and a start.
stack_preflight_extra() {
  if [[ -z "${OWNER_PASSWORD_HASH:-}" ]]; then
    if [[ -n "${OWNER_PASSWORD:-}" ]]; then
      die "OWNER_PASSWORD_HASH is empty and OWNER_PASSWORD is not: a production build refuses the plaintext password, so the console could not be logged into. Run: bun run auth:hash '<password>'  and put the result in $STACK_ENV_FILE as OWNER_PASSWORD_HASH"
    fi
    die "OWNER_PASSWORD_HASH is empty, so the console could not be logged into. Run: bun run auth:hash '<password>'  and put the result in $STACK_ENV_FILE"
  fi
  local auth_secret="${AUTH_SECRET:-}"
  if [[ "${#auth_secret}" -lt 32 ]]; then
    die "AUTH_SECRET must be at least 32 characters (it signs the owner session, and a shorter one is refused) — see .env.example"
  fi
  # The session cookie is `Secure` in production. That is right, and it is also
  # the one thing here that a browser decides: localhost is a secure context and
  # accepts the cookie, any other host reached over plain HTTP is not, and the
  # login would appear to succeed and then bounce. Worth one line now.
  log "note: the session cookie is Secure in production — reach the console at http://localhost:3000 (localhost is a secure context), not over a LAN address or plain HTTP on another host"
}

# Builds what is missing, then writes the worker command — which can only be
# written once the binary it names exists.
#
# The two artifacts are judged separately so a worker change does not force a
# `next build`, and each is judged by the file the tool itself produces: a `.next`
# directory without a build id in it is the leftover of a failed build, and a
# missing binary is a binary that was never compiled.
stack_build() {
  local built=0

  if [[ "$PROD_FORCE" == "1" || ! -f "$PROD_WEB_SERVER" ]]; then
    need bun
    log "building the BFF (next build)"
    bun run --cwd "$STACK_ROOT/apps/web" build || return 1
    built=1
  fi
  [[ -f "$PROD_WEB_SERVER" ]] || {
    log "the build produced no standalone server at $PROD_WEB_SERVER"
    return 1
  }

  if [[ "$PROD_FORCE" == "1" || ! -x "$PROD_WORKER_BIN" ]]; then
    need go
    log "building the worker (go build)"
    (cd "$STACK_ROOT/apps/worker" && go build -o "$PROD_WORKER_BIN" .) || return 1
    built=1
  fi

  if [[ "$built" == "0" ]]; then
    log "reusing the existing builds — bun run prod --force rebuilds both"
  fi

  # What the image copies into the standalone tree, because the server serves them
  # from beside itself and the trace does not include them. Linked rather than
  # copied so the next build is what is served, and idempotent for a reuse.
  local app_dir="$PROD_WEB_STANDALONE/apps/web"
  mkdir -p "$app_dir/.next"
  ln -sfn "$STACK_ROOT/apps/web/.next/static" "$app_dir/.next/static"
  if [[ -d "$STACK_ROOT/apps/web/public" ]]; then
    ln -sfn "$STACK_ROOT/apps/web/public" "$app_dir/public"
  fi

  # Run from apps/worker for the same reason as in development: the whatsmeow
  # store is relative to that working directory.
  STACK_WORKER_CMD=(bash -c "cd '$STACK_ROOT/apps/worker' && exec '$PROD_WORKER_BIN'")
}

# The image's CMD (`node apps/web/server.js`) with the image's PORT and HOSTNAME,
# run from the standalone root so those relative paths resolve.
STACK_WEB_CMD=(bash -c "cd '$PROD_WEB_STANDALONE' && exec env PORT='$PROD_WEB_PORT' HOSTNAME='0.0.0.0' NEXT_TELEMETRY_DISABLED=1 node 'apps/web/server.js'")

stack_main "${stack_args[@]+"${stack_args[@]}"}"
