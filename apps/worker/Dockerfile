# syntax=docker/dockerfile:1
#
# Production image for the Go worker.
#
#   docker build -f apps/worker/Dockerfile -t butler-worker:dev apps/worker
#
# The build context is `apps/worker` itself (this directory is the Go module).
# There is deliberately no local-development stage: `scripts/dev.sh` runs the
# worker as a host process and the architecture forbids using an image for local
# development (docs/architecture-draft.md §4, §13).
#
# The worker holds no WhatsApp session (main.go): every dependency is pure Go, so
# CGO is OFF and the binary is static. There is no auth store to link a SQLite
# driver for — the linked device lives in the Hermes container, not here.

# The builder tracks the language version `go.mod` requires, because the Golang
# images pin GOTOOLCHAIN=local: with an older builder the toolchain cannot fetch
# itself and `go mod download` fails on the module's own `go` directive. Raising
# the module's version means raising this with it.
FROM golang:1.26-bookworm AS builder

WORKDIR /src
ENV CGO_ENABLED=0 GOOS=linux

# Manifests first so `go mod download` is cached across source edits.
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# The main package is the module root, so build `.`. `./...` would fail the day
# a second main package appears under it, because `-o <file>` accepts exactly one.
RUN go build -trimpath -ldflags="-s -w" -o /out/worker .


FROM debian:bookworm-slim AS production

# ca-certificates: TLS to MongoDB, Cloudflare R2 and the Hermes bridge.
# curl: the HEALTHCHECK below — the slim base ships no HTTP client.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 butler \
 && useradd --system --uid 10001 --gid butler --home-dir /app --shell /usr/sbin/nologin butler \
 && mkdir -p /app \
 && chown -R butler:butler /app

WORKDIR /app
ENV PORT=4000

COPY --from=builder /out/worker /usr/local/bin/worker

# There is deliberately no data volume: the linked-device keys are Hermes's, and
# this container's only durable dependency is MongoDB. A worker that still kept a
# credential on disk would race the console's own session for the same account.

USER butler

EXPOSE 4000

# The port the container actually bound — the config reads PORT, and a platform
# may set it. Probing the declared default instead would report a healthy worker
# as unhealthy and have it restarted.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-4000}/health" || exit 1

CMD ["worker"]
