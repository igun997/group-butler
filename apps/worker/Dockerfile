# syntax=docker/dockerfile:1
#
# Production image for the Go whatsmeow worker.
#
#   docker build -f apps/worker/Dockerfile -t butler-worker:dev apps/worker
#
# The build context is `apps/worker` itself (this directory is the Go module).
# There is deliberately no local-development stage: `scripts/dev.sh` runs the
# worker as a host process and the architecture forbids using an image for local
# development (docs/architecture-draft.md §4, §13).
#
# CGO is mandatory — mattn/go-sqlite3 (the whatsmeow auth store) links libc — so
# the build runs on the Debian-based golang image and the runtime must be
# glibc-based (docs/architecture-draft.md §12.1).

# The builder tracks the language version `go.mod` requires, because the Golang
# images pin GOTOOLCHAIN=local: with an older builder the toolchain cannot fetch
# itself and `go mod download` fails on the module's own `go` directive. Raising
# the module's version means raising this with it.
FROM golang:1.26-bookworm AS builder

WORKDIR /src
ENV CGO_ENABLED=1 GOOS=linux

# Manifests first so `go mod download` is cached across source edits.
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# The main package is the module root, so build `.`. `./...` would fail the day
# a second main package appears under it, because `-o <file>` accepts exactly one.
RUN go build -trimpath -ldflags="-s -w" -o /out/worker .


FROM debian:bookworm-slim AS production

# ca-certificates: TLS to MongoDB, Cloudflare R2 and the WhatsApp servers.
# curl: the HEALTHCHECK below — the slim base ships no HTTP client.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 butler \
 && useradd --system --uid 10001 --gid butler --home-dir /app --shell /usr/sbin/nologin butler \
 && mkdir -p /app /data \
 && chown -R butler:butler /app /data

WORKDIR /app
ENV PORT=4000

COPY --from=builder /out/worker /usr/local/bin/worker

# The whatsmeow auth store lives on this volume, so a container restart never
# loses the linked device. A named volume inherits this directory's ownership
# (butler:butler) when Docker first creates it; a bind mount does not, so an
# operator using one must chown it. WHATSMEOW_DB_URI has to point inside /data
# (see apps/worker/.env.production.example): the worker rejects the relative
# development default once ENVIRONMENT=production, and a path outside the volume
# would re-pair the device on every restart.
VOLUME ["/data"]

USER butler

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:4000/health || exit 1

CMD ["worker"]
