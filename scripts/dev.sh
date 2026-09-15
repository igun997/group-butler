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
#
# The launcher itself — preflight, infra, supervision, shutdown — is
# `scripts/stack.sh`, shared with `scripts/prod.sh`. What is decided here is only
# what makes this the development stack: the two commands, and that the BFF is
# `next dev` rather than a built server.
set -Eeuo pipefail

STACK_NAME="dev"
STACK_USAGE='usage: scripts/dev.sh [--check] [--no-infra]'
STACK_ENV_FILE="${DEV_ENV_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.env}"

# shellcheck source=scripts/stack.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/stack.sh"

STACK_WEB_CMD=(bun run --cwd "$STACK_ROOT/apps/web" dev)
# Run the worker through Go rather than a prebuilt binary. This keeps compilation
# and supervision in the same child process, and it runs from apps/worker because
# the dev whatsmeow store is relative to that working directory.
STACK_WORKER_CMD=(bash -c "cd '$STACK_ROOT/apps/worker' && exec go run ./...")

stack_main "$@"
