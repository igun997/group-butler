# syntax=docker/dockerfile:1
#
# Production image for the Next.js BFF / dashboard.
#
# The build context is the REPOSITORY ROOT, not apps/web:
#
#   docker build -f apps/web/Dockerfile -t butler-web:dev .
#
# A context rooted at apps/web cannot work: the image installs the bun workspace
# (root package.json + bun.lock + packages/shared) and Next's `output:
# "standalone"` trace root is the repository root, which is what puts the server
# at apps/web/server.js below. docs/architecture-draft.md §12.1.

FROM oven/bun:1.3 AS deps

WORKDIR /app

# Manifests only, so dependency installation is cached across source edits.
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN bun install --frozen-lockfile


FROM oven/bun:1.3 AS builder

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# bun installs workspace dependencies into each workspace's own node_modules
# (apps/web/node_modules holds next/react and the .bin shims, not the root), so
# the whole installed /app tree is the dependency layer — copying only
# /app/node_modules leaves `next` off PATH.
COPY --from=deps /app ./
COPY . .

# Next serves ./public when the directory exists, and the runtime stage copies it
# unconditionally; creating it here keeps that COPY valid on a tree that has no
# static assets yet.
RUN mkdir -p apps/web/public

# apps/web/next.config.ts must keep `output: "standalone"` — this COPY below has
# nothing to take without it.
RUN bun run --cwd apps/web build


FROM node:22-alpine AS production

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs

# The binaries the media tools read bytes with, and they belong in the runtime
# image rather than in the build: a missing one does not break the container, it
# makes every attachment of that kind unreadable — `status=stored`,
# `mime=image/jpeg`, and an owner told the bot cannot read their picture. The tool
# path names them exactly: ImageMagick (`magick`/`convert`) for any image,
# poppler's `pdftotext` for PDF text, `ffmpeg`/`ffprobe` for a video's frames.
# `unzip` already ships with the base and reads DOCX and XLSX.
#
# This was missing, and the failure it caused is worth the paragraph: on a host
# every one of these exists, so the same code read every image in development and
# read none in the deployed image.
RUN apk add --no-cache imagemagick poppler-utils ffmpeg \
 # Imagick and poppler install what the tools call; the legacy `convert` name is
 # what older deployments invoke, and alpine's v7 keeps it as a symlink only in
 # the `imagemagick` package's own layout, so it is made explicit here.
 && (command -v convert >/dev/null || ln -s "$(command -v magick)" /usr/local/bin/convert)

COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public

USER nextjs

EXPOSE 3000

# busybox wget ships with the alpine base; it exits non-zero on an HTTP error
# status, so a 503 health route marks the container unhealthy.
# The port the container actually bound, not the one this image declares: the
# server reads PORT, and a platform that sets it — Easypanel and friends inject
# one — would otherwise leave the healthcheck probing a port nothing listens on.
# The container would then report unhealthy and be restarted while it was serving
# perfectly well on another port.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-3000}/api/health" || exit 1

CMD ["node", "apps/web/server.js"]
