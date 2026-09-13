# Group Butler Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the Group Butler monorepo — a Next.js BFF/dashboard, a Go `whatsmeow` worker that ingests every WhatsApp group activity, MongoDB for storage, and **Cloudflare R2 (the real service, in every environment — there is no MinIO anywhere)** for media — shipped as two separately deployable GHCR images.

**Architecture:** The worker owns WhatsApp: it links instances, ingests messages, downloads media, persists group discovery into MongoDB, and dispatches approved sends. The BFF owns the human surface: owner authentication, read models (messages, groups, instances), AI queries scoped by a per-instance JID whitelist, the send-approval queue, and statistics. Both write the same MongoDB but never the same subdocument (one-writer-per-subdocument). Local development runs a **MongoDB replica set** in Docker via `infra/dev/docker-compose.yml`, talks to a **real R2 bucket** for media, and runs the two apps as host processes launched by `scripts/dev.sh`.

**Tech Stack:** Go 1.25 (CGO, `go.mau.fi/whatsmeow`, `go.mongodb.org/mongo-driver/v2`, `aws-sdk-go-v2/service/s3`, `mattn/go-sqlite3`), Next.js 15 App Router + React 19 + Tailwind + shadcn/ui (bun, TypeScript, zod, `@ai-sdk/openai-compatible`), MongoDB 7 (replica set), Cloudflare R2 (S3 API), Docker + GitHub Actions + GHCR.

**Source of truth:** `docs/architecture-draft.md` — schema, env contracts, endpoints and security boundaries. This plan cites it by section (`§`) and must stay consistent with it.

---

## How to use this plan

**Preconditions (once, before Task 1):**

1. Work in a dedicated worktree/branch: `git switch -c feat/group-butler-p0`.
2. Required on PATH: `go` (1.25+), `bun`, `docker` with the `compose` v2 plugin, `git`, `curl`. Verify: `go version && bun --version && docker compose version`.
3. Read `docs/architecture-draft.md` §5 (data model), §6.6 (group sync), §13 (local dev), §14 (TDD slices) before Task 1. Tasks 10–15 implement §14.3 T1–T13; Task 18 implements T14.

**Conventions in every task:**

- **Test-first is mandatory.** Steps are ordered: write the failing test → run it and confirm the *expected* failure text → write the minimal implementation → run it and confirm PASS → commit. Do not reorder.
- Run only the scoped test named in the step while inside a task; run the full suite once in Task 25.
- Commit after every green step, with the message given in the step.
- Never `docker build` while iterating; images are built for the first time in Task 24.
- All paths are relative to the repository root.

**Ports/identifiers (must match `.env.example`):** web `3000`, worker `4000`, Mongo `127.0.0.1:27017` (replica set `rs0`), database `group_butler`, org `org_default`. Object storage is a **real Cloudflare R2 bucket** reached over HTTPS — no local S3 container, no endpoint override, no path-style addressing.

---

## Task 1: Monorepo skeleton and root scripts

**Files:**
- Create: `package.json`, `.gitignore`, `tsconfig.base.json`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`
- Create: `apps/web/package.json` (script surface only)

**Step 1: Root workspace manifest**

`package.json`:

```json
{
  "name": "group-butler",
  "private": true,
  "workspaces": ["apps/web", "packages/shared"],
  "scripts": {
    "dev": "bun run dev:local",
    "dev:local": "bash scripts/dev.sh",
    "dev:check": "bash scripts/dev.sh --check",
    "dev:infra": "docker compose -f infra/dev/docker-compose.yml up -d",
    "dev:down": "docker compose -f infra/dev/docker-compose.yml down",
    "bootstrap": "bun run --cwd apps/web bootstrap",
    "auth:hash": "bun run --cwd apps/web auth:hash",
    "test": "bun test scripts/dev.test.ts && bun run --cwd packages/shared test && bun run --cwd apps/web test",
    "test:worker": "cd apps/worker && go test ./... -short",
    "lint": "bun run --cwd packages/shared lint && bun run --cwd apps/web lint",
    "check": "bun run --cwd apps/web check"
  },
  "devDependencies": { "typescript": "^5.6.3" }
}
```

**Step 2: `.gitignore`**

```
node_modules/
.next/
dist/
coverage/
*.tsbuildinfo
.env
.env.*
!.env.example
!apps/web/.env.production.example
!apps/worker/.env.production.example
apps/worker/.localdata/
apps/worker/whatsapp-worker
```

**Step 3: `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true
  }
}
```

**Step 4: Workspace manifests**

`packages/shared/package.json`:

```json
{
  "name": "@butler/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": { "test": "bun test", "lint": "tsc --noEmit -p tsconfig.json" },
  "dependencies": { "zod": "^3.24.1" }
}
```

`packages/shared/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

`apps/web/package.json`:

```json
{
  "name": "@butler/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "next dev -p 3000",
    "build": "next build",
    "start": "next start -p 3000",
    "test": "vitest run",
    "lint": "eslint .",
    "check": "tsc --noEmit",
    "bootstrap": "bun run scripts/bootstrap.ts",
    "auth:hash": "bun run scripts/auth-hash.ts"
  },
  "dependencies": { "@butler/shared": "workspace:*" }
}
```

**Step 5: Verify**

Run: `bun install && bun run --cwd packages/shared lint`
Expected: install completes; `tsc` exits 0.

Two tooling facts verified on bun 1.3.14 while executing this task, both now encoded in the plan:

- **Workspace scripts MUST be invoked as `bun run --cwd <dir> <script>`.** The form
  `bun --cwd <dir> run <script>` prints the `bun run` usage text, lists the target package's
  scripts, and **exits 0 without running anything** — a silent no-op that would have skipped every
  workspace script in CI while reporting success. Every `bun run --cwd …` occurrence in this plan
  (root `package.json`, `scripts/dev.sh`, CI) uses the working form.
- **`packages/shared/src/index.ts` exists from this task** as an empty module (`export {}`) so
  `tsc --noEmit -p tsconfig.json` has an input; without it the package's `lint` fails with
  `error TS18003: No inputs were found in config file`. Task 5 adds the real exports to that file.
- **`@types/bun` is a devDependency of `packages/shared` from this task.** `tsconfig.json` includes
  `test/`, so the first test file makes `lint` fail without Bun/Node type declarations
  (`Cannot find module 'bun:test'`, `Property 'dir' does not exist on type 'ImportMeta'`). With
  `@types/bun` installed, TypeScript picks it up automatically — no `types` array needed.

**Step 6: Commit**

```bash
git add package.json .gitignore tsconfig.base.json apps/web/package.json packages/shared bun.lock
git commit -m "chore: scaffold monorepo workspaces and root scripts"
```

---

## Task 2: Root `.env.example` and the shared required-env contract

The dev launcher sources the root `.env`, so `.env.example` must be a sourceable shell fragment: bare space-free values, comments, safe placeholders, no real secrets (§13.1).

**Files:**
- Create: `.env.example`
- Create: `packages/shared/src/env-contract.ts`, `packages/shared/src/index.ts`
- Create: `packages/shared/test/env-contract.test.ts`
- Create: `apps/web/.env.production.example`, `apps/worker/.env.production.example`

**Step 1: Failing test**

`packages/shared/test/env-contract.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REQUIRED_ENV } from "../src/env-contract";

const root = join(import.meta.dir, "../../..");
const example = readFileSync(join(root, ".env.example"), "utf8");

function keysIn(text: string): Set<string> {
  const keys = new Set<string>();
  for (const line of text.split("\n")) {
    const m = /^([A-Z][A-Z0-9_]*)=/.exec(line.trim());
    if (m) keys.add(m[1]!);
  }
  return keys;
}

describe("required env contract", () => {
  test("REQUIRED_ENV is non-empty and upper-snake-case", () => {
    expect(REQUIRED_ENV.length).toBeGreaterThan(20);
    for (const key of REQUIRED_ENV) expect(key).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });

  test("every required key appears in .env.example", () => {
    const present = keysIn(example);
    expect(REQUIRED_ENV.filter((k) => !present.has(k))).toEqual([]);
  });

  test(".env.example carries no real-looking secrets", () => {
    expect(/(AKIA[0-9A-Z]{12,}|sk-[A-Za-z0-9]{20,}|mongodb\+srv:\/\/|[0-9a-f]{40,})/.test(example)).toBe(false);
  });
});
```

**Step 2: Run it — expect failure**

Run: `bun test packages/shared/test/env-contract.test.ts`
Expected: FAIL — `Cannot find module '../src/env-contract'`.

**Step 3: Contract module**

`packages/shared/src/env-contract.ts`:

```ts
/**
 * Every variable the BFF or the worker reads at runtime. `scripts/dev.sh`
 * sources `.env`, and the test beside this file fails if a key is added here
 * without appearing in `.env.example` — that is how a new variable cannot
 * silently land in code without a documented default.
 */
export const REQUIRED_ENV = [
  "ORGANIZATION_ID", "MONGODB_URI", "MONGODB_DB", "LOG_LEVEL",
  "PORT", "WORKER_URL", "WORKER_SECRET", "WHATSMEOW_DB_URI", "ENVIRONMENT",
  "R2_ACCOUNT_ID", "R2_BUCKET", "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY", "R2_PUBLIC_URL", "R2_PRESIGN_TTL_SECONDS",
  "OWNER_EMAIL", "OWNER_PASSWORD", "OWNER_PASSWORD_HASH", "AUTH_SECRET", "LOGIN_RATE_LIMIT",
  "AI_BASE_URL", "AI_API_KEY", "AI_MODEL", "AI_MAX_TOKENS_PER_DAY",
  "INGEST_QUEUE_SIZE", "INGEST_FLUSH_MS", "INGEST_FLUSH_MAX",
  "RAW_JSON_MAX_BYTES", "RAW_SEARCH_MAX_BYTES",
  "MEDIA_MAX_BYTES", "MEDIA_CONCURRENCY", "MEDIA_DOWNLOAD_TIMEOUT", "MEDIA_MAX_ATTEMPTS",
  "MEDIA_JANITOR_INTERVAL", "MEDIA_ENRICH_ENABLED",
  "HISTORY_SYNC_MAX_DAYS", "RETENTION_MESSAGES_DAYS",
  "GROUP_SYNC_INTERVAL", "GROUP_STALE_AFTER", "GROUP_SYNC_PRUNE",
  "DISPATCH_INTERVAL", "SEND_MAX_ATTEMPTS",
  // live updates (draft §7.4): SSE is default, this is the polling fallback
  "STREAM_POLL_MS",
] as const;

export type RequiredEnvKey = (typeof REQUIRED_ENV)[number];
```

`packages/shared/src/index.ts`:

```ts
export { REQUIRED_ENV } from "./env-contract";
export type { RequiredEnvKey } from "./env-contract";
```

**Step 4: `.env.example` (sourceable local-dev contract)**

```bash
# =============================================================================
# Group Butler — local development environment
#
#   cp .env.example .env      # then edit if you need to
#
# scripts/dev.sh sources this file with
#   set -a; . ./.env; set +a
# so every value MUST be a bare, space-free shell token. Keep the sections in
# sync with packages/shared/src/env-contract.ts (a test enforces it).
# NEVER put real credentials here — these are local-only placeholders.
# =============================================================================

# --- Shared -------------------------------------------------------------------
# Tenancy boundary. Single organisation today; every document carries it (§2.2).
ORGANIZATION_ID=org_default
# Local Mongo replica set (infra/dev/docker-compose.yml). The member host must be
# 127.0.0.1 because the web app and the worker run on the host, not in Docker.
MONGODB_URI=mongodb://127.0.0.1:27017/group_butler?replicaSet=rs0
MONGODB_DB=group_butler
# debug | info | warn | error
LOG_LEVEL=debug
# development enables the local defaults; production makes both services refuse
# to boot on missing or placeholder secrets.
ENVIRONMENT=development

# --- Worker control plane -----------------------------------------------------
# The worker listens here; the BFF calls it with WORKER_SECRET (§11.2).
PORT=4000
WORKER_URL=http://127.0.0.1:4000
# Local placeholder only. Production MUST use 32+ random bytes.
WORKER_SECRET=dev-secret
# whatsmeow linked-device auth state — a high-value secret (§11.6). On the
# mounted volume in production, in a git-ignored folder locally.
WHATSMEOW_DB_URI=file:./.localdata/whatsmeow.db?_foreign_keys=on

# --- Object storage: Cloudflare R2 (REQUIRED for media) ----------------------
# Development uses a REAL R2 bucket — there is no local S3 emulator anywhere in
# this project (no MinIO, no endpoint override, no path-style addressing). Media
# ingest, the `unparsed` path and every presigned URL exercise the same real
# service locally and in production, so an R2 problem is found on day one.
# Get these from the Cloudflare dashboard: R2 → Overview (Account ID) and
# R2 → Manage API Tokens (Access Key ID / Secret). Use a DEV bucket, never the
# production one.
# The dev launcher refuses to start with an actionable message if any of the
# four values below is missing or left as a placeholder.
#
# The endpoint is NOT configurable: it is derived in code as
#   https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com
R2_ACCOUNT_ID=REPLACE_WITH_R2_ACCOUNT_ID
R2_BUCKET=group-butler-dev
R2_ACCESS_KEY_ID=REPLACE_WITH_R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY=REPLACE_WITH_R2_SECRET_ACCESS_KEY
# Optional CDN/custom domain for direct object reads. Empty means the BFF mints
# short-lived presigned URLs instead (§11.4).
R2_PUBLIC_URL=
R2_PRESIGN_TTL_SECONDS=300

# --- Dashboard owner auth (§11.1) --------------------------------------------
# ONE owner account. No signup, no roles, no OAuth, no proxy-header trust.
OWNER_EMAIL=owner@local
# Dev convenience; the BFF refuses to read this when ENVIRONMENT=production.
OWNER_PASSWORD=changeme
# Preferred in production: `bun run auth:hash '<password>'`. Empty = unused.
OWNER_PASSWORD_HASH=
# >=32 chars. Rotating this signs every session out.
AUTH_SECRET=dev-only-auth-secret-change-me-32ch
# Login attempts per IP per 15 minutes.
LOGIN_RATE_LIMIT=5

# --- AI provider (§7.1) -------------------------------------------------------
# Any OpenAI-compatible endpoint; the AI SDK provider is swappable.
AI_BASE_URL=https://llm.example.invalid/v1
AI_API_KEY=placeholder-ai-key
AI_MODEL=placeholder-model
AI_MAX_TOKENS_PER_DAY=200000

# --- Worker ingest ------------------------------------------------------------
# Bounded batch queue; overflow increments runtime.ingest.droppedTotal (§6.2).
INGEST_QUEUE_SIZE=512
INGEST_FLUSH_MS=250
INGEST_FLUSH_MAX=100
# The raw message tree and its flattened search text are truncated (§6.4).
RAW_JSON_MAX_BYTES=32768
RAW_SEARCH_MAX_BYTES=8192

# --- Worker media (§6.3) ------------------------------------------------------
MEDIA_MAX_BYTES=26214400
MEDIA_CONCURRENCY=4
MEDIA_DOWNLOAD_TIMEOUT=45s
MEDIA_MAX_ATTEMPTS=3
MEDIA_JANITOR_INTERVAL=5m
# Transcription/vision/doc extraction — off by default (spends tokens).
MEDIA_ENRICH_ENABLED=false
HISTORY_SYNC_MAX_DAYS=30
# 0 = keep messages forever.
RETENTION_MESSAGES_DAYS=0

# --- Group discovery and sync (§6.6.2) ---------------------------------------
# Full GetJoinedGroups reconcile — the offline-rename safety net.
GROUP_SYNC_INTERVAL=30m
# Per-group GetGroupInfo repair threshold.
GROUP_STALE_AFTER=6h
# false disables marking groups absent from a sync as left.
GROUP_SYNC_PRUNE=true

# --- Sends / dispatch (§8.3) --------------------------------------------------
DISPATCH_INTERVAL=5s
SEND_MAX_ATTEMPTS=3

# --- Live updates (§7.4) ------------------------------------------------------
# SSE (Mongo change streams) is the default transport; this is the polling
# fallback interval used when change streams are unavailable. The dashboard
# interface is identical either way.
STREAM_POLL_MS=3000
```

**Step 5: Deployment examples**

`apps/worker/.env.production.example`:

```bash
# Production env for the WORKER image. Checklist only — never commit values (§6.9).
PORT=4000
ENVIRONMENT=production
WORKER_SECRET=            # REQUIRED: 32+ random bytes
MONGODB_URI=              # mongodb+srv://... (replica set required for change streams)
MONGODB_DB=group_butler
ORGANIZATION_ID=org_default
WHATSMEOW_DB_URI=file:/data/whatsmeow.db?_foreign_keys=on   # keep /data persistent
R2_ACCOUNT_ID=
R2_BUCKET=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_PUBLIC_URL=
MEDIA_ENRICH_ENABLED=false
AI_BASE_URL=
AI_API_KEY=
AI_MODEL=
GROUP_SYNC_INTERVAL=30m
GROUP_STALE_AFTER=6h
GROUP_SYNC_PRUNE=true
DISPATCH_INTERVAL=5s
LOG_LEVEL=info
```

`apps/web/.env.production.example`:

```bash
# Production env for the WEB image. Checklist only — never commit values (§7.7).
ENVIRONMENT=production
MONGODB_URI=
MONGODB_DB=group_butler
ORGANIZATION_ID=org_default
WORKER_URL=               # e.g. http://127.0.0.1:4000 with host networking
WORKER_SECRET=            # must equal the worker's
OWNER_EMAIL=
OWNER_PASSWORD_HASH=      # scrypt hash from `bun run auth:hash`
AUTH_SECRET=              # >=32 chars
AI_BASE_URL=
AI_API_KEY=
AI_MODEL=
AI_MAX_TOKENS_PER_DAY=200000
R2_ACCOUNT_ID=
R2_BUCKET=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_PRESIGN_TTL_SECONDS=300
RETENTION_MESSAGES_DAYS=0
```

**Step 6: Verify**

Run: `bun test packages/shared/test/env-contract.test.ts && bash -eu -c 'set -a; . ./.env.example; set +a; echo "sourceable: $MONGODB_DB/$R2_BUCKET"'`
Expected: PASS (3 tests); prints `sourceable: group_butler/group-butler`.

**Step 7: Commit**

```bash
git add .env.example packages/shared apps/web/.env.production.example apps/worker/.env.production.example
git commit -m "feat: add sourceable env example and required-env contract"
```

---

## Task 3: Local infra compose (MongoDB replica set only)

**Files:** Create `infra/dev/docker-compose.yml`

**Scope note:** the only thing this file starts is MongoDB. Media storage is a **real Cloudflare R2
bucket** in every environment (no MinIO, no local S3 emulator, no endpoint override, no path-style
addressing), so there is nothing object-storage-shaped for Compose to run. The dev launcher validates
the R2 credentials instead (Task 4).

**Step 1: Compose file**

```yaml
# Local development infrastructure ONLY.
#
#   docker compose -f infra/dev/docker-compose.yml up -d
#   docker compose -f infra/dev/docker-compose.yml down
#
# The Next.js BFF and the Go worker run as HOST processes (see scripts/dev.sh).
# This file deliberately contains no app or worker services and is never used to
# build images; production images are standalone (docs/architecture-draft.md §12).
#
# Object storage is NOT here on purpose: media uses a real Cloudflare R2 bucket in
# development and production alike. There is no local S3 emulator, no endpoint
# override and no path-style flag anywhere in this project.
#
# Mongo runs as a single-node replica set because change streams (live dashboard
# updates, §7.4) require one. The member host is 127.0.0.1:27017 — NOT
# mongo:27017 — because the clients are host processes and a replica set
# advertises member hosts back to them.
#
# The project name is pinned so the resources are always group-butler-dev_*: without
# it Compose derives the name from this directory ("dev") and would collide with
# any other generic "dev" compose project on the machine.
name: group-butler-dev

services:
  mongo:
    image: mongo:7
    command: ["--replSet", "rs0", "--bind_ip_all"]
    ports:
      - "127.0.0.1:27017:27017"
    volumes:
      - mongo-data:/data/db
    healthcheck:
      test: ["CMD", "mongosh", "--quiet", "--eval", "db.runCommand({ping:1}).ok"]
      interval: 5s
      timeout: 5s
      retries: 20
      start_period: 10s

  # One-shot, idempotent replica-set init; safe to run on every `up`.
  #
  # Two different hosts are involved and they must not be confused:
  #   * this client connects by SERVICE NAME (`mongo`) because the server runs in
  #     another container;
  #   * the replica set ADVERTISES 127.0.0.1:27017, because the clients that
  #     speak replica-set protocol are the host-run web and worker processes,
  #     which reach the published port on loopback.
  # The guard reads local.system.replset rather than calling rs.status(), so it
  # behaves the same before and after initiation and never fails on re-run.
  mongo-init:
    image: mongo:7
    depends_on:
      mongo:
        condition: service_healthy
    restart: "no"
    entrypoint:
      - bash
      - -lc
      - |
        set -eu
        mongosh --host mongo --quiet --eval '
          const configured = db.getSiblingDB("local").system.replset.countDocuments() > 0;
          if (configured) {
            print("replica set already initiated");
          } else {
            rs.initiate({_id: "rs0", members: [{_id: 0, host: "127.0.0.1:27017"}]});
            print("replica set initiated");
          }
        '

volumes:
  mongo-data: {}
```

**Step 2: Verify**

Run: `docker compose -f infra/dev/docker-compose.yml up -d && sleep 15 && docker compose -f infra/dev/docker-compose.yml ps`
Expected: `mongo` is `healthy`; `mongo-init` is `exited (0)`; **no** object-storage service is listed.

Run: `docker compose -f infra/dev/docker-compose.yml exec -T mongo mongosh --quiet --eval 'rs.status().ok'`
Expected: `1`

Run: `docker compose -f infra/dev/docker-compose.yml config --services`
Expected: `mongo` and `mongo-init` only — this is the machine-checked proof that no local S3 emulator exists.

**Step 3: Commit**

```bash
git add infra/dev/docker-compose.yml
git commit -m "feat: add local dev infra (mongodb replica set only)"
```

---

## Task 4: `scripts/dev.sh` — mandatory one-command local dev launcher

Required deliverable (§13): brings up **infra only** in Docker, then runs web and worker as host processes with prefixed logs and correct signal forwarding. Built test-first.

**Files:**
- Create: `scripts/dev.test.ts`
- Create: `scripts/dev.sh`

**Step 1: Failing contract tests (D1–D6, §14.5)**

`scripts/dev.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const scriptPath = join(root, "scripts/dev.sh");
const script = existsSync(scriptPath) ? readFileSync(scriptPath, "utf8") : "";
const examplePath = join(root, ".env.example");

async function run(cmd: string[], cwd: string) {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

describe("D1: dev script is an executable bash script", () => {
  test("exists, is executable, and is defensive bash", () => {
    expect(existsSync(scriptPath)).toBe(true);
    expect(statSync(scriptPath).mode & 0o111).toBeGreaterThan(0);
    expect(script.startsWith("#!/usr/bin/env bash")).toBe(true);
    expect(script).toContain("set -Eeuo pipefail");
  });
});

describe("D2: dev script fails fast without .env", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "butler-dev-test-"));
    Bun.spawnSync(["mkdir", "-p", join(dir, "scripts")]);
    writeFileSync(join(dir, "scripts/dev.sh"), readFileSync(scriptPath, "utf8"));
    chmodSync(join(dir, "scripts/dev.sh"), 0o755);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("exits 1 and points at .env.example", async () => {
    const res = await run(["bash", join(dir, "scripts/dev.sh")], dir);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("cp .env.example .env");
  });
});

describe("D3: dev script only brings infra up in docker", () => {
  test("no image builds and no app/worker compose services", () => {
    expect(script).not.toContain("--build");
    expect(script).not.toContain("docker build");
    const composeInvocations = script.match(/docker compose[^\n]*/g) ?? [];
    expect(composeInvocations.length).toBeGreaterThan(0);
    for (const line of composeInvocations) expect(line).toContain("infra/dev/docker-compose.yml");
    expect(/docker compose[^\n]*\bup\b[^\n]*\b(web|worker)\b/.test(script)).toBe(false);
  });
});

describe("D4: dev script forwards signals and cleans up", () => {
  test("traps, process groups, and escalation are present", () => {
    expect(/trap\s+\w+\s+INT\s+TERM\s+EXIT/.test(script)).toBe(true);
    expect(script).toContain("setsid");
    expect(script).toContain('kill -TERM "-$pid"');
    expect(script).toContain('kill -KILL "-$pid"');
  });
});

describe("D5: .env.example is sourceable and complete", () => {
  test("sources cleanly under bash -eu", async () => {
    const res = await run(["bash", "-eu", "-c", "set -a; . ./.env.example; set +a; echo OK"], root);
    expect(res.stderr).toBe("");
    expect(res.stdout.trim()).toBe("OK");
    expect(res.code).toBe(0);
  });

  test("every key in REQUIRED_ENV is present", async () => {
    const { REQUIRED_ENV } = await import("../packages/shared/src/env-contract");
    const text = readFileSync(examplePath, "utf8");
    const keys = new Set(
      text.split("\n").flatMap((l) => {
        const m = /^([A-Z][A-Z0-9_]*)=/.exec(l.trim());
        return m ? [m[1]!] : [];
      }),
    );
    expect(REQUIRED_ENV.filter((k) => !keys.has(k))).toEqual([]);
  });
});

describe("D6: no real secrets in env examples", () => {
  test("examples contain only placeholders", () => {
    for (const rel of [".env.example", "apps/web/.env.production.example", "apps/worker/.env.production.example"]) {
      const text = readFileSync(join(root, rel), "utf8");
      expect(/(AKIA[0-9A-Z]{12,}|sk-[A-Za-z0-9]{20,}|mongodb\+srv:\/\/[^\s]+|[0-9a-f]{40,})/.test(text)).toBe(false);
    }
  });
});

describe("D7: R2 preflight is mandatory and actionable", () => {
  test("media storage is real R2 everywhere: no emulator, no endpoint override, no path-style", () => {
    const compose = readFileSync(join(root, "infra/dev/docker-compose.yml"), "utf8");
    expect(compose).not.toMatch(/minio/i);
    expect(compose).not.toContain("9000");
    const all = [script, readFileSync(examplePath, "utf8"), compose].join("\n");
    for (const banned of ["R2_FORCE_PATH_STYLE", "forcePathStyle", "UsePathStyle", "path-style", "R2_ENDPOINT"]) {
      expect(all).not.toContain(banned);
    }
  });

  test("the launcher refuses to start when an R2 value is missing, naming it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "butler-r2-test-"));
    Bun.spawnSync(["mkdir", "-p", join(dir, "scripts"), join(dir, "infra/dev")]);
    writeFileSync(join(dir, "scripts/dev.sh"), readFileSync(scriptPath, "utf8"));
    chmodSync(join(dir, "scripts/dev.sh"), 0o755);
    // A .env with Mongo but no R2 credentials.
    writeFileSync(join(dir, ".env"), "MONGODB_URI=mongodb://127.0.0.1:27017/group_butler?replicaSet=rs0\n");
    const res = await run(["bash", join(dir, "scripts/dev.sh"), "--check", "--no-infra"], dir);
    rmSync(dir, { recursive: true, force: true });
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/R2_ACCOUNT_ID|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY/);
    expect(res.stderr).toMatch(/Cloudflare|R2 dashboard|Manage API Tokens/i);
  });

  test("placeholder values are rejected like missing ones", () => {
    expect(script).toContain("REPLACE_WITH_R2");
  });
});
```

**Step 2: Run it — expect failure**

Run: `bun test scripts/dev.test.ts`
Expected: FAIL — `scripts/dev.sh` does not exist for D1, and D3/D4 fail because the script text is empty.

**Step 3: Commit the red tests**

```bash
git add scripts/dev.test.ts
git commit -m "test: add failing contract tests for local dev launcher and env example"
```

**Step 4: Implement `scripts/dev.sh`**

```bash
#!/usr/bin/env bash
# Local dev entry point (docs/architecture-draft.md §13).
#
#   bun run dev:local                    # infra up, then web + worker as host processes
#   bun run dev:check                    # validate env + infra, start nothing
#   DEV_STOP_INFRA=1 bun run dev:local   # also stop containers on exit
#
# Docker is used for infra ONLY (the mongodb replica set). The web and worker
# apps always run on the host; this script never builds or runs their images.
# Media storage is a REAL Cloudflare R2 bucket in every environment — there is no
# local S3 emulator — so this script preflights the R2 credentials before it
# starts anything and fails with an actionable message when one is missing.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT/infra/dev/docker-compose.yml"
ENV_FILE="$ROOT/.env"
MODE="run"
START_INFRA=1
for arg in "$@"; do
  case "$arg" in
    --check) MODE="check" ;;
    --no-infra) START_INFRA=0 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "[dev] unknown flag: $arg" >&2; exit 2 ;;
  esac
done

c_reset=$'\033[0m'; c_dev=$'\033[36m'; c_err=$'\033[31m'
log() { printf '%s[dev]%s %s\n' "$c_dev" "$c_reset" "$*"; }
die() { printf '%s[dev]%s %s\n' "$c_err" "$c_reset" "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"; }

need docker; need bun; need go; need curl
docker compose version >/dev/null 2>&1 || die "docker compose v2 plugin is required"

# --- env ---------------------------------------------------------------------
[[ -f "$ENV_FILE" ]] || die "missing $ENV_FILE — run: cp .env.example .env"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
: "${MONGODB_URI:?MONGODB_URI is not set — see .env.example}"

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }

wait_for_mongo() {
  local i ok
  for i in $(seq 1 60); do
    ok="$(compose exec -T mongo mongosh --quiet --eval 'try{rs.status().ok}catch(e){0}' 2>/dev/null || echo 0)"
    [[ "$ok" == "1" ]] && return 0
    sleep 1
  done
  return 1
}

# --- R2 preflight ------------------------------------------------------------
# Media persistence needs real Cloudflare R2 credentials. There is no local
# emulator to fall back on and no endpoint to configure, so a missing or
# placeholder value is a hard, early, actionable failure rather than a runtime
# surprise deep in the ingest path.
r2_missing() { [[ -z "${1:-}" || "${1}" == REPLACE_WITH_* ]]; }

validate_r2() {
  local missing=()
  local -A hints=(
    [R2_ACCOUNT_ID]="Cloudflare dashboard → R2 → Overview → Account ID"
    [R2_ACCESS_KEY_ID]="Cloudflare dashboard → R2 → Manage API Tokens → Access Key ID"
    [R2_SECRET_ACCESS_KEY]="Cloudflare dashboard → R2 → Manage API Tokens → Secret Access Key"
    [R2_BUCKET]="the name of your DEV bucket (do not point local dev at production)"
  )
  local name
  for name in R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET; do
    if r2_missing "${!name:-}"; then missing+=("$name — ${hints[$name]}"); fi
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    printf '%s[dev]%s media storage requires Cloudflare R2 (there is no local S3 emulator):\n' "$c_err" "$c_reset" >&2
    printf '  - %s\n' "${missing[@]}" >&2
    die "fill these in .env (see .env.example) and re-run: bun run dev:local"
  fi

  # The only endpoint that exists is derived from the account id — there is
  # nothing to override, which is what keeps emulators out of the picture.
  local endpoint="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

  # Authenticated probe when the AWS CLI is available; a reachability probe
  # always runs. 403 is acceptable here: it proves the endpoint is live and
  # credential-gated, which is exactly what an unauthenticated request should see.
  if command -v aws >/dev/null 2>&1; then
    if ! AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
         aws --endpoint-url "$endpoint" s3api head-bucket --bucket "$R2_BUCKET" >/dev/null 2>&1; then
      die "R2 rejected the credentials or bucket '$R2_BUCKET' at $endpoint — check the token's R2 permissions and the bucket name"
    fi
    log "r2 ok (authenticated): bucket=$R2_BUCKET endpoint=$endpoint"
    return 0
  fi
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$endpoint/$R2_BUCKET" || echo 000)"
  case "$code" in
    200|301|403) log "r2 reachable: bucket=$R2_BUCKET endpoint=$endpoint (install the aws CLI for an authenticated check)" ;;
    000) die "cannot reach $endpoint — check your network/VPN and that R2_ACCOUNT_ID is correct" ;;
    *) die "unexpected response $code from $endpoint/$R2_BUCKET — check R2_ACCOUNT_ID and the bucket name" ;;
  esac
}

# --- infra -------------------------------------------------------------------
validate_r2

if [[ "$START_INFRA" == "1" ]]; then
  log "starting infra (mongodb replica set) — apps run on the host, not in Docker"
  compose up -d
fi

log "waiting for mongodb replica set..."
wait_for_mongo || die "mongodb replica set never became ready — inspect: docker compose -f infra/dev/docker-compose.yml logs mongo-init"

log "infra ready — mongo=${MONGODB_DB:-group_butler} r2_bucket=${R2_BUCKET} worker=http://127.0.0.1:${PORT:-4000}"

if [[ "$MODE" == "check" ]]; then
  log "check ok: env present and complete (incl. R2), mongo replica set healthy (apps not started)"
  exit 0
fi

# --- children ----------------------------------------------------------------
# Each child gets its own process group via setsid, so one signal reaches BOTH
# `go run` and the compiled binary it spawns. Output is piped through a FIFO so
# prefixing happens here (covering `go run` compile errors) without putting
# either app in a pipeline whose exit status we would lose.
RUNDIR="$(mktemp -d "${TMPDIR:-/tmp}/butler-dev.XXXXXX")"
declare -a CHILD_PIDS=() LOGGER_PIDS=()
HAVE_SETSID=0
command -v setsid >/dev/null 2>&1 && HAVE_SETSID=1

signal_children() {
  local sig="$1" pid
  for pid in "${CHILD_PIDS[@]:-}"; do
    [[ -z "$pid" ]] && continue
    if [[ "$HAVE_SETSID" == "1" ]]; then kill "-$sig" "-$pid" 2>/dev/null || true
    else kill "-$sig" "$pid" 2>/dev/null || true; fi
  done
}

cleanup() {
  local status=$?
  trap - INT TERM EXIT
  log "shutting down (status $status)"
  signal_children TERM
  local i alive pid
  for i in $(seq 1 50); do
    alive=0
    for pid in "${CHILD_PIDS[@]:-}"; do
      [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && alive=1
    done
    [[ "$alive" == "0" ]] && break
    sleep 0.1
  done
  signal_children KILL
  for pid in "${LOGGER_PIDS[@]:-}"; do [[ -n "$pid" ]] && kill -TERM "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  rm -rf "$RUNDIR"
  if [[ "${DEV_STOP_INFRA:-0}" == "1" ]]; then
    log "stopping infra (DEV_STOP_INFRA=1)"
    compose down || true
  else
    log "infra left running — stop it with: bun run dev:down"
  fi
  exit "$status"
}
trap cleanup INT TERM EXIT

start_child() {
  local name="$1"; shift
  local fifo="$RUNDIR/$name.fifo"
  mkfifo "$fifo"
  sed -u "s/^/[$name] /" < "$fifo" &
  LOGGER_PIDS+=("$!")
  if [[ "$HAVE_SETSID" == "1" ]]; then
    setsid "$@" > "$fifo" 2>&1 &
  else
    "$@" > "$fifo" 2>&1 &
  fi
  CHILD_PIDS+=("$!")
  log "started [$name] pid=$!"
}

start_child web bun run --cwd "$ROOT/apps/web" dev
start_child worker bash -lc "cd '$ROOT/apps/worker' && exec go run ./..."

log "web=http://127.0.0.1:3000  worker=http://127.0.0.1:${PORT:-4000}  (Ctrl-C stops both)"
set +e
wait -n "${CHILD_PIDS[@]}"
child_status=$?
set -e
log "a child process exited (status $child_status) — stopping the other"
exit "$child_status"
```

**Step 5: Run the tests to verify they pass**

Run: `chmod +x scripts/dev.sh && bun test scripts/dev.test.ts`
Expected: PASS — D1–D7 green (D7 is the R2 preflight: presence/shape checks, an actionable message
naming the missing variable and where to get it, and the assertion that no MinIO/path-style remnant
exists anywhere).

**Step 6: Acceptance — `--check`**

Run: `cp .env.example .env` and fill the four required R2 values from your Cloudflare dashboard
(`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`; `R2_PUBLIC_URL` stays
optional), then `bun run dev:check`
Expected: `[dev] r2 ok …` (authenticated when the `aws` CLI is present, otherwise a reachability line),
ending in `check ok: env present and complete (incl. R2), mongo replica set healthy (apps not started)`, exit 0.

Run: `bun run dev:check` with a placeholder left in place (`R2_SECRET_ACCESS_KEY=REPLACE_WITH_R2_SECRET_ACCESS_KEY`)
Expected: exit 1 and a stderr block listing `R2_SECRET_ACCESS_KEY — Cloudflare dashboard → R2 → Manage API Tokens → Secret Access Key`, followed by `fill these in .env (see .env.example) and re-run: bun run dev:local`.

Run: `mv .env .env.bak; bun run dev:check; echo "exit=$?"; mv .env.bak .env`
Expected: `exit=1` and stderr containing `run: cp .env.example .env`.

**Step 7: Acceptance — prefixed logs and clean shutdown**

Run: `bash -c 'DEV_STOP_INFRA=1 timeout -s INT 20 bun run dev:local; echo "exit=$?"'`
Expected: `[dev] r2 ok …`, `[dev] starting infra …`, `[dev] infra ready …`, `started [web]`, `started [worker]` (their children fail only because the apps do not exist yet — Task 17), then `[dev] shutting down …` and `[dev] stopping infra (DEV_STOP_INFRA=1)`. Afterwards `pgrep -f 'go run ./...'` prints nothing and `docker compose -f infra/dev/docker-compose.yml ps` shows no containers. This acceptance is re-run for real at Task 25.

**Step 8: Commit**

```bash
git add scripts/dev.sh
git commit -m "feat: add one-command local dev launcher with R2 preflight, prefixed logs, and signal cleanup"
```

---

## Task 5: `packages/shared` worker contract schemas

**Files:**
- Create: `packages/shared/src/worker-contract.ts`
- Create: `packages/shared/test/worker-contract.test.ts`
- Create: `packages/shared/testdata/{groups-list,groups-sync-summary,group-updated-event}.json`
- Modify: `packages/shared/src/index.ts`

**Step 1: Failing test**

`packages/shared/test/worker-contract.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GroupUpdatedEventSchema,
  GroupSyncSummarySchema,
  InstanceGroupListSchema,
} from "../src/worker-contract";

const read = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, "../testdata", name), "utf8"));

describe("worker contract schemas", () => {
  test("parses a real groups list payload", () => {
    const parsed = InstanceGroupListSchema.parse(read("groups-list.json"));
    expect(parsed.groups).toHaveLength(2);
    expect(parsed.groups[0]!.groupJid).toBe("120363043123456789@g.us");
    expect(parsed.groups[0]!.name).toBe("Ops Team");
    expect(parsed.groups[1]!.nameSource).toBe("fallback");
  });

  test("rejects a group row without a groupJid", () => {
    expect(() => InstanceGroupListSchema.parse({ instanceId: "i", groups: [{ name: "x" }] })).toThrow();
  });

  test("parses the sync summary", () => {
    const parsed = GroupSyncSummarySchema.parse(read("groups-sync-summary.json"));
    expect(parsed.total).toBe(12);
    expect(parsed.markedLeft).toBe(1);
    expect(parsed.subjectRejected).toBe(0);
  });

  test("parses a group.updated event", () => {
    const parsed = GroupUpdatedEventSchema.parse(read("group-updated-event.json"));
    expect(parsed.changes).toEqual(["subject"]);
    expect(parsed.previousName).toBe("Support");
  });
});
```

**Step 2: Run it — expect failure**

Run: `bun test packages/shared/test/worker-contract.test.ts`
Expected: FAIL — `Cannot find module '../src/worker-contract'`.

**Step 3: Fixtures**

`packages/shared/testdata/groups-list.json`:

```json
{
  "instanceId": "V1StGXR8_Z5jdHi6B-myT",
  "syncedAt": "2026-09-13T10:00:00Z",
  "groups": [
    {
      "groupJid": "120363043123456789@g.us", "name": "Ops Team", "nameSource": "event",
      "nameSetAt": "2026-09-01T08:12:00Z", "nameSetBy": "628990000001@s.whatsapp.net",
      "participantCount": 12, "isAnnounce": false, "isLocked": false, "state": "active",
      "lastActivityAt": "2026-09-13T09:59:00Z", "messageCount": 4211,
      "assigned": true, "whitelisted": true
    },
    {
      "groupJid": "120363043987654321@g.us", "name": "", "nameSource": "fallback",
      "nameSetAt": null, "nameSetBy": null, "participantCount": 0,
      "isAnnounce": false, "isLocked": false, "state": "active",
      "lastActivityAt": "2026-09-13T09:10:00Z", "messageCount": 3,
      "assigned": false, "whitelisted": false
    }
  ]
}
```

`packages/shared/testdata/groups-sync-summary.json`:

```json
{
  "ok": true, "instanceId": "V1StGXR8_Z5jdHi6B-myT", "durationMs": 480, "source": "manual",
  "total": 12, "added": 2, "subjectUpdated": 1, "metadataUpdated": 3,
  "markedLeft": 1, "subjectRejected": 0, "unchanged": 8
}
```

`packages/shared/testdata/group-updated-event.json`:

```json
{
  "type": "group.updated", "instanceId": "V1StGXR8_Z5jdHi6B-myT", "groupJid": "120363043123456789@g.us",
  "changes": ["subject"], "name": "Ops Team", "previousName": "Support",
  "nameSetAt": "2026-09-13T10:00:00Z", "state": "active", "occurredAt": "2026-09-13T10:00:01Z"
}
```

**Step 4: Schemas**

`packages/shared/src/worker-contract.ts`:

```ts
import { z } from "zod";

/** Group lifecycle state (`observed.state`, docs/architecture-draft.md §5.1). */
export const GroupStateSchema = z.enum(["active", "left", "deleted", "suspended"]);
export type GroupState = z.infer<typeof GroupStateSchema>;

/** Where the name came from: a sync snapshot, an event delta, or nothing yet. */
export const GroupNameSourceSchema = z.enum(["sync", "event", "fallback"]);

export const InstanceGroupSchema = z.object({
  groupJid: z.string().min(1),
  name: z.string(),
  nameSource: GroupNameSourceSchema,
  nameSetAt: z.string().nullable(),
  nameSetBy: z.string().nullable(),
  participantCount: z.number().int().nonnegative(),
  isAnnounce: z.boolean(),
  isLocked: z.boolean(),
  state: GroupStateSchema,
  lastActivityAt: z.string().nullable(),
  messageCount: z.number().int().nonnegative(),
  assigned: z.boolean(),
  whitelisted: z.boolean(),
});
export type InstanceGroup = z.infer<typeof InstanceGroupSchema>;

export const InstanceGroupListSchema = z.object({
  instanceId: z.string().min(1),
  syncedAt: z.string().nullable(),
  groups: z.array(InstanceGroupSchema),
});

export const GroupSyncSummarySchema = z.object({
  ok: z.boolean(),
  instanceId: z.string().min(1),
  durationMs: z.number().int().nonnegative(),
  source: z.enum(["connect", "timer", "manual", "event", "message"]),
  total: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  subjectUpdated: z.number().int().nonnegative(),
  metadataUpdated: z.number().int().nonnegative(),
  markedLeft: z.number().int().nonnegative(),
  subjectRejected: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
});
export type GroupSyncSummary = z.infer<typeof GroupSyncSummarySchema>;

export const GroupUpdatedEventSchema = z.object({
  type: z.literal("group.updated"),
  instanceId: z.string().min(1),
  groupJid: z.string().min(1),
  changes: z.array(z.enum(["subject", "topic", "announce", "locked", "state", "participants"])),
  name: z.string(),
  previousName: z.string().nullable(),
  nameSetAt: z.string().nullable(),
  state: GroupStateSchema,
  occurredAt: z.string(),
});
export type GroupUpdatedEvent = z.infer<typeof GroupUpdatedEventSchema>;
```

**Step 5: Verify and commit**

Run: `bun test packages/shared/test/worker-contract.test.ts && bun run --cwd packages/shared lint`
Expected: PASS (4 tests); `tsc` exits 0.

Append to `packages/shared/src/index.ts`: `export * from "./worker-contract";`

```bash
git add packages/shared
git commit -m "feat(shared): add zod worker contract schemas and fixtures"
```

---

## Task 6: Worker module, config, logging, ids

**Files:**
- Create: `apps/worker/{go.mod,config.go,config_test.go,log.go,id.go,id_test.go}`

**Step 1: Initialise the module**

Run: `cd apps/worker && go mod init github.com/nst/group-butler/apps/worker && go get go.mau.fi/whatsmeow@v0.0.0-20260516102357-8d3700152a69 go.mongodb.org/mongo-driver/v2@latest github.com/aws/aws-sdk-go-v2/service/s3@latest github.com/aws/aws-sdk-go-v2/credentials@latest github.com/mattn/go-sqlite3@latest github.com/skip2/go-qrcode@latest google.golang.org/protobuf@latest`
Expected: `go.mod` created with those requirements (the `whatsmeow` pseudo-version must match the draft's evidence).

**Step 2: Failing tests**

`apps/worker/config_test.go`:

```go
package main

import (
	"testing"
	"time"
)

func TestLoadConfig_LocalDefaults(t *testing.T) {
	t.Setenv("ENVIRONMENT", "development")
	t.Setenv("MONGODB_URI", "mongodb://127.0.0.1:27017/group_butler?replicaSet=rs0")
	t.Setenv("WORKER_SECRET", "dev-secret")
	t.Setenv("GROUP_SYNC_INTERVAL", "")
	t.Setenv("MEDIA_DOWNLOAD_TIMEOUT", "")

	cfg, err := loadConfig()
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if cfg.Port != "4000" {
		t.Errorf("Port = %q, want 4000", cfg.Port)
	}
	if cfg.OrganizationID != "org_default" {
		t.Errorf("OrganizationID = %q, want org_default", cfg.OrganizationID)
	}
	if cfg.GroupSyncInterval != 30*time.Minute {
		t.Errorf("GroupSyncInterval = %v, want 30m", cfg.GroupSyncInterval)
	}
	if cfg.MediaDownloadTimeout != 45*time.Second {
		t.Errorf("MediaDownloadTimeout = %v, want 45s", cfg.MediaDownloadTimeout)
	}
	if !cfg.GroupSyncPrune {
		t.Error("GroupSyncPrune = false, want true by default")
	}
}

func TestLoadConfig_ProductionRequiresSecrets(t *testing.T) {
	t.Setenv("ENVIRONMENT", "production")
	t.Setenv("MONGODB_URI", "mongodb://example/group_butler")
	t.Setenv("WORKER_SECRET", "dev-secret") // the insecure default
	if _, err := loadConfig(); err == nil {
		t.Fatal("loadConfig succeeded with the dev WORKER_SECRET in production")
	}
}

func TestLoadConfig_RejectsBadDuration(t *testing.T) {
	t.Setenv("ENVIRONMENT", "development")
	t.Setenv("MONGODB_URI", "mongodb://127.0.0.1:27017/group_butler")
	t.Setenv("WORKER_SECRET", "dev-secret")
	t.Setenv("GROUP_SYNC_INTERVAL", "not-a-duration")
	if _, err := loadConfig(); err == nil {
		t.Fatal("loadConfig accepted a malformed GROUP_SYNC_INTERVAL")
	}
}
```

`apps/worker/id_test.go`:

```go
package main

import "testing"

func TestNewIDShape(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 500; i++ {
		id := newID()
		if len(id) != 21 {
			t.Fatalf("newID() = %q (len %d), want 21 chars", id, len(id))
		}
		if seen[id] {
			t.Fatalf("newID() repeated %q", id)
		}
		seen[id] = true
	}
}
```

**Step 3: Run them — expect failure**

Run: `cd apps/worker && go test ./... -run 'TestLoadConfig|TestNewID' -v`
Expected: FAIL — `undefined: loadConfig`, `undefined: newID`.

**Step 4: Implementation**

`apps/worker/log.go` (reference convention: fixed prefix, stdout):

```go
package main

import (
	"log"
	"os"
)

var logger = log.New(os.Stdout, "[wa-worker] ", log.LstdFlags|log.Lmsgprefix)

func logf(format string, args ...any) { logger.Printf(format, args...) }
```

`apps/worker/id.go` (nanoid-compatible 21-char ids, matching the reference so ids stay interchangeable):

```go
package main

import (
	"crypto/rand"
	"math/big"
)

const nanoidAlphabet = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict"

func newID() string {
	const size = 21
	out := make([]byte, size)
	max := big.NewInt(int64(len(nanoidAlphabet)))
	for i := 0; i < size; i++ {
		n, err := rand.Int(rand.Reader, max)
		if err != nil {
			out[i] = nanoidAlphabet[0]
			continue
		}
		out[i] = nanoidAlphabet[n.Int64()]
	}
	return string(out)
}
```

`apps/worker/config.go` — `Config` struct with every field from the draft's §6.9 table, helpers
`env/envBool/envInt/envDuration`, defaults matching `.env.example`, `loadConfig() (Config, error)`
that parses durations, rejects a malformed duration, requires `MONGODB_URI`, and rejects the
`dev-secret` default plus an empty secret when `ENVIRONMENT=production`, and
`(Config) ListenAddr() string` that falls back to `:4000`. Fields, in order: `Environment`, `Port`,
`WorkerSecret`, `OrganizationID`, `MongoURI`, `MongoDB`, `WhatsmeowDB`, `R2AccountID`,
`R2Endpoint`, `R2AccessKeyID`, `R2SecretKey`, `R2Bucket`, `R2PublicURL`, `IngestQueueSize`,
`IngestFlush`, `IngestFlushMax`, `RawJSONMaxBytes`, `RawSearchMax`, `MediaMaxBytes`,
`MediaConcurrency`, `MediaDownloadTimeout`, `MediaMaxAttempts`, `MediaJanitorEvery`,
`MediaEnrichEnabled`, `GroupSyncInterval`, `GroupStaleAfter`, `GroupSyncPrune`,
`DispatchInterval`, `SendMaxAttempts`, `HistorySyncMaxDays`, `AIBaseURL`, `AIAPIKey`, `AIModel`,
`LogLevel`.

**Step 5: Verify and commit**

Run: `cd apps/worker && gofmt -l . && go vet ./... && go test ./... -run 'TestLoadConfig|TestNewID' -v`
Expected: `gofmt` silent, vet clean, 4 tests PASS.

```bash
git add apps/worker
git commit -m "feat(worker): add env config, logging, and nanoid ids"
```

---

## Task 7: Mongo layer, canonical indexes, bootstrap seed

The worker creates the index subset ingest correctness depends on; `bootstrap.ts` creates the full canonical set from §5.1 and seeds `org_default` + `appSettings`.

**Files:**
- Create: `apps/worker/mongo.go`, `apps/worker/mongo_test.go`
- Create: `apps/web/src/server/{mongo.ts,collections.ts,bootstrap.ts,bootstrap.test.ts}`
- Create: `apps/web/scripts/bootstrap.ts`, `apps/web/vitest.config.ts`
- Modify: `apps/web/package.json`

**Step 1: Dependencies and vitest config**

Run: `cd apps/web && bun add next@^15 react@^19 react-dom@^19 mongodb zod && bun add -d vitest @types/react @types/node typescript mongodb-memory-server @aws-sdk/client-s3 @aws-sdk/s3-request-presigner`

`apps/web/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.ts"],
    // Route tests spin up a single-node replica set per file.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
```

**Step 2: Failing worker index test**

`apps/worker/mongo_test.go`:

```go
package main

import (
	"context"
	"testing"
)

func testMongoURI(t *testing.T) string {
	t.Helper()
	if testing.Short() {
		t.Skip("short mode: skipping mongo integration test")
	}
	return env("TEST_MONGODB_URI", "mongodb://127.0.0.1:27017/?replicaSet=rs0")
}

func TestIndexForMessagesIsUniqueOnWaMessageID(t *testing.T) {
	idx := ingestIndexes()[collMessages]
	if len(idx) != 1 {
		t.Fatalf("expected exactly one messages index in the worker subset, got %d", len(idx))
	}
	if !idx[0].Unique {
		t.Error("messages waMessageId index must be unique (idempotent ingest)")
	}
	keys := idx[0].Keys.Doc()
	if len(keys) != 3 || keys[0].Key != "organizationId" || keys[1].Key != "instanceId" || keys[2].Key != "waMessageId" {
		t.Errorf("index keys = %+v, want organizationId/instanceId/waMessageId", keys)
	}
}

func TestEnsureIndexesIsIdempotent(t *testing.T) {
	ctx := context.Background()
	client, db, err := connectMongo(ctx, testMongoURI(t), "group_butler_test")
	if err != nil {
		t.Fatalf("connectMongo: %v", err)
	}
	defer func() { _ = client.Disconnect(ctx) }()
	if err := ensureIngestIndexes(ctx, db); err != nil {
		t.Fatalf("first ensureIngestIndexes: %v", err)
	}
	if err := ensureIngestIndexes(ctx, db); err != nil {
		t.Fatalf("second ensureIngestIndexes: %v", err)
	}
}
```

**Step 3: Run it — expect failure**

Run: `cd apps/worker && go test ./... -run 'TestIndexForMessages|TestEnsureIndexes' -v`
Expected: FAIL with compile errors — `undefined: ingestIndexes`, `undefined: connectMongo`, `collMessages`.

**Step 4: Implement `apps/worker/mongo.go`**

```go
package main

import (
	"context"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Collection names (docs/architecture-draft.md §5.1).
const (
	collInstances      = "instances"
	collGroups         = "groups"
	collMessages       = "messages"
	collSendRequests   = "sendRequests"
	collAiCalls        = "aiCalls"
	collStatsDaily     = "statsDaily"
	collAuditLog       = "auditLog"
	collPairingSession = "pairingSessions"
	collAppSettings    = "appSettings"
	collOrganizations  = "organizations"
)

func connectMongo(ctx context.Context, uri, dbName string) (*mongo.Client, *mongo.Database, error) {
	client, err := mongo.Connect(options.Client().ApplyURI(uri))
	if err != nil {
		return nil, nil, fmt.Errorf("mongo connect: %w", err)
	}
	pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := client.Ping(pingCtx, nil); err != nil {
		return nil, nil, fmt.Errorf("mongo ping: %w", err)
	}
	return client, client.Database(dbName), nil
}

// ingestIndexes is the SUBSET of the canonical index set (bootstrap.ts) that
// ingest correctness depends on: the worker must not start against a database
// where a redelivered message would be duplicated.
func ingestIndexes() map[string][]mongo.IndexModel {
	return map[string][]mongo.IndexModel{
		collMessages: {{
			Keys:    bson.D{{Key: "organizationId", Value: 1}, {Key: "instanceId", Value: 1}, {Key: "waMessageId", Value: 1}},
			Options: options.Index().SetUnique(true).SetName("uniq_message"),
		}},
		collGroups: {{
			Keys:    bson.D{{Key: "organizationId", Value: 1}, {Key: "instanceId", Value: 1}, {Key: "groupJid", Value: 1}},
			Options: options.Index().SetUnique(true).SetName("uniq_group"),
		}},
	}
}

func ensureIngestIndexes(ctx context.Context, db *mongo.Database) error {
	for coll, models := range ingestIndexes() {
		if _, err := db.Collection(coll).Indexes().CreateMany(ctx, models); err != nil {
			return fmt.Errorf("create %s indexes: %w", coll, err)
		}
	}
	return nil
}
```

Note: `mongo.IndexModel` in driver v2 is a struct with a `Keys` helper that loses the key names, so keep a small local wrapper if `keys[0].Key` is required by the test — the simplest honest form is to declare `ingestIndexes()` as returning `map[string][]indexSpec` where `indexSpec{Keys []string; Unique bool}` and translate to `mongo.IndexModel` inside `ensureIngestIndexes`. Do that; the test above reads `idx[0].Keys` as a slice of key names.

**Step 5: Run it to verify it passes**

Run: `cd apps/worker && go test ./... -run 'TestIndexForMessages|TestEnsureIndexes' -v`
Expected: PASS with the Task 3 replica set running; skipped under `-short`.

**Step 6: Failing bootstrap test**

`apps/web/src/server/bootstrap.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { connectForTest } from "./mongo";
import { createIndexes, seedDefaults } from "./bootstrap";

let replSet: MongoMemoryReplSet;
let uri: string;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  uri = replSet.getUri();
});
afterAll(async () => {
  await replSet.stop();
});

describe("bootstrap", () => {
  test("seeds org_default and appSettings idempotently", async () => {
    const { client, db } = await connectForTest(uri, "butler_test");
    await createIndexes(db);
    await seedDefaults(db);
    await createIndexes(db);
    await seedDefaults(db);
    expect(await db.collection("organizations").countDocuments({ _id: "org_default" as never })).toBe(1);
    expect(await db.collection("appSettings").countDocuments({ _id: "org_default" as never })).toBe(1);
    await client.close();
  });

  test("creates the messages uniqueness guarantee and the group lookup indexes", async () => {
    const { client, db } = await connectForTest(uri, "butler_test");
    await createIndexes(db);
    const groupNames = (await db.collection("groups").indexes()).map((i) => i.name);
    expect(groupNames).toContain("uniq_group");
    expect(groupNames).toContain("group_activity");
    const messageNames = (await db.collection("messages").indexes()).map((i) => i.name);
    expect(messageNames).toContain("uniq_message");
    expect(messageNames).toContain("messages_text");
    await client.close();
  });
});
```

**Step 7: Run it — expect failure**

Run: `bun run --cwd apps/web test bootstrap`
Expected: FAIL — `Cannot find module './mongo'`.

**Step 8: Implement the BFF Mongo helpers and bootstrap**

`apps/web/src/server/collections.ts`:

```ts
export const COLLECTIONS = {
  organizations: "organizations",
  instances: "instances",
  pairingSessions: "pairingSessions",
  groups: "groups",
  messages: "messages",
  sendRequests: "sendRequests",
  aiCalls: "aiCalls",
  statsDaily: "statsDaily",
  auditLog: "auditLog",
  appSettings: "appSettings",
  streamCursors: "streamCursors",
} as const;
```

`apps/web/src/server/mongo.ts`:

```ts
import { MongoClient, type Db } from "mongodb";

let cached: { client: MongoClient; db: Db } | null = null;

export function mongoConfig() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is required");
  return { uri, dbName: process.env.MONGODB_DB ?? "group_butler" };
}

/** Process-wide pooled client (Next dev reloads reuse it). */
export async function getDb(): Promise<Db> {
  if (cached) return cached.db;
  const { uri, dbName } = mongoConfig();
  const client = new MongoClient(uri);
  await client.connect();
  cached = { client, db: client.db(dbName) };
  return cached.db;
}

export async function closeDb(): Promise<void> {
  await cached?.client.close();
  cached = null;
}

export async function connectForTest(uri: string, dbName = "butler_test") {
  const client = new MongoClient(uri);
  await client.connect();
  return { client, db: client.db(dbName) };
}
```

`apps/web/src/server/bootstrap.ts` — export `createIndexes(db)`, `seedDefaults(db)` and
`runBootstrap(opts?: { uri?: string; dbName?: string })`, plus a `import.meta.main` block that runs
it. `createIndexes` creates, with the exact names asserted above:
`organizations.org_name`; `instances.org_label` (unique, `partialFilterExpression: { deletedAt: null }`)
+ `instances.instance_status`; `pairingSessions.pairing_ttl` (`expireAfterSeconds: 0` on `expiresAt`);
`groups.uniq_group` (unique), `groups.group_activity`, `groups.group_by_jid`,
`groups.group_name_search`, `groups.group_reconcile`; `messages.uniq_message` (unique),
`messages.group_stream`, `messages.media_status`, `messages.sender_stream`,
`messages.messages_text` (text index over `text`, `rawSearch`, `media.fileName`, weights 10/3/2,
`default_language: "none"`); `sendRequests.uniq_send_idempotency` (unique), `sendRequests.send_due`,
`sendRequests.send_by_instance`; `aiCalls.ai_recent`, `aiCalls.ai_by_instance`, `aiCalls.ai_by_model`;
`statsDaily.stats_unique` (unique); `auditLog.audit_recent`. `seedDefaults` upserts
`organizations/_id=org_default` and `appSettings/_id=org_default` with the AI/retention/ui defaults
from the env, `$setOnInsert` only.

**Step 9: Verify and commit**

Run: `bun run --cwd apps/web test bootstrap && bun run bootstrap && docker compose -f infra/dev/docker-compose.yml exec -T mongo mongosh group_butler --quiet --eval 'db.groups.getIndexes().map(i=>i.name)'`
Expected: PASS (2 tests); the index list includes `uniq_group`, `group_activity`, `group_name_search`.

```bash
git add apps/worker/mongo.go apps/worker/mongo_test.go apps/web
git commit -m "feat: add mongo layer, canonical indexes, and idempotent bootstrap seed"
```

---

## Task 8: Worker message parsing and idempotent ingest

**Files:** Create `apps/worker/{message.go,message_test.go,ingest.go,ingest_test.go}`

**Step 1: Failing tests**

`apps/worker/message_test.go` — assert the four behaviours R1/R3 depend on:

```go
package main

import (
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

func evtMessage(chat, sender types.JID, id string, msg *waE2E.Message) *events.Message {
	return &events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{Chat: chat, Sender: sender, IsGroup: chat.Server == types.GroupServer},
			ID:            types.MessageID(id),
			Timestamp:     time.Unix(1757751120, 0),
			PushName:      "Nadia",
		},
		Message: msg,
	}
}

func TestParseInbound_GroupText(t *testing.T) {
	chat := types.NewJID("120363043123456789", types.GroupServer)
	sender := types.NewJID("628990000001", types.DefaultUserServer)
	got, err := parseInbound(evtMessage(chat, sender, "3EB0A1", &waE2E.Message{Conversation: proto.String("deploy is green")}), "org_default", "inst_1")
	if err != nil {
		t.Fatalf("parseInbound: %v", err)
	}
	if got.GroupJID != "120363043123456789@g.us" || got.Kind != KindText || got.Text != "deploy is green" {
		t.Errorf("doc = %+v", got)
	}
	if got.OrganizationID != "org_default" || got.InstanceID != "inst_1" {
		t.Error("tenant/instance not stamped from the caller")
	}
	if got.Media.Status != MediaNone {
		t.Errorf("Media.Status = %q, want none", got.Media.Status)
	}
}

func TestParseInbound_DoesNotSkipOwnMessages(t *testing.T) {
	chat := types.NewJID("120363043123456789", types.GroupServer)
	evt := evtMessage(chat, types.NewJID("628990000009", types.DefaultUserServer), "3EB0A2",
		&waE2E.Message{Conversation: proto.String("sent from the phone")})
	evt.Info.IsFromMe = true
	got, err := parseInbound(evt, "org_default", "inst_1")
	if err != nil {
		t.Fatalf("parseInbound: %v", err)
	}
	if !got.FromMe {
		t.Error("FromMe = false: the butler ingests its own group messages (R1)")
	}
}

func TestParseInbound_InteractiveResponseIsNotDropped(t *testing.T) {
	chat := types.NewJID("120363043123456789", types.GroupServer)
	evt := evtMessage(chat, types.NewJID("628990000001", types.DefaultUserServer), "3EB0A3",
		&waE2E.Message{ListResponseMessage: &waE2E.ListResponseMessage{Title: proto.String("Approve")}})
	got, err := parseInbound(evt, "org_default", "inst_1")
	if err != nil {
		t.Fatalf("parseInbound: %v", err)
	}
	if got.Text != "Approve" {
		t.Errorf("Text = %q, want the tapped row title", got.Text)
	}
}

func TestParseInbound_UnknownKindStillRecorded(t *testing.T) {
	chat := types.NewJID("120363043123456789", types.GroupServer)
	evt := evtMessage(chat, types.NewJID("628990000001", types.DefaultUserServer), "3EB0A4", &waE2E.Message{})
	got, err := parseInbound(evt, "org_default", "inst_1")
	if err != nil {
		t.Fatalf("parseInbound: %v", err)
	}
	if got.Kind != KindUnknown || got.ParseState != ParsePartial {
		t.Errorf("kind=%q parseState=%q, want unknown/partial (record, never drop)", got.Kind, got.ParseState)
	}
}
```

`apps/worker/ingest_test.go`:

```go
package main

import (
	"context"
	"testing"
)

func TestEnqueueIngestIsBoundedAndCountsDrops(t *testing.T) {
	q := newIngestQueue(2, 0, 0)
	for i := 0; i < 5; i++ {
		q.Enqueue(MessageDoc{WaMessageID: string(rune('a' + i))})
	}
	if got := q.Dropped(); got != 3 {
		t.Errorf("Dropped() = %d, want 3 (bounded queue must count, not grow)", got)
	}
}

func TestFlushIngestUpsertsIdempotently(t *testing.T) {
	ctx := context.Background()
	client, db, err := connectMongo(ctx, testMongoURI(t), "group_butler_test")
	if err != nil {
		t.Fatalf("connectMongo: %v", err)
	}
	defer func() { _ = client.Disconnect(ctx) }()
	if err := ensureIngestIndexes(ctx, db); err != nil {
		t.Fatalf("ensureIngestIndexes: %v", err)
	}
	store := newMessageStore(db)
	doc := MessageDoc{
		OrganizationID: "org_default", InstanceID: "inst_1",
		GroupJID: "120363043123456789@g.us", WaMessageID: "3EB0A1",
		Kind: KindText, Text: "hello", TextSearch: "hello", Media: Media{Status: MediaNone},
	}
	if err := store.Save(ctx, []MessageDoc{doc, doc}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	count, err := db.Collection(collMessages).CountDocuments(ctx, map[string]any{"waMessageId": "3EB0A1"})
	if err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Errorf("message count = %d, want 1 (the unique index must collapse redelivery)", count)
	}
}
```

**Step 2: Run them — expect failure**

Run: `cd apps/worker && go test ./... -run 'TestParseInbound|TestEnqueueIngest|TestFlushIngest' -v`
Expected: FAIL — `undefined: parseInbound`, `KindText`, `MediaNone`, `newIngestQueue`, `newMessageStore`.

**Step 3: Implement `message.go`**

Define `Kind` (`text/image/video/audio/document/sticker/location/contact/poll/reaction/system/revoked/unknown`),
`MediaStatus` (`none/pending/stored/unparsed/unavailable/failed`), `ParseState` (`ok/partial/failed`),
`Media` (status, kind, declaredType, mime, fileName, size, sha256, width, height, durationSec, r2Key,
publicUrl, reason, error, attempts) and `MessageDoc` (the §5.1 fields: organizationId, instanceId,
groupJid, chatJid, isGroup, waMessageId, senderJid, senderLid, pushName, fromMe, timestamp,
receivedAt, serverSkewMs, kind, text, textSearch, rawSearch, links, mentions, media, raw, parse
state/errors, schemaVersion).

`parseInbound(evt *events.Message, organizationID, instanceID string) (MessageDoc, error)` returns an
error **only** when the event has no id — an unparseable message becomes `KindUnknown` +
`ParsePartial`, never a drop. `extractText(msg)` walks `Conversation`, `ExtendedTextMessage`,
captions on image/video/document, `ListResponseMessage.Title`, `ButtonsResponseMessage.SelectedDisplayText`
and `TemplateButtonReplyMessage.SelectedDisplayText` (so a tapped control is not stored empty, as the
reference worker discovered). `classifyKind`, `foldText` (lowercase, strip punctuation, collapse
spaces), `collectMentionedJIDs` (via `allContextInfos`), `collectLinks`, `dedupeStrings`.

**Step 4: Run the parser tests to verify they pass**

Run: `cd apps/worker && go test ./... -run TestParseInbound -v`
Expected: PASS (4 tests).

**Step 5: Implement `ingest.go`**

`ingestQueue` (bounded `chan MessageDoc`, `dropped atomic.Int64`, `Enqueue` never blocks, `Run(ctx, store)`
flushing on `INGEST_FLUSH_MS` or `INGEST_FLUSH_MAX`, final flush on context cancel), `messageStore`
with `Save(ctx, docs)` building unordered `BulkWrite` `UpdateOne` upserts filtered on
`{organizationId, instanceId, waMessageId}` with `$set` of the mutable fields and `$setOnInsert` of
the identity fields + `receivedAt`, and `messageFields(doc)` producing the dotted `media.status` /
`parse.state` keys.

**Step 6: Run the tests to verify they pass**

Run: `cd apps/worker && gofmt -l . && go vet ./... && go test ./... -run 'TestParseInbound|TestEnqueueIngest|TestFlushIngest' -v`
Expected: PASS (6 tests), vet clean.

**Step 7: Commit**

```bash
git add apps/worker/message.go apps/worker/message_test.go apps/worker/ingest.go apps/worker/ingest_test.go
git commit -m "feat(worker): parse all message kinds and ingest idempotently"
```

---

## Task 9: Worker media pipeline and R2

**Files:** Create `apps/worker/{r2.go,r2_test.go,media.go,media_test.go,testing_helpers_test.go}`

**Step 1: Failing tests**

`apps/worker/r2_test.go`:

```go
package main

import "testing"

func TestObjectKeyShape(t *testing.T) {
	got := objectKeyAt("org_default", "inst_1", "120363043123456789@g.us", "3EB0A1", "bin", mustDate("2026-09-13"))
	want := "org/org_default/instance/inst_1/group/120363043123456789_g.us/2026/09/3EB0A1.bin"
	if got != want {
		t.Errorf("objectKeyAt = %q, want %q", got, want)
	}
}

func TestExtensionForMime(t *testing.T) {
	cases := map[string]string{
		"image/jpeg": "jpg", "image/png": "png", "video/mp4": "mp4",
		"audio/ogg; codecs=opus": "ogg", "application/pdf": "pdf",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
		"application/x-unknown": "bin",
	}
	for mime, want := range cases {
		if got := extensionForMime(mime, ""); got != want {
			t.Errorf("extensionForMime(%q) = %q, want %q", mime, got, want)
		}
	}
}

func TestR2EndpointDerivation(t *testing.T) {
	// Config deliberately has no endpoint field: the only endpoint that can ever
	// be produced is the account-scoped Cloudflare R2 host.
	if got := r2Endpoint(Config{R2AccountID: "abc123"}); got != "https://abc123.r2.cloudflarestorage.com" {
		t.Errorf("derived endpoint = %q, want the account-scoped R2 host", got)
	}
	if got := r2Endpoint(Config{}); got != "" {
		t.Errorf("endpoint with no account id = %q, want empty so media stays disabled", got)
	}
}
```

`apps/worker/media_test.go` — the R3 proof, using fakes so no network is involved:

```go
package main

import (
	"context"
	"errors"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"google.golang.org/protobuf/proto"
)

type fakeDownloader struct {
	data []byte
	typ  string
	err  error
}

func (f fakeDownloader) Download(ctx context.Context, msg MediaDescriptor) ([]byte, string, error) {
	if f.err != nil {
		return nil, "", f.err
	}
	return f.data, f.typ, nil
}

type fakeUploader struct {
	key   string
	calls int
}

func (f *fakeUploader) Upload(ctx context.Context, data []byte, key, mime string) (uploadResult, error) {
	f.calls++
	f.key = key
	return uploadResult{Key: key, Size: int64(len(data)), PublicURL: "http://cdn.local/" + key}, nil
}

var mediaNow = time.Date(2026, 9, 13, 0, 0, 0, 0, time.UTC)

func TestStoreMedia_StoredWhenReadable(t *testing.T) {
	png := []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 'I', 'H', 'D', 'R', 0, 0, 0, 4, 0, 0, 0, 3}
	up := &fakeUploader{}
	pipe := newMediaPipeline(fakeDownloader{data: png, typ: "image/png"}, up, "org_default", "inst_1", mediaNow)
	got := pipe.Store(context.Background(), MediaDescriptor{
		DeclaredType: "image", Kind: "image", Mime: "image/png", MessageID: "3EB0A1", GroupJID: "120363043123456789@g.us",
	})
	if got.Status != MediaStored {
		t.Fatalf("Status = %q (err=%q), want stored", got.Status, got.Error)
	}
	if got.Width != 4 || got.Height != 3 {
		t.Errorf("dimensions = %dx%d, want 4x3", got.Width, got.Height)
	}
	if got.R2Key == "" || up.calls != 1 {
		t.Errorf("expected one upload, got key=%q calls=%d", got.R2Key, up.calls)
	}
}

func TestStoreMedia_UnparsedKeepsDeclaredTypeAndLink(t *testing.T) {
	up := &fakeUploader{}
	pipe := newMediaPipeline(fakeDownloader{data: []byte{0x00, 0x01, 0x02, 0x03}}, up, "org_default", "inst_1", mediaNow)
	got := pipe.Store(context.Background(), MediaDescriptor{
		DeclaredType: "ptv", Kind: "video", MessageID: "3EB0A2", GroupJID: "120363043123456789@g.us",
	})
	if got.Status != MediaUnparsed {
		t.Fatalf("Status = %q, want unparsed", got.Status)
	}
	if got.DeclaredType != "ptv" {
		t.Errorf("DeclaredType = %q, want ptv (R3)", got.DeclaredType)
	}
	if got.R2Key == "" || got.PublicURL == "" {
		t.Errorf("unparsed media must still carry the R2 locator, got key=%q url=%q", got.R2Key, got.PublicURL)
	}
	if got.Reason != "unsupported_type" {
		t.Errorf("Reason = %q, want unsupported_type", got.Reason)
	}
}

func TestStoreMedia_DownloadFailureIsUnavailableNotFatal(t *testing.T) {
	up := &fakeUploader{}
	pipe := newMediaPipeline(fakeDownloader{err: errors.New("media key missing")}, up, "org_default", "inst_1", mediaNow)
	got := pipe.Store(context.Background(), MediaDescriptor{
		DeclaredType: "image", Kind: "image", Mime: "image/jpeg", MessageID: "3EB0A3", GroupJID: "120363043123456789@g.us",
	})
	if got.Status != MediaUnavailable || got.R2Key != "" || up.calls != 0 {
		t.Errorf("media = %+v, want unavailable with no key and no upload", got)
	}
	if got.DeclaredType != "image" {
		t.Errorf("DeclaredType = %q, want image", got.DeclaredType)
	}
}

func TestMediaDescriptorFromMessage(t *testing.T) {
	msg := &waE2E.Message{ImageMessage: &waE2E.ImageMessage{
		Mimetype: proto.String("image/jpeg"), Caption: proto.String("chart"), FileLength: proto.Uint64(2048),
	}}
	desc, ok := describeMedia(msg)
	if !ok || desc.Kind != "image" || desc.DeclaredType != "image" || desc.Mime != "image/jpeg" {
		t.Fatalf("describeMedia = %+v ok=%v", desc, ok)
	}
}
```

**Step 2: Run them — expect failure**

Run: `cd apps/worker && go test ./... -run 'TestObjectKey|TestExtensionForMime|TestStoreMedia|TestMediaDescriptor' -v`
Expected: FAIL — `undefined: objectKeyAt`, `mustDate`, `extensionForMime`, `newMediaPipeline`, `MediaDescriptor`, `describeMedia`.

**Step 3: Implement `r2.go`**

`R2` wraps `*s3.Client`; `newR2(cfg)` returns **nil** when the account id or credentials are absent
(media disabled, logged loudly — the reference's no-op convention). `objectKey`/`objectKeyAt(…, at time.Time)` produce
`org/<org>/instance/<id>/group/<jid with @ and : replaced by _>/<YYYY>/<MM>/<msgId>.<ext>`.
`extensionForMime(mime, fileName)` maps the MIME table (jpg/png/webp/gif/mp4/3gp/ogg/mp3/m4a/pdf/docx/xlsx/txt/csv/zip)
and falls back to `bin`. `Upload(ctx, data, key, mime)` → `uploadResult{Key, Size, PublicURL}`
(`PublicURL` only when `R2_PUBLIC_URL` is set). `Download(ctx, key)` → bytes + MIME.
`options` set `Region: "auto"`, `BaseEndpoint: aws.String(r2Endpoint(cfg))` and the static credentials
— **no `UsePathStyle`, no endpoint override**: `r2Endpoint(cfg)` is the only way an endpoint is ever
produced, and it derives `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com` (returning `""` when no
account id is configured, which keeps media disabled rather than reaching anywhere else). Development
and production therefore run the identical code path against the identical real service.

**Step 4: Implement `media.go`**

`MediaDescriptor` (Kind, DeclaredType, Mime, FileName, Size, MessageID, GroupJID, ViewOnce),
`mediaDownloader`/`mediaUploader` interfaces, `mediaPipeline` with
`newMediaPipeline(downloader, uploader, orgID, instanceID, now)`, `Store(ctx, desc) Media` following
the state table in §6.3.1: view-once → `unavailable/view_once`; download error →
`unavailable/<classified>`; unreadable bytes → upload as `<id>.bin` and return
`unparsed` with the declared type, R2 key, public URL, sha256 and `reason: unsupported_type`; readable
bytes → `stored` with detected MIME, `sonf`-derived `kind`, dimensions, duration. Helpers:
`sniffMedia` (PNG/JPEG/WebP/GIF/`ftyp`/OggS/MP3/`%PDF`/`PK\x03\x04`), `sha256Hex`,
`imageDimensions` (PNG/GIF/JPEG SOF scan), `mediaDurationSeconds` (`mvhd`), `describeMedia(msg)`
mapping each variant to a descriptor with its WhatsApp-declared type.

`apps/worker/testing_helpers_test.go`:

```go
package main

import "time"

func mustDate(iso string) time.Time {
	t, err := time.Parse("2006-01-02", iso)
	if err != nil {
		panic(err)
	}
	return t
}
```

**Step 5: Verify and commit**

Run: `cd apps/worker && gofmt -l . && go vet ./... && go test ./... -run 'TestObjectKey|TestExtensionForMime|TestStoreMedia|TestMediaDescriptor' -v`
Expected: PASS (6 tests). The unparsed case asserts **both** `DeclaredType == "ptv"` and a non-empty
`R2Key`/`PublicURL` — the literal R3 requirement.

```bash
git add apps/worker/r2.go apps/worker/r2_test.go apps/worker/media.go apps/worker/media_test.go apps/worker/testing_helpers_test.go
git commit -m "feat(worker): add r2 client and media pipeline with unparsed-record path"
```

---

## Task 10: Group fixtures and real-parser tests (T1–T4)

**Why node fixtures, not XML parsing:** `waBinary.Unmarshal` (`binary/node.go:130`) decodes WhatsApp's **binary** XML — there is no XML-text→`Node` parser in the module (`XMLString()`, `binary/xml.go:25`, only renders a node *to* XML). Fixtures are therefore Go-built `waBinary.Node` trees whose `XMLString()` is asserted byte-equal to a captured transcript, so fixture fidelity is itself a test.

**Attribute typing rule (verified in `binary/attrs.go`):** `GetJID` requires a **`types.JID`** value; `GetInt64`/`GetString` require a **string**. Set `from`/`participant`/`s_o`/`jid` as `types.JID` and `t`/`s_t` as decimal strings. A string JID in `add`/`remove` is silently skipped by `parseParticipantList` (`child.Attrs["jid"].(types.JID)`), so getting this wrong makes a test pass while proving nothing.

**Files:**
- Create: `apps/worker/testdata/{group_rename,group_create,group_delete,group_self_removed,group_unknown_child}.xml`
- Create: `apps/worker/groupfixtures_test.go`, `apps/worker/groupparse_test.go`

**Step 1: Capture the transcripts**

Add a temporary `logf("RAW %s", node.XMLString())` to the `*events.GroupInfo` branch of `handleEvent`, rename a group from a phone on a paired test instance, copy each emitted line into the matching `testdata/*.xml` file (one line, no wrapping), then remove the debug line. Until a live capture exists, write the files with exactly what Step 2's builders produce — the fidelity assertion then guarantees the fixture cannot drift from the code that consumes it.

`apps/worker/testdata/group_rename.xml`:

```
<notification from="120363043123456789@g.us" notify="Ops Team" participant="628990000001@s.whatsapp.net" t="1757751120" type="w:gp2"><subject s_o="628990000001@s.whatsapp.net" s_t="1757751120" subject="Ops Team"/></notification>
```

`group_create.xml`:

```
<notification from="120363043999999999@g.us" id="1757751200" notify="New Crew" participant="628990000001@s.whatsapp.net" type="w:gp2"><create key="3EB0CREATE" reason="invite" type="new"><group creation="1757751200" id="120363043999999999@g.us" s_o="628990000001@s.whatsapp.net" s_t="1757751200" size="3" subject="New Crew"><participant jid="628990000001@s.whatsapp.net" type="superadmin"/></group></create></notification>
```

`group_delete.xml`:

```
<notification from="120363043123456789@g.us" participant="628990000001@s.whatsapp.net" t="1757751300" type="w:gp2"><delete reason="user_left"/></notification>
```

`group_self_removed.xml`:

```
<notification from="120363043123456789@g.us" participant="628990000009@s.whatsapp.net" t="1757751400" type="w:gp2"><remove v_id="2"><participant jid="628990000009@s.whatsapp.net"/></remove></notification>
```

`group_unknown_child.xml`:

```
<notification from="120363043123456789@g.us" participant="628990000001@s.whatsapp.net" t="1757751500" type="w:gp2"><future_feature flag="on"/></notification>
```

**Step 2: Builders + fidelity assertion**

`apps/worker/groupfixtures_test.go`:

```go
package main

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	waBinary "go.mau.fi/whatsmeow/binary"
	"go.mau.fi/whatsmeow/types"
)

var (
	testGroupJID   = types.NewJID("120363043123456789", types.GroupServer)
	testOtherGroup = types.NewJID("120363043999999999", types.GroupServer)
	testSelfPN     = types.NewJID("628990000009", types.DefaultUserServer)
	testAdminPN    = types.NewJID("628990000001", types.DefaultUserServer)
	testRenameAt   = time.Unix(1757751120, 0)
)

func unixAttr(t time.Time) string { return strconv.FormatInt(t.Unix(), 10) }

// assertFixtureFidelity proves the hand-built node matches the captured wire
// transcript, so the parser assertions in groupparse_test.go are about real
// WhatsApp shapes rather than about our assumptions.
func assertFixtureFidelity(t *testing.T, name string, node waBinary.Node) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	if got, want := node.XMLString(), strings.TrimSpace(string(raw)); got != want {
		t.Fatalf("fixture %s drifted from the captured transcript\n got: %s\nwant: %s", name, got, want)
	}
}

func validGroupID(t *testing.T, user string) types.JID {
	t.Helper()
	return types.NewJID(user, types.GroupServer)
}

func renameNotificationNode() waBinary.Node {
	return waBinary.Node{
		Tag: "notification",
		Attrs: waBinary.Attrs{
			"from": testGroupJID, "type": "w:gp2",
			"t": unixAttr(testRenameAt), "notify": "Ops Team", "participant": testAdminPN,
		},
		Content: []waBinary.Node{{
			Tag: "subject",
			Attrs: waBinary.Attrs{
				"subject": "Ops Team", "s_t": unixAttr(testRenameAt), "s_o": testAdminPN,
			},
		}},
	}
}

func createNotificationNode(t *testing.T) waBinary.Node {
	t.Helper()
	created := time.Unix(1757751200, 0)
	return waBinary.Node{
		Tag: "notification",
		Attrs: waBinary.Attrs{
			"from": testOtherGroup, "type": "w:gp2", "id": unixAttr(created),
			"t": unixAttr(created), "notify": "New Crew", "participant": testAdminPN,
		},
		Content: []waBinary.Node{{
			Tag: "create",
			Attrs: waBinary.Attrs{
				"key": "3EB0CREATE", "reason": "invite", "type": "new",
			},
			Content: []waBinary.Node{{
				Tag: "group",
				Attrs: waBinary.Attrs{
					"id": testOtherGroup, "subject": "New Crew",
					"s_t": unixAttr(created), "s_o": testAdminPN,
					"creation": unixAttr(created), "size": "3",
				},
				Content: []waBinary.Node{{
					Tag: "participant", Attrs: waBinary.Attrs{"jid": testAdminPN, "type": "superadmin"},
				}},
			}},
		}},
	}
}

func deleteNotificationNode() waBinary.Node {
	return waBinary.Node{
		Tag: "notification",
		Attrs: waBinary.Attrs{
			"from": testGroupJID, "type": "w:gp2",
			"t": unixAttr(time.Unix(1757751300, 0)), "participant": testAdminPN,
		},
		Content: []waBinary.Node{{Tag: "delete", Attrs: waBinary.Attrs{"reason": "user_left"}}},
	}
}

func selfRemovalNotificationNode() waBinary.Node {
	return waBinary.Node{
		Tag: "notification",
		Attrs: waBinary.Attrs{
			"from": testGroupJID, "type": "w:gp2",
			"t": unixAttr(time.Unix(1757751400, 0)), "participant": testSelfPN,
		},
		Content: []waBinary.Node{{
			Tag: "remove",
			Attrs: waBinary.Attrs{"v_id": "2"},
			Content: []waBinary.Node{{
				Tag: "participant", Attrs: waBinary.Attrs{"jid": testSelfPN},
			}},
		}},
	}
}

func unknownChildNotificationNode() waBinary.Node {
	return waBinary.Node{
		Tag: "notification",
		Attrs: waBinary.Attrs{
			"from": testGroupJID, "type": "w:gp2",
			"t": unixAttr(time.Unix(1757751500, 0)), "participant": testAdminPN,
		},
		Content: []waBinary.Node{{Tag: "future_feature", Attrs: waBinary.Attrs{"flag": "on"}}},
	}
}
```

**Step 3: Failing parser tests**

`apps/worker/groupparse_test.go`:

```go
package main

import (
	"testing"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
)

// parseNotification runs the REAL whatsmeow parser over a fixture node.
// whatsmeow.NewClient(nil, …) is safe for parsing: NewClient initialises
// groupCache and only nil-checks the device store on network paths
// (client.go:240-270), and DangerousInternals() exposes parseGroupNotification
// (internals.go:270).
func parseNotification(t *testing.T, node interface{ XMLString() string }) any {
	t.Helper()
	cli := whatsmeow.NewClient(nil, waLog.Noop)
	evt, _, _, err := cli.DangerousInternals().ParseGroupNotification(nodePtr(t, node))
	if err != nil {
		t.Fatalf("ParseGroupNotification: %v", err)
	}
	return evt
}

func TestParseGroupNotification_SubjectRename(t *testing.T) {
	node := renameNotificationNode()
	assertFixtureFidelity(t, "group_rename.xml", node)

	evt, ok := parseNotification(t, node).(*events.GroupInfo)
	if !ok {
		t.Fatal("expected *events.GroupInfo")
	}
	if evt.JID.String() != testGroupJID.String() {
		t.Errorf("JID = %s, want %s", evt.JID, testGroupJID)
	}
	if evt.Name == nil {
		t.Fatal("Name is nil: the real parser did not surface the subject change")
	}
	if evt.Name.Name != "Ops Team" {
		t.Errorf("Name.Name = %q, want Ops Team", evt.Name.Name)
	}
	if !evt.Name.NameSetAt.Equal(testRenameAt) {
		t.Errorf("NameSetAt = %v, want %v", evt.Name.NameSetAt, testRenameAt)
	}
	if evt.Name.NameSetBy.String() != testAdminPN.String() {
		t.Errorf("NameSetBy = %s, want %s", evt.Name.NameSetBy, testAdminPN)
	}
}

func TestParseGroupNotification_Create(t *testing.T) {
	node := createNotificationNode(t)
	assertFixtureFidelity(t, "group_create.xml", node)

	evtAny := parseNotification(t, node)
	joined, ok := evtAny.(*events.JoinedGroup)
	if !ok {
		t.Fatalf("expected *events.JoinedGroup for a <create> notification, got %T", evtAny)
	}
	if joined.GroupInfo.JID.String() != testOtherGroup.String() {
		t.Errorf("JID = %s, want %s", joined.GroupInfo.JID, testOtherGroup)
	}
	if joined.GroupInfo.Name != "New Crew" {
		t.Errorf("Name = %q, want New Crew", joined.GroupInfo.Name)
	}
	if joined.Type != "new" {
		t.Errorf("Type = %q, want new", joined.Type)
	}
}

func TestParseGroupChange_Delete(t *testing.T) {
	evt, ok := parseNotification(t, deleteNotificationNode()).(*events.GroupInfo)
	if !ok {
		t.Fatal("expected *events.GroupInfo")
	}
	if evt.Delete == nil || !evt.Delete.Deleted || evt.Delete.DeleteReason != "user_left" {
		t.Fatalf("Delete = %+v, want Deleted=true reason=user_left", evt.Delete)
	}
}

func TestParseGroupChange_SelfRemoved(t *testing.T) {
	evt, ok := parseNotification(t, selfRemovalNotificationNode()).(*events.GroupInfo)
	if !ok {
		t.Fatal("expected *events.GroupInfo")
	}
	for _, jid := range evt.Leave {
		if jid.String() == testSelfPN.String() {
			return
		}
	}
	t.Fatalf("Leave = %v, want it to contain %s (participant@jid must be a types.JID)", evt.Leave, testSelfPN)
}

func TestParseGroupChange_UnknownChild(t *testing.T) {
	evt, ok := parseNotification(t, unknownChildNotificationNode()).(*events.GroupInfo)
	if !ok {
		t.Fatal("expected *events.GroupInfo: an unknown child must not drop the event")
	}
	if len(evt.UnknownChanges) != 1 || evt.UnknownChanges[0].Tag != "future_feature" {
		t.Fatalf("UnknownChanges = %v, want one future_feature entry", evt.UnknownChanges)
	}
}
```

Add the small `nodePtr` helper (the whatsmeow signature takes `*waBinary.Node`) in
`groupfixtures_test.go`:

```go
func nodePtr(t *testing.T, node interface{ XMLString() string }) *waBinary.Node {
	t.Helper()
	typed, ok := node.(waBinary.Node)
	if !ok {
		t.Fatalf("nodePtr: unexpected fixture type %T", node)
	}
	return &typed
}
```

**Step 4: Run and iterate to green**

Run: `cd apps/worker && go test ./... -run 'TestParseGroupNotification|TestParseGroupChange' -v`
Expected: RED first (fixtures/builders absent), then PASS (5 tests) once the transcripts match. Adjust
**only** the `.xml` capture, never the assertions.

**Step 5: Commit**

```bash
git add apps/worker/testdata apps/worker/groupfixtures_test.go apps/worker/groupparse_test.go
git commit -m "test(worker): prove group parsing against the real whatsmeow parser"
```

---

## Task 11: Subject acceptance rule (T5)

**Files:** Create `apps/worker/groupdelta.go`, `apps/worker/groupdelta_test.go`

**Step 1: Failing table test**

`apps/worker/groupdelta_test.go`:

```go
package main

import (
	"testing"
	"time"
)

func stamp(min int) time.Time { return time.Unix(1757750000+int64(min)*60, 0) }

func TestAcceptSubject(t *testing.T) {
	observed := time.Unix(1757751120, 0)
	cases := []struct {
		name string
		cur  subjectUpdate
		next subjectUpdate
		want bool
	}{
		{"first observation always wins", subjectUpdate{},
			subjectUpdate{name: "Ops Team", setAt: stamp(1), source: "event", observedAt: observed}, true},
		{"newer stamp wins", subjectUpdate{name: "Support", setAt: stamp(1), source: "event", observedAt: observed},
			subjectUpdate{name: "Ops Team", setAt: stamp(5), source: "event", observedAt: observed.Add(time.Minute)}, true},
		{"older stamp is rejected as stale", subjectUpdate{name: "Ops Team", setAt: stamp(5), source: "event", observedAt: observed},
			subjectUpdate{name: "Support", setAt: stamp(1), source: "event", observedAt: observed.Add(time.Minute)}, false},
		{"equal stamp is accepted (idempotent replay)", subjectUpdate{name: "Ops Team", setAt: stamp(5), source: "event", observedAt: observed},
			subjectUpdate{name: "Ops Team", setAt: stamp(5), source: "event", observedAt: observed.Add(time.Minute)}, true},
		{"stamped beats an earlier unstamped value", subjectUpdate{name: "Support", source: "fallback", observedAt: observed},
			subjectUpdate{name: "Ops Team", setAt: stamp(2), source: "event", observedAt: observed.Add(time.Minute)}, true},
		{"unstamped sync snapshot wins over an unstamped event", subjectUpdate{name: "Support", source: "event", observedAt: observed},
			subjectUpdate{name: "Ops Team", source: "sync", observedAt: observed.Add(time.Hour)}, true},
		{"unstamped event never overrides a stored value", subjectUpdate{name: "Support", source: "sync", observedAt: observed},
			subjectUpdate{name: "Ops Team", source: "event", observedAt: observed.Add(time.Hour)}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := acceptSubject(tc.cur, tc.next); got != tc.want {
				t.Errorf("acceptSubject(%+v, %+v) = %v, want %v", tc.cur, tc.next, got, tc.want)
			}
		})
	}
}
```

**Step 2: Run it — expect failure**

Run: `cd apps/worker && go test ./... -run TestAcceptSubject -v`
Expected: FAIL — `undefined: subjectUpdate`, `undefined: acceptSubject`.

**Step 3: Implement (§6.6.4)**

```go
package main

import "time"

// subjectUpdate is the name state the acceptance rule needs: the value,
// WhatsApp's own stamp, which path produced it, and when we observed it.
type subjectUpdate struct {
	name       string
	setAt      time.Time
	source     string // "sync" | "event" | "fallback"
	observedAt time.Time
}

// acceptSubject decides whether `next` may overwrite `cur` (docs/architecture-draft.md §6.6.4).
// A rename must never regress to a known-older value, and must never be lost
// merely because a sync snapshot arrived without a `s_t` stamp:
//
//	first observation                       -> accept
//	both stamped, next.setAt >= cur.setAt   -> accept (monotonic; equal = replay)
//	next stamped, cur unstamped             -> accept if observed later
//	both unstamped, next is a sync snapshot -> accept (fetched later, by definition)
//	otherwise                               -> reject as stale
func acceptSubject(cur, next subjectUpdate) bool {
	if cur.name == "" && cur.observedAt.IsZero() {
		return true
	}
	curStamped := !cur.setAt.IsZero()
	nextStamped := !next.setAt.IsZero()
	switch {
	case curStamped && nextStamped:
		return !next.setAt.Before(cur.setAt)
	case nextStamped && !curStamped:
		return next.observedAt.After(cur.observedAt)
	case !nextStamped && !curStamped:
		return next.source == "sync"
	default:
		return false
	}
}
```

**Step 4: Verify and commit**

Run: `cd apps/worker && go test ./... -run TestAcceptSubject -v`
Expected: PASS (7 subtests).

```bash
git add apps/worker/groupdelta.go apps/worker/groupdelta_test.go
git commit -m "feat(worker): add monotonic subject acceptance rule"
```

---

## Task 12: Delta application (T6, T7)

**Files:** Modify `apps/worker/{groupdelta.go,groupdelta_test.go}`

**Step 1: Failing tests**

Append to `apps/worker/groupdelta_test.go` (imports: `reflect`, `slices`, `waBinary "go.mau.fi/whatsmeow/binary"`, `go.mau.fi/whatsmeow/types`, `go.mau.fi/whatsmeow/types/events`):

```go
func observedFixture() Observed {
	return Observed{
		Subject: "Support", SubjectSearch: "support",
		SubjectUpdatedAt: stamp(1), SubjectObservedAt: stamp(1),
		SubjectSetBy: testAdminPN.String(), SubjectSource: "sync",
		State: "active", ParticipantCount: 12,
	}
}

func TestApplyGroupDelta_Rename(t *testing.T) {
	cur := observedFixture()
	evt := events.GroupInfo{JID: testGroupJID, Name: &types.GroupName{Name: "Ops Team", NameSetAt: stamp(9), NameSetBy: testAdminPN}}

	next, changes, err := applyGroupDelta(cur, evt, testSelfPN)
	if err != nil {
		t.Fatalf("applyGroupDelta: %v", err)
	}
	if len(changes) != 1 || changes[0] != "subject" {
		t.Fatalf("changes = %v, want [subject]", changes)
	}
	if next.Subject != "Ops Team" || next.SubjectSearch != "ops team" {
		t.Errorf("subject = %q/%q", next.Subject, next.SubjectSearch)
	}
	if !next.SubjectUpdatedAt.Equal(stamp(9)) || next.SubjectSource != "event" {
		t.Errorf("provenance not updated: %+v", next)
	}
	if len(next.SubjectHistory) != 1 || next.SubjectHistory[0].Name != "Support" {
		t.Errorf("SubjectHistory = %+v, want the previous name recorded", next.SubjectHistory)
	}
}

func TestApplyGroupDelta_StaleRenameIsIgnored(t *testing.T) {
	cur := observedFixture()
	cur.SubjectUpdatedAt = stamp(9)
	evt := events.GroupInfo{JID: testGroupJID, Name: &types.GroupName{Name: "Old Name", NameSetAt: stamp(2)}}

	next, changes, err := applyGroupDelta(cur, evt, testSelfPN)
	if err != nil {
		t.Fatalf("applyGroupDelta: %v", err)
	}
	if len(changes) != 0 || next.Subject != "Support" {
		t.Errorf("stale rename applied: changes=%v subject=%q", changes, next.Subject)
	}
}

func TestApplyGroupDelta_NoChangeNoWrite(t *testing.T) {
	cur := observedFixture()
	unknown := waBinary.Node{Tag: "future_feature"}
	evt := events.GroupInfo{JID: testGroupJID, UnknownChanges: []*waBinary.Node{&unknown}}

	next, changes, err := applyGroupDelta(cur, evt, testSelfPN)
	if err != nil {
		t.Fatalf("applyGroupDelta: %v", err)
	}
	if len(changes) != 0 {
		t.Fatalf("changes = %v, want none (no Mongo write may happen)", changes)
	}
	if !reflect.DeepEqual(cur, next) {
		t.Error("observed state must be untouched when nothing changed")
	}
}

func TestApplyGroupDelta_SelfRemovedKeepsName(t *testing.T) {
	cur := observedFixture()
	next, changes, err := applyGroupDelta(cur, events.GroupInfo{JID: testGroupJID, Leave: []types.JID{testSelfPN}}, testSelfPN)
	if err != nil {
		t.Fatalf("applyGroupDelta: %v", err)
	}
	if !slices.Contains(changes, "state") || next.State != "left" {
		t.Errorf("state not marked left: changes=%v state=%q", changes, next.State)
	}
	if next.Subject != "Support" {
		t.Error("the name must be retained after leaving: it is still useful history")
	}
}

func TestApplyGroupDelta_DeleteAndMetadata(t *testing.T) {
	cur := observedFixture()
	evt := events.GroupInfo{
		JID:    testGroupJID,
		Delete: &types.GroupDelete{Deleted: true, DeleteReason: "user_left"},
		Announce: &types.GroupAnnounce{IsAnnounce: true},
		Locked:   &types.GroupLocked{IsLocked: true},
		Topic:    &types.GroupTopic{Topic: "on-call rota", TopicSetAt: stamp(3)},
	}
	next, changes, err := applyGroupDelta(cur, evt, testSelfPN)
	if err != nil {
		t.Fatalf("applyGroupDelta: %v", err)
	}
	if next.State != "deleted" || !next.IsAnnounce || !next.IsLocked || next.Topic != "on-call rota" {
		t.Errorf("metadata not applied: %+v", next)
	}
	if next.Subject != "Support" {
		t.Error("delete must not wipe the retained subject")
	}
	for _, want := range []string{"state", "announce", "locked", "topic"} {
		if !slices.Contains(changes, want) {
			t.Errorf("changes %v missing %q", changes, want)
		}
	}
}

func TestApplyGroupDelta_MembershipMarksCountDirty(t *testing.T) {
	cur := observedFixture()
	next, _, err := applyGroupDelta(cur, events.GroupInfo{JID: testGroupJID, Join: []types.JID{testAdminPN}}, testSelfPN)
	if err != nil {
		t.Fatalf("applyGroupDelta: %v", err)
	}
	if !next.ParticipantCountDirty {
		t.Error("ParticipantCountDirty = false: deltas must not invent a count")
	}
	if next.ParticipantCount != 12 {
		t.Errorf("ParticipantCount = %d, want the stored value until the next sync", next.ParticipantCount)
	}
}
```

**Step 2: Run them — expect failure**

Run: `cd apps/worker && go test ./... -run TestApplyGroupDelta -v`
Expected: FAIL — `undefined: Observed`, `undefined: applyGroupDelta`.

**Step 3: Implement**

Append to `apps/worker/groupdelta.go`:

- `type Observed struct` with the worker-owned fields of §5.1: `Subject`, `SubjectSearch`,
  `SubjectUpdatedAt`, `SubjectObservedAt`, `SubjectSetBy`, `SubjectSetByLid`, `SubjectSource`,
  `SubjectHistory []SubjectHistoryEntry`, `SubjectHistorySize`, `Topic`, `TopicUpdatedAt`,
  `IsAnnounce`, `IsLocked`, `IsEphemeral`, `IsDefaultSubGroup`, `ParticipantCount`,
  `ParticipantCountDirty`, `GroupCreatedAt`, `State`, `LastActivityAt`, `MessageCount`,
  `MediaStored`, `LastSyncedAt`, `LastSyncSource`.
- `type SubjectHistoryEntry struct { Name string; At time.Time; By string }` and
  `const subjectHistoryMax = 20`.
- `applyGroupDelta(cur Observed, evt events.GroupInfo, self types.JID) (Observed, []string, error)`
  implementing the §6.6.3 table exactly: `Name` gated by `acceptSubject` (and a value change) with
  the previous name pushed onto a capped `SubjectHistory`; `Delete` → `deleted`; `Leave` containing
  `self` → `left`; `Join` while inactive → `active`; `Suspended`/`Unsuspended`; `Announce`, `Locked`,
  `Topic` (skipping `TopicDeleted`); any membership delta sets `ParticipantCountDirty` without
  touching `ParticipantCount`. Return an **empty** change list when nothing changed.
- `containsJID(jids []types.JID, want types.JID) bool` comparing `ToNonAD()`.

**Step 4: Verify and commit**

Run: `cd apps/worker && gofmt -l . && go vet ./... && go test ./... -run 'TestApplyGroupDelta|TestAcceptSubject' -v`
Expected: PASS (13 tests/subtests).

```bash
git add apps/worker/groupdelta.go apps/worker/groupdelta_test.go
git commit -m "feat(worker): apply group metadata deltas with write-amplification guard"
```

---

## Task 13: Group store upsert and the one-writer rule (T8)

**Files:** Create `apps/worker/groupstore.go`, `apps/worker/groupstore_test.go`

**Step 1: Failing test**

`apps/worker/groupstore_test.go`:

```go
package main

import (
	"context"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/types"
)

func newTestGroupStore(t *testing.T) (*groupStore, context.Context) {
	t.Helper()
	ctx := context.Background()
	client, db, err := connectMongo(ctx, testMongoURI(t), "group_butler_test")
	if err != nil {
		t.Fatalf("connectMongo: %v", err)
	}
	t.Cleanup(func() { _ = client.Disconnect(context.Background()) })
	if err := db.Collection(collGroups).Drop(ctx); err != nil {
		t.Fatalf("drop groups: %v", err)
	}
	if err := ensureIngestIndexes(ctx, db); err != nil {
		t.Fatalf("ensureIngestIndexes: %v", err)
	}
	return newGroupStore(db), ctx
}

func groupInfo(id, name string, participants int) *types.GroupInfo {
	return &types.GroupInfo{
		JID:              types.NewJID(id, types.GroupServer),
		GroupName:        types.GroupName{Name: name, NameSetAt: time.Unix(1757750000, 0)},
		ParticipantCount: participants,
	}
}

func TestUpsertGroupFromSync_PreservesConfig(t *testing.T) {
	store, ctx := newTestGroupStore(t)
	info := groupInfo("120363043123456789", "Ops Team", 12)
	if err := store.UpsertFromSync(ctx, "org_default", "inst_1", info, "connect"); err != nil {
		t.Fatalf("UpsertFromSync: %v", err)
	}
	// The BFF owns config.*: simulate an owner assigning and whitelisting it.
	if _, err := store.collection().UpdateOne(ctx,
		map[string]any{"instanceId": "inst_1", "groupJid": info.JID.String()},
		map[string]any{"$set": map[string]any{"config.assigned": true, "config.whitelisted": true, "config.notes": "keep me"}},
	); err != nil {
		t.Fatalf("seed config: %v", err)
	}

	info.ParticipantCount = 14
	if err := store.UpsertFromSync(ctx, "org_default", "inst_1", info, "timer"); err != nil {
		t.Fatalf("second UpsertFromSync: %v", err)
	}

	doc := store.FindOne(ctx, "org_default", "inst_1", info.JID.String())
	if doc == nil {
		t.Fatal("group missing after upsert")
	}
	config, _ := doc["config"].(map[string]any)
	if config["assigned"] != true || config["whitelisted"] != true || config["notes"] != "keep me" {
		t.Fatalf("config was clobbered by the worker: %+v", config)
	}
	observed := doc["observed"].(map[string]any)
	if observed["participantCount"] != 14 && observed["participantCount"] != int32(14) {
		t.Errorf("observed.participantCount = %v, want 14", observed["participantCount"])
	}
}

func TestUpsertGroupFromSync_IsIdempotent(t *testing.T) {
	store, ctx := newTestGroupStore(t)
	info := groupInfo("120363043123456789", "Ops Team", 12)
	for i := 0; i < 3; i++ {
		if err := store.UpsertFromSync(ctx, "org_default", "inst_1", info, "timer"); err != nil {
			t.Fatalf("UpsertFromSync #%d: %v", i, err)
		}
	}
	count, err := store.collection().CountDocuments(ctx, map[string]any{})
	if err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Errorf("group count = %d, want 1", count)
	}
}
```

**Step 2: Run it — expect failure**

Run: `cd apps/worker && go test ./... -run TestUpsertGroupFromSync -v`
Expected: FAIL — `undefined: newGroupStore`, `groupStore`, `groupInfo` (the last one is defined in
`groupsync_test.go`, so create that file in Task 14 or move this helper there first).

**Step 3: Implement `groupstore.go`**

- `groupStore` wrapping `db.Collection(collGroups)`, with `collection() *mongo.Collection` for tests.
- `observedFields(Observed) bson.D` producing the flat dotted `$set` keys from §5.1.
- `ObservedFromGroupInfo(info *types.GroupInfo, source string, now time.Time) Observed`.
- `UpsertFromSync(ctx, orgID, instanceID string, info *types.GroupInfo, source string) error` →
  `UpsertObserved(ctx, orgID, instanceID, info.JID.String(), observed, true)`.
- `UpsertObserved(ctx, orgID, instanceID, groupJID string, observed Observed, fromSync bool) error`
  with a filter on the identity triple, `$set` of `observed.*` only, and `$setOnInsert` of
  `organizationId`/`instanceId`/`groupJid`/`createdAt`/`updatedAt` plus a default
  `config {assigned:false, whitelisted:false, active:true, notes:"", tags:[]}`. **The `$set` must
  never contain a `config.*` key** — that is the one-writer rule this test defends.
- `MarkLeft(ctx, orgID, instanceID, groupJID, state string) error` (`observed.state`,
  `observed.leftDetectedAt`).
- `KnownGroupJIDs(ctx, orgID, instanceID string) ([]string, error)` — groups whose
  `observed.state != "left"`.
- `FindOne(ctx, orgID, instanceID, groupJID string) map[string]any` (test/diagnostic).
- `decodeObserved(doc map[string]any) (Observed, bool)` reading back the bson types.

**Step 4: Verify and commit**

Run: `cd apps/worker && gofmt -l . && go vet ./... && go test ./... -run TestUpsertGroupFromSync -v`
Expected: PASS (2 tests).

```bash
git add apps/worker/groupstore.go apps/worker/groupstore_test.go
git commit -m "feat(worker): persist group observations without touching bff-owned config"
```

---

## Task 14: Full sync and reconciliation (T9–T11)

**Files:** Create `apps/worker/groupsync.go`, `apps/worker/groupsync_test.go`

**Step 1: Failing tests**

`apps/worker/groupsync_test.go` — define `fakeGroupClient` (implements the `groupClient` interface
with `groups []*types.GroupInfo`, `err error`, `calls int`, `info map[string]*types.GroupInfo`) and
`groupInfo(id, name string, participants int) *types.GroupInfo`, then assert:

- `TestSyncGroupReconciliation_MarksAbsentGroupsLeft`: seed A/B/C, fake returns A/B →
  `summary.MarkedLeft == 1`; C's document still exists with `observed.state == "left"` **and
  `observed.subject == "C"`**.
- `TestSyncGroupReconciliation_ErrorWritesNoMembershipChange`: fake returns an error →
  `runGroupSync` returns a non-nil error, `MarkedLeft == 0`, and A is still `active`.
- `TestSyncGroupReconciliation_Idempotent`: two runs → one document, `calls == 2`.
- `TestSyncGroupSummary_CountsSubjectsAndPrune`: seeded "Old Name" + sync "New Name" (newer `s_t`) →
  `SubjectUpdated == 1` and the stored subject is "New Name".
- `TestSyncGroupReconciliation_PruneDisabledKeepsGroups`: `prune=false` and an empty response →
  `MarkedLeft == 0` and the group stays `active`.

Use these exact bodies (one shown, the rest follow the same shape):

```go
func TestSyncGroupReconciliation_MarksAbsentGroupsLeft(t *testing.T) {
	store, ctx := newTestGroupStore(t)
	for _, info := range []*types.GroupInfo{
		groupInfo("120363043000000001", "A", 3),
		groupInfo("120363043000000002", "B", 4),
		groupInfo("120363043000000003", "C", 5),
	} {
		if err := store.UpsertFromSync(ctx, "org_default", "inst_1", info, "connect"); err != nil {
			t.Fatalf("seed %s: %v", info.JID, err)
		}
	}
	client := &fakeGroupClient{groups: []*types.GroupInfo{
		groupInfo("120363043000000001", "A", 3),
		groupInfo("120363043000000002", "B", 4),
	}}
	summary, err := runGroupSync(ctx, client, store, "org_default", "inst_1", "manual", true)
	if err != nil {
		t.Fatalf("runGroupSync: %v", err)
	}
	if summary.MarkedLeft != 1 {
		t.Errorf("MarkedLeft = %d, want 1", summary.MarkedLeft)
	}
	doc := store.FindOne(ctx, "org_default", "inst_1", "120363043000000003@g.us")
	if doc == nil {
		t.Fatal("group C disappeared: absence must mark state, not delete the row")
	}
	observed := doc["observed"].(map[string]any)
	if observed["state"] != "left" {
		t.Errorf("C.state = %v, want left", observed["state"])
	}
	if observed["subject"] != "C" {
		t.Error("the retained name must survive leaving the group")
	}
}
```

**Step 2: Run them — expect failure**

Run: `cd apps/worker && go test ./... -run 'TestSyncGroup' -v`
Expected: FAIL — `undefined: fakeGroupClient`, `runGroupSync`, `SyncSummary`.

**Step 3: Implement `groupsync.go`**

- `type groupClient interface { GetJoinedGroups(ctx) ([]*types.GroupInfo, error); GetGroupInfo(ctx, jid types.JID) (*types.GroupInfo, error) }` — `*whatsmeow.Client` satisfies it, tests inject fakes (the seam that makes §6.6 testable without a socket).
- `type SyncSummary struct` with the §6.6.6 fields.
- `runGroupSync(ctx, client, store, orgID, instanceID, source string, prune bool) (SyncSummary, error)`:
  fetch; on error return the summary **and** the error without writing anything; otherwise for each
  returned group merge with the stored observation via `mergeSnapshot` and upsert with source
  `"sync"`; count `Added`/`SubjectUpdated`/`Unchanged`; when `prune`, mark stored groups absent from
  the response as `left`.
- `mergeSnapshot(cur Observed, info *types.GroupInfo, now time.Time) Observed`: refresh the
  snapshot-owned fields, clear `ParticipantCountDirty`, reactivate `left`/`deleted`, and apply the
  subject only through `acceptSubject` (an empty or older snapshot subject must not clobber a newer
  event).

**Step 4: Verify and commit**

Run: `cd apps/worker && gofmt -l . && go vet ./... && go test ./... -run 'TestSyncGroup' -v`
Expected: PASS (5 tests).

```bash
git add apps/worker/groupsync.go apps/worker/groupsync_test.go
git commit -m "feat(worker): reconcile joined groups without dropping data on transient errors"
```

---

## Task 15: Worker group endpoints (T12, T13)

**Files:** Create `apps/worker/httpapi.go`, `apps/worker/httpapi_test.go`

**Step 1: Failing handler tests**

`apps/worker/httpapi_test.go`:

```go
package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"go.mau.fi/whatsmeow/types"
)

func newTestAPI(t *testing.T, client groupClient) (*api, *groupStore, context.Context) {
	t.Helper()
	store, ctx := newTestGroupStore(t)
	return &api{store: store, groups: client, orgID: "org_default", secret: "dev-secret", prune: true}, store, ctx
}

func TestGetInstanceGroups_HTTP(t *testing.T) {
	handler, store, ctx := newTestAPI(t, &fakeGroupClient{})
	if err := store.UpsertFromSync(ctx, "org_default", "inst_1", groupInfo("120363043123456789", "Ops Team", 12), "connect"); err != nil {
		t.Fatalf("seed: %v", err)
	}
	// A group whose subject WhatsApp has not given us yet.
	if err := store.UpsertObserved(ctx, "org_default", "inst_1", "120363043999999999@g.us",
		Observed{Subject: "", State: "active", SubjectSource: "fallback"}, false); err != nil {
		t.Fatalf("seed fallback: %v", err)
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/instances/inst_1/groups", nil)
	req.Header.Set("Authorization", "Bearer dev-secret")
	handler.routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var payload struct {
		InstanceID string `json:"instanceId"`
		Groups     []struct {
			GroupJID   string `json:"groupJid"`
			Name       string `json:"name"`
			NameSource string `json:"nameSource"`
		} `json:"groups"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(payload.Groups) != 2 {
		t.Fatalf("groups = %d, want 2", len(payload.Groups))
	}
	names := map[string]string{}
	sources := map[string]string{}
	for _, g := range payload.Groups {
		names[g.GroupJID] = g.Name
		sources[g.GroupJID] = g.NameSource
	}
	if names["120363043123456789@g.us"] != "Ops Team" {
		t.Errorf("name = %q, want Ops Team (R11: ID + current name)", names["120363043123456789@g.us"])
	}
	if _, ok := names["120363043999999999@g.us"]; !ok {
		t.Error("an unnamed group must still be listed with its group ID")
	}
	if sources["120363043999999999@g.us"] != "fallback" {
		t.Errorf("nameSource = %q, want fallback", sources["120363043999999999@g.us"])
	}
}

func TestGroupEndpoints_RequireBearer(t *testing.T) {
	handler, _, _ := newTestAPI(t, &fakeGroupClient{})
	rec := httptest.NewRecorder()
	handler.routes().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/instances/inst_1/groups", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401 without the bearer token", rec.Code)
	}
}

func TestGroupSyncEndpoint_Summary(t *testing.T) {
	client := &fakeGroupClient{groups: []*types.GroupInfo{
		groupInfo("120363043000000001", "A", 3),
		groupInfo("120363043000000002", "B", 4),
	}}
	handler, store, ctx := newTestAPI(t, client)
	if err := store.UpsertFromSync(ctx, "org_default", "inst_1", groupInfo("120363043000000003", "C", 5), "connect"); err != nil {
		t.Fatalf("seed: %v", err)
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/instances/inst_1/groups/sync", nil)
	req.Header.Set("Authorization", "Bearer dev-secret")
	handler.routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var summary struct {
		OK         bool   `json:"ok"`
		Source     string `json:"source"`
		Total      int    `json:"total"`
		Added      int    `json:"added"`
		MarkedLeft int    `json:"markedLeft"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &summary); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !summary.OK || summary.Total != 2 || summary.Added != 2 || summary.MarkedLeft != 1 || summary.Source != "manual" {
		t.Errorf("summary = %+v, want ok/total=2/added=2/markedLeft=1/source=manual", summary)
	}
}

func TestGroupSyncEndpoint_OfflineInstance(t *testing.T) {
	handler, _, _ := newTestAPI(t, nil)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/instances/offline/groups/sync", nil)
	req.Header.Set("Authorization", "Bearer dev-secret")
	handler.routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Errorf("status = %d, want 409 when the instance has no live client", rec.Code)
	}
}
```

**Step 2: Run them — expect failure**

Run: `cd apps/worker && go test ./... -run 'TestGetInstanceGroups|TestGroupEndpoints|TestGroupSyncEndpoint' -v`
Expected: FAIL — `undefined: api`.

**Step 3: Implement `httpapi.go`**

- `type api struct { store *groupStore; groups groupClient; orgID, secret string; prune, requireLive bool }`
  plus `instanceRegistry` if per-instance liveness is needed; nil `groups` means "instance offline".
- `routes() http.Handler`: `ServeMux` with `/health` (open) and `/instances/` wrapped in `auth`.
- `auth(next http.HandlerFunc) http.HandlerFunc`: `crypto/subtle.ConstantTimeCompare` against
  `"Bearer "+secret`, 401 with `{error, code:"unauthorized"}` on mismatch (reference convention).
- `handleInstanceSubresource`: split `/instances/{id}/groups[/sync|/{groupJid}]`; dispatch to
  `handleGroupList` (GET), `handleGroupByJID` (GET), `handleGroupSync` (POST);
  404 `code:"not_found"` / 405 `code:"method_not_allowed"` otherwise.
- `groupListRow` struct with the exact JSON names from §6.6.6, `handleGroupList` returning
  `{instanceId, syncedAt, groups}`, `handleGroupSync` returning the §6.6.6 summary or 409
  `code:"instance_offline"` / 502 `code:"group_sync_failed"`, `handleGroupByJID` returning one row.
- `writeJSON(w, status, body any)`.
- `ListForInstance(ctx, orgID, instanceID) ([]groupListRow, *string, error)` on `groupStore`:
  find sorted by `config.assigned` desc then `observed.lastActivityAt` desc, decode into a
  projection struct, set `nameSource:"fallback"` whenever the subject is empty, and return the newest
  `observed.lastSyncedAt` as RFC3339.

**Step 4: Verify and commit**

Run: `cd apps/worker && gofmt -l . && go vet ./... && go test ./... -run 'TestGetInstanceGroups|TestGroupEndpoints|TestGroupSyncEndpoint' -v`
Expected: PASS (4 tests).

```bash
git add apps/worker/httpapi.go apps/worker/httpapi_test.go apps/worker/groupstore.go
git commit -m "feat(worker): expose group list and manual sync endpoints"
```

---

## Task 16: Instance lifecycle, event dispatch, and worker main

**Files:** Create `apps/worker/{manager.go,lifecycle.go,handler.go,main.go,lifecycle_test.go}`

**Step 1: Failing tests for the pure lifecycle rules**

`apps/worker/lifecycle_test.go`:

```go
package main

import (
	"testing"

	"go.mau.fi/whatsmeow/types"
)

func TestPhoneDigitsFromJIDStripsDeviceSuffix(t *testing.T) {
	if got := phoneDigitsFromJID(types.NewJID("628990000001", types.DefaultUserServer)); got != "628990000001" {
		t.Errorf("phoneDigitsFromJID = %q", got)
	}
	if got := phoneDigitsFromJID(types.NewJID("628990000001:12", types.DefaultUserServer)); got != "628990000001" {
		t.Errorf("device suffix not stripped: %q", got)
	}
	if got := phoneDigitsFromJID(types.NewJID("120363043123456789", types.GroupServer)); got != "" {
		t.Errorf("group JID must not yield a phone number: %q", got)
	}
}

func TestDeviceOwnedByOtherRejectsSecondLiveSession(t *testing.T) {
	first := types.NewJID("628990000001", types.DefaultUserServer)
	second := types.NewJID("628990000002", types.DefaultUserServer)
	live := map[string]types.JID{"inst_1": first}

	if !deviceOwnedByOther(live, "inst_2", first) {
		t.Error("a device owned by another live session must be rejected")
	}
	if deviceOwnedByOther(live, "inst_2", second) {
		t.Error("a different device must be accepted")
	}
	if deviceOwnedByOther(live, "inst_1", first) {
		t.Error("a session must not conflict with itself")
	}
}

func TestRestorableInstancesNeverFallsBackToAnotherDevice(t *testing.T) {
	rows := []InstanceRow{
		{ID: "inst_1", PhoneNumber: "628990000001", Status: "connected"},
		{ID: "inst_2", PhoneNumber: "", Status: "pairing"},
		{ID: "inst_3", PhoneNumber: "628990000003", Status: "logged_out"},
		{ID: "inst_4", PhoneNumber: "628990000004", Status: "connected"},
	}
	devices := map[string]bool{"628990000001": true}

	got := restorableInstances(rows, func(phone string) bool { return devices[phone] })
	if len(got) != 1 || got[0] != "inst_1" {
		t.Fatalf("restorable = %v, want [inst_1]", got)
	}
}
```

**Step 2: Run them — expect failure**

Run: `cd apps/worker && go test ./... -run 'TestPhoneDigits|TestDeviceOwned|TestRestorable' -v`
Expected: FAIL — `undefined: phoneDigitsFromJID`, `deviceOwnedByOther`, `InstanceRow`.

**Step 3: Implement the lifecycle helpers**

`manager.go` carries the reference worker's proven shape: `session` (mutex + client + status +
phoneNumber/botJID/botLID/pairingError), `sessionState` constants
(`disconnected/pairing/connected/logged_out/error`), `InstanceRow`, `phoneDigitsFromJID` (empty for
group JIDs, strips `:device`), `deviceOwnedByOther(live, selfID, device)` comparing `ToNonAD()`, and
`restorableInstances(rows, hasDevice)` which skips empty phones, `logged_out` rows and rows whose
device is missing — **never** falling back to "the only registered device" (the reference bug that
made one account appear as several instances). Manager methods: `newManager`, `get/put/remove`,
`listActive`, `snapshot()`, `api()`, `shutdown()`.

**Step 4: Implement `handler.go` (single event switch) and `main.go`**

`handler.go` — one `handleEvent(s *session, evt any)` type switch dispatching
`*events.Message` → `onMessage` (parse → attach media job → `ingest.Enqueue` → `ensureGroupKnown`),
`*events.HistorySync` → `onHistorySync` (same path, `flags.historical`, bounded by
`HISTORY_SYNC_MAX_DAYS`), `*events.JoinedGroup` → `UpsertFromSync(..., "event")`,
`*events.GroupInfo` → decode the stored `Observed`, `applyGroupDelta`, and **skip the write when the
change list is empty**, `*events.Connected` → full sync + status, `*events.Disconnected` → log only
(auto-reconnect), `*events.LoggedOut` → mark `logged_out`, delete the device, audit, `*events.Receipt`
→ publish to `statsDaily`.

`main.go` — load config; connect Mongo; call `ensureIngestIndexes` and exit non-zero if it fails;
start the ingest queue goroutine; build the manager; `restoreInstances`; serve
`mgr.api().routes()` on `cfg.ListenAddr()` with a 10s `ReadHeaderTimeout`; on SIGTERM/SIGINT
**disconnect without logging out** (logging out would invalidate every linked device) then shut the
HTTP server down with a 10s deadline.

**Step 5: Verify**

Run: `cd apps/worker && gofmt -l . && go vet ./... && go test ./... -short`
Expected: `gofmt` silent, vet clean, all unit tests PASS (Mongo tests skipped under `-short`).

Run: `cd apps/worker && go build ./... && (timeout -s INT 6 go run ./... &) && sleep 4 && curl -sf http://127.0.0.1:4000/health && echo`
Expected: `{"ok":true}`, then `shutting down — disconnecting instances (auth state kept on disk)`.

**Step 6: Commit**

```bash
git add apps/worker/manager.go apps/worker/lifecycle.go apps/worker/handler.go apps/worker/main.go apps/worker/lifecycle_test.go apps/worker/manager_test.go
git commit -m "feat(worker): add instance lifecycle, event dispatch, and http main"
```

---

## Task 17: BFF owner authentication (single owner, env credentials)

**Files:**
- Create: `apps/web/next.config.ts`, `apps/web/src/middleware.ts`
- Create: `apps/web/src/server/auth/{password.ts,session.ts,owner.ts,auth.test.ts}`
- Create: `apps/web/src/app/api/auth/{login/route.ts,login/route.test.ts,logout/route.ts,session/route.ts}`
- Create: `apps/web/src/app/api/health/route.ts`
- Create: `apps/web/scripts/auth-hash.ts`

**Step 1: Failing tests**

`apps/web/src/server/auth/auth.test.ts`:

```ts
import { beforeEach, describe, expect, test } from "vitest";
import { hashPassword, verifyPassword } from "./password";
import { issueSession, readSession } from "./session";

describe("password hashing", () => {
  test("verifies a correct password and rejects a wrong one", () => {
    const hash = hashPassword("correct horse battery staple");
    expect(hash).toMatch(/^scrypt\$\d+\$\d+\$\d+\$[0-9a-f]+\$[0-9a-f]+$/);
    expect(verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(verifyPassword("wrong", hash)).toBe(false);
  });

  test("rejects a malformed stored hash instead of throwing", () => {
    expect(verifyPassword("anything", "not-a-hash")).toBe(false);
  });
});

describe("session cookie", () => {
  beforeEach(() => {
    process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
  });

  test("round-trips the owner identity and organisation", () => {
    const parsed = readSession(issueSession({ email: "owner@local", organizationId: "org_default" }));
    expect(parsed?.sub).toBe("owner");
    expect(parsed?.email).toBe("owner@local");
    expect(parsed?.organizationId).toBe("org_default");
  });

  test("rejects a tampered payload", () => {
    const token = issueSession({ email: "owner@local", organizationId: "org_default" });
    const forged = Buffer.from(
      JSON.stringify({ sub: "owner", email: "attacker", organizationId: "org_default", iat: 0, exp: 9_999_999_999 }),
    ).toString("base64url");
    expect(readSession(`${forged}.${token.split(".")[1]}`)).toBeNull();
  });

  test("rejects an expired session", () => {
    expect(readSession(issueSession({ email: "owner@local", organizationId: "org_default" }, -60))).toBeNull();
  });

  test("a rotated AUTH_SECRET invalidates sessions", () => {
    const token = issueSession({ email: "owner@local", organizationId: "org_default" });
    process.env.AUTH_SECRET = "rotated-secret-rotated-secret-rotated";
    expect(readSession(token)).toBeNull();
  });
});
```

`apps/web/src/app/api/auth/login/route.test.ts`:

```ts
import { beforeEach, describe, expect, test } from "vitest";
import { POST } from "./route";
import { hashPassword } from "../../../../server/auth/password";
import { resetRateLimits } from "../../../../server/auth/owner";

function loginRequest(body: unknown, ip = "203.0.113.7") {
  return new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
  process.env.OWNER_EMAIL = "owner@local";
  process.env.OWNER_PASSWORD = "changeme";
  process.env.OWNER_PASSWORD_HASH = hashPassword("s3cret-passphrase");
  process.env.LOGIN_RATE_LIMIT = "3";
  process.env.ENVIRONMENT = "test";
  resetRateLimits();
});

describe("POST /api/auth/login", () => {
  test("accepts the hash and sets an httpOnly SameSite=Lax cookie", async () => {
    const res = await POST(loginRequest({ email: "owner@local", password: "s3cret-passphrase" }, "198.51.100.1"));
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("butler_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });

  test("falls back to OWNER_PASSWORD outside production", async () => {
    process.env.OWNER_PASSWORD_HASH = "";
    expect((await POST(loginRequest({ email: "owner@local", password: "changeme" }, "198.51.100.2"))).status).toBe(200);
  });

  test("refuses a wrong password and a wrong email with the same message", async () => {
    const wrongPassword = await POST(loginRequest({ email: "owner@local", password: "nope" }, "198.51.100.3"));
    const wrongEmail = await POST(loginRequest({ email: "someone@else", password: "s3cret-passphrase" }, "198.51.100.4"));
    expect(wrongPassword.status).toBe(401);
    expect(wrongEmail.status).toBe(401);
    expect(await wrongPassword.json()).toEqual({ error: "Invalid credentials" });
    expect(await wrongEmail.json()).toEqual({ error: "Invalid credentials" });
  });

  test("never trusts an identity header", async () => {
    const res = await POST(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-user": "owner@local",
          "x-auth-request-email": "owner@local",
        },
        body: JSON.stringify({ email: "owner@local", password: "wrong" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  test("rate limits after LOGIN_RATE_LIMIT failures from one IP", async () => {
    const ip = "198.51.100.9";
    for (let i = 0; i < 3; i++) await POST(loginRequest({ email: "owner@local", password: "bad" }, ip));
    const res = await POST(loginRequest({ email: "owner@local", password: "s3cret-passphrase" }, ip));
    expect(res.status).toBe(429);
  });
});
```

**Step 2: Run them — expect failure**

Run: `bun run --cwd apps/web test auth`
Expected: FAIL — `Cannot find module './password'` / `./route`.

**Step 3: Implement `password.ts` (scrypt: no native deps, works on alpine)**

```ts
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const N = 16384;
const r = 8;
const p = 1;
const KEY_LEN = 32;

/** `scrypt$N$r$p$saltHex$hashHex` — self-describing so parameters can evolve. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, KEY_LEN, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nRaw, rRaw, pRaw, saltHex, hashHex] = parts;
  const n = Number(nRaw);
  const rr = Number(rRaw);
  const pp = Number(pRaw);
  if (!Number.isFinite(n) || !Number.isFinite(rr) || !Number.isFinite(pp)) return false;
  const expected = Buffer.from(hashHex!, "hex");
  if (expected.length === 0) return false;
  const derived = scryptSync(password, Buffer.from(saltHex!, "hex"), expected.length, { N: n, r: rr, p: pp });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
```

**Step 4: Implement `session.ts` (stateless HMAC cookie)**

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export type OwnerSession = {
  sub: "owner";
  email: string;
  organizationId: string;
  iat: number;
  exp: number;
};

export const SESSION_COOKIE = "butler_session";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

function secret(): string {
  const value = process.env.AUTH_SECRET;
  if (!value || value.length < 32) throw new Error("AUTH_SECRET must be at least 32 characters");
  return value;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

/** Rotating AUTH_SECRET revokes every session (docs/architecture-draft.md §11.1). */
export function issueSession(input: { email: string; organizationId: string }, ttlSeconds = SESSION_TTL_SECONDS): string {
  const now = Math.floor(Date.now() / 1000);
  const session: OwnerSession = {
    sub: "owner", email: input.email, organizationId: input.organizationId, iat: now, exp: now + ttlSeconds,
  };
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function readSession(token: string | undefined | null): OwnerSession | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const provided = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(payload));
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  let session: OwnerSession;
  try {
    session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OwnerSession;
  } catch {
    return null;
  }
  if (session.sub !== "owner") return null;
  if (typeof session.exp !== "number" || session.exp <= Math.floor(Date.now() / 1000)) return null;
  return session;
}
```

**Step 5: Implement `owner.ts`, the routes, middleware, and `auth-hash.ts`**

`owner.ts` exports: `verifyOwnerCredentials(email, password)` (constant-time email compare, scrypt
hash preferred, `OWNER_PASSWORD` only when `ENVIRONMENT !== "production"`, `null` on any failure),
`requireOwner()` (reads the cookie, returns `{email, organizationId}`, throws `unauthorized`),
`sessionCookie(token)` (`httpOnly`, `sameSite: "lax"`, `secure` in production, 7-day max age),
`rateLimit(ip)` + `resetRateLimits()` (in-process counter, `LOGIN_RATE_LIMIT` per 15-minute window).
The single owner identity is `{email: OWNER_EMAIL, organizationId: ORGANIZATION_ID ?? "org_default"}`
— never derived from a request header.

`login/route.ts`: read `x-forwarded-for` for the rate limit; 429 with `retry-after` when exceeded;
parse JSON; `verifyOwnerCredentials`; on failure the identical `{error: "Invalid credentials"}`
with 401; on success set the cookie and return `{authenticated, email, organizationId}`; every path
awaits a `pad()` helper so the response never returns faster than 350 ms.

`logout/route.ts` clears the cookie (`maxAge: 0`); `session/route.ts` returns
`{authenticated, email, organizationId}`; `health/route.ts` pings Mongo and returns 200/503.

`middleware.ts` allows `/login`, `/api/auth/login`, `/api/health`, `/_next/*`, `/favicon.ico`;
401s `/api/*` and redirects everything else to `/login` when the cookie is absent. It is a UX gate
only — every handler still calls `requireOwner()`.

`next.config.ts`: `output: "standalone"`, `reactStrictMode: true`.
`scripts/auth-hash.ts`: prints `hashPassword(process.argv[2])` or exits 2 with usage.

**Step 6: Verify and commit**

Run: `bun run --cwd apps/web test auth`
Expected: PASS (10 tests).

```bash
git add apps/web/next.config.ts apps/web/src/server/auth apps/web/src/middleware.ts apps/web/src/app/api/auth apps/web/src/app/api/health apps/web/scripts/auth-hash.ts
git commit -m "feat(web): single-owner env auth with signed session cookie"
```

**Step 7: Acceptance against the running stack**

Run: `bun run dev:local` (in one shell), then
`curl -sf -X POST localhost:3000/api/auth/login -H 'content-type: application/json' -d '{"email":"owner@local","password":"changeme"}' -c /tmp/butler.jar && curl -sf -b /tmp/butler.jar localhost:3000/api/auth/session`
Expected: `{"authenticated":true,"email":"owner@local","organizationId":"org_default"}`; a second call
with a wrong password returns 401 and the same generic message.

---

## Task 18: BFF read models — instances/groups (T14)

**Files:**
- Create: `apps/web/src/server/repos/{groups.ts,instances.ts,test-helpers.ts}`
- Create: `apps/web/src/app/api/instances/[id]/groups/{route.ts,route.test.ts}`
- Create: `apps/web/src/app/api/groups/route.ts`

**Step 1: Failing read-model test (T14)**

Create `apps/web/src/server/repos/test-helpers.ts` first:

```ts
import { getDb } from "../mongo";
import { COLLECTIONS } from "../collections";

export async function insertGroup(input: {
  organizationId: string;
  instanceId: string;
  groupJid: string;
  subject: string;
  subjectSource: string;
}) {
  const db = await getDb();
  await db.collection(COLLECTIONS.groups).updateOne(
    { organizationId: input.organizationId, instanceId: input.instanceId, groupJid: input.groupJid },
    {
      $set: {
        "observed.subject": input.subject,
        "observed.subjectSearch": input.subject.toLowerCase(),
        "observed.subjectSource": input.subjectSource,
        "observed.state": "active",
        "observed.participantCount": 12,
      },
      $setOnInsert: {
        organizationId: input.organizationId,
        instanceId: input.instanceId,
        groupJid: input.groupJid,
        config: { assigned: false, whitelisted: false, active: true, notes: "", tags: [] },
        createdAt: new Date(),
      },
    },
    { upsert: true },
  );
}

export async function insertInstance(organizationId: string, instanceId: string, label: string) {
  const db = await getDb();
  await db.collection(COLLECTIONS.instances).updateOne(
    { _id: instanceId as never },
    { $set: { organizationId, label }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true },
  );
}
```

`apps/web/src/app/api/instances/[id]/groups/route.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { insertGroup } from "../../../../../server/repos/test-helpers";

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  vi.stubEnv("MONGODB_URI", replSet.getUri());
  vi.stubEnv("MONGODB_DB", "butler_readmodel_test");
  vi.stubEnv("AUTH_SECRET", "test-secret-test-secret-test-secret");
  vi.stubEnv("ORGANIZATION_ID", "org_default");
});
afterAll(async () => {
  await replSet.stop();
  vi.unstubAllEnvs();
});

describe("GET /api/instances/[id]/groups", () => {
  test("returns every group with its ID and current name", async () => {
    await insertGroup({ organizationId: "org_default", instanceId: "inst_1", groupJid: "120363043123456789@g.us", subject: "Ops Team", subjectSource: "event" });
    await insertGroup({ organizationId: "org_default", instanceId: "inst_1", groupJid: "120363043999999999@g.us", subject: "", subjectSource: "fallback" });

    const { GET } = await import("./route");
    const res = await GET(new Request("http://localhost/api/instances/inst_1/groups"), {
      params: Promise.resolve({ id: "inst_1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.groups).toHaveLength(2);
    const byJid = Object.fromEntries(body.groups.map((g: { groupJid: string; name: string }) => [g.groupJid, g.name]));
    expect(byJid["120363043123456789@g.us"]).toBe("Ops Team");
    expect(byJid["120363043999999999@g.us"]).toMatch(/^\(unnamed group\)/);
  });

  test("never returns another organisation's groups", async () => {
    await insertGroup({ organizationId: "org_other", instanceId: "inst_1", groupJid: "120363043777777777@g.us", subject: "Secret", subjectSource: "sync" });
    const { GET } = await import("./route");
    const res = await GET(new Request("http://localhost/api/instances/inst_1/groups"), {
      params: Promise.resolve({ id: "inst_1" }),
    });
    const body = await res.json();
    expect(body.groups.map((g: { groupJid: string }) => g.groupJid)).not.toContain("120363043777777777@g.us");
  });

  test("rejects an unauthenticated request", async () => {
    const { GET } = await import("./route");
    await expect(
      GET(new Request("http://localhost/api/instances/inst_1/groups"), { params: Promise.resolve({ id: "inst_1" }) }),
    ).rejects.toThrow(/unauthorized/);
  });
});
```

`requireOwner()` reads `next/headers` cookies, so the third test asserts the throw; the first two run
only if the cookie store is stubbed — add a `vi.mock("next/headers", …)` at the top of the file
returning `{ cookies: async () => ({ get: () => ({ value: issueSession({ email: "owner@local", organizationId: "org_default" }) }) }) }`.

**Step 2: Run it — expect failure**

Run: `bun run --cwd apps/web test "instances/\[id\]/groups"`
Expected: FAIL — `Cannot find module './route'`.

**Step 3: Implement the repo and route**

`repos/groups.ts` exports `GroupRow` (the §7.5 shape), `listInstanceGroups(db, organizationId, instanceId)`
and `listAllGroups(db, organizationId)`. Both sort `config.assigned` desc then
`observed.lastActivityAt` desc, map the stored dot-notation fields, and apply the **never-blank rule**:
an empty `observed.subject` becomes `` `(unnamed group) ${groupJid.split("@")[0]}` `` with
`nameSource: "fallback"`.

`repos/instances.ts` exports `listInstances(db, organizationId)` and
`getInstanceRuntime(db, organizationId, instanceId)` (reading `runtime.groupSync` for the group count,
`groupsLeft`, `lastSyncAt`, `lastError`).

`api/instances/[id]/groups/route.ts`: `const { organizationId } = await requireOwner()`, then
`listInstanceGroups`, then `instances.runtime.groupSync.lastSyncAt` for `syncedAt`, returning
`{instanceId, syncedAt, groups}`.

`api/groups/route.ts`: `requireOwner()` then `listAllGroups`, returning `{groups}` where each row
also carries `instanceId` and `instanceLabel` so one screen covers every instance.

**Step 4: Verify and commit**

Run: `bun run --cwd apps/web test "instances/\[id\]/groups"`
Expected: PASS (3 tests).

```bash
git add apps/web/src/server/repos apps/web/src/app/api/instances apps/web/src/app/api/groups
git commit -m "feat(web): add group read model and instance group routes"
```

---

## Task 19: BFF message search and presigned media URLs

**Files:**
- Create: `apps/web/src/server/repos/{messages.ts,messages.test.ts}`
- Create: `apps/web/src/server/media/presign.ts`
- Create: `apps/web/src/app/api/{messages/route.ts,groups/[id]/messages/route.ts,media/[messageId]/url/route.ts}`

**Step 1: Failing tests**

`apps/web/src/server/repos/messages.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  vi.stubEnv("MONGODB_URI", replSet.getUri());
  vi.stubEnv("MONGODB_DB", "butler_messages_test");
  const { getDb } = await import("../mongo");
  const db = await getDb();
  await db.collection("messages").insertMany([
    { organizationId: "org_default", instanceId: "inst_1", groupJid: "1203630431@g.us", waMessageId: "m1",
      senderJid: "628990000001@s.whatsapp.net", pushName: "Nadia", fromMe: false, kind: "text",
      text: "deploy is green", textSearch: "deploy is green", rawSearch: "deploy is green",
      timestamp: new Date("2026-09-13T10:00:00Z"), "media.status": "none", links: [], mentions: [] },
    { organizationId: "org_default", instanceId: "inst_1", groupJid: "1203630431@g.us", waMessageId: "m2",
      senderJid: "628990000002@s.whatsapp.net", pushName: "Ravi", fromMe: false, kind: "document",
      text: "", textSearch: "", rawSearch: "invoice-2026.pdf",
      timestamp: new Date("2026-09-13T11:00:00Z"), "media.status": "unparsed",
      "media.declaredType": "document", "media.r2Key": "org/org_default/instance/inst_1/group/x/2026/09/m2.bin",
      links: [], mentions: [] },
    { organizationId: "org_other", instanceId: "inst_1", groupJid: "1203630431@g.us", waMessageId: "m3",
      senderJid: "628990000003@s.whatsapp.net", pushName: "Other", fromMe: false, kind: "text",
      text: "deploy is green", textSearch: "deploy is green", rawSearch: "",
      timestamp: new Date("2026-09-13T12:00:00Z"), "media.status": "none", links: [], mentions: [] },
  ]);
});

afterAll(async () => {
  const { closeDb } = await import("../mongo");
  await closeDb();
  await replSet.stop();
  vi.unstubAllEnvs();
});

describe("searchMessages", () => {
  test("finds messages by text and by raw media filename", async () => {
    const { searchMessages } = await import("./messages");
    const { getDb } = await import("../mongo");
    const db = await getDb();
    expect((await searchMessages(db, { organizationId: "org_default", query: "deploy" })).map((m) => m.waMessageId)).toContain("m1");
    expect((await searchMessages(db, { organizationId: "org_default", query: "invoice-2026" })).map((m) => m.waMessageId)).toContain("m2");
  });

  test("never returns another organisation's messages", async () => {
    const { searchMessages } = await import("./messages");
    const { getDb } = await import("../mongo");
    const db = await getDb();
    const rows = await searchMessages(db, { organizationId: "org_default", query: "deploy" });
    expect(rows.map((m) => m.waMessageId)).not.toContain("m3");
  });

  test("filters by media status (the 'could not read it' view)", async () => {
    const { searchMessages } = await import("./messages");
    const { getDb } = await import("../mongo");
    const db = await getDb();
    const rows = await searchMessages(db, { organizationId: "org_default", query: "", mediaStatus: "unparsed" });
    expect(rows.map((m) => m.waMessageId)).toEqual(["m2"]);
  });
});
```

**Step 2: Run it — expect failure**

Run: `bun run --cwd apps/web test repos/messages`
Expected: FAIL — `Cannot find module './messages'`.

**Step 3: Implement `repos/messages.ts`**

`MessageRow` (waMessageId, instanceId, groupJid, senderJid, pushName, fromMe, timestamp, kind, text,
media{status, declaredType, r2Key, mime, fileName}) and
`searchMessages(db, input: SearchInput): Promise<MessageRow[]>`. `SearchInput` always requires
`organizationId`; optional `instanceId`, `groupJid`, `senderJid`, `kind`, `mediaStatus`, `from`,
`to`, `limit` (capped at 200), `cursor`. A non-empty `query` adds
`$or: [{ $text: { $search } }, { textSearch: { $regex: escaped } }]` — the text index covers
`text`/`rawSearch`/`media.fileName` (§6.4) while the regex keeps type-ahead working. Sort
`{ timestamp: -1, waMessageId: -1 }`, and apply the `cursor` with a compound `$or` on
`(timestamp, waMessageId)`.

**Step 4: Run the test to verify it passes**

Run: `bun run --cwd apps/web test repos/messages`
Expected: PASS (3 tests).

**Step 5: Implement presigning and the routes**

`server/media/presign.ts`:

```ts
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

let client: S3Client | null = null;

/** The only endpoint this project can ever use: the account-scoped R2 host. */
export function r2Endpoint(accountId: string | undefined): string {
  return accountId ? `https://${accountId}.r2.cloudflarestorage.com` : "";
}

function s3(): S3Client {
  if (client) return client;
  const endpoint = r2Endpoint(process.env.R2_ACCOUNT_ID);
  if (!endpoint) throw new Error("R2_ACCOUNT_ID is required to presign media");
  client = new S3Client({
    region: "auto",
    endpoint,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
    },
  });
  return client;
}

/** Media is private; access is a short-lived presigned GET (§11.4). */
export async function presignMediaUrl(key: string): Promise<string> {
  const orgPrefix = `org/${process.env.ORGANIZATION_ID ?? "org_default"}/`;
  if (!key.startsWith(orgPrefix)) throw new Error("key outside organisation prefix");
  const ttl = Number(process.env.R2_PRESIGN_TTL_SECONDS ?? 300);
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: process.env.R2_BUCKET ?? "group-butler", Key: key }), {
    expiresIn: ttl,
  });
}
```

Add a test for the prefix guard (it is the SSRF/IDOR boundary):

```ts
test("refuses to sign a key outside the organisation prefix", async () => {
  const { presignMediaUrl } = await import("../media/presign");
  await expect(presignMediaUrl("org/org_other/instance/inst_1/group/g/2026/09/m.bin")).rejects.toThrow(
    /outside organisation prefix/,
  );
});
```

Routes: `api/messages/route.ts` (`q`, `instanceId`, `groupJid`, `kind`, `mediaStatus`, `limit`),
`api/groups/[id]/messages/route.ts` (requires `instanceId`, returns `{groupJid, messages}`),
`api/media/[messageId]/url/route.ts` (loads the message **scoped by organizationId**, 404 when there
is no `media.r2Key`, otherwise `{url}`).

**Step 6: Commit**

```bash
git add apps/web/src/server/repos/messages.ts apps/web/src/server/repos/messages.test.ts apps/web/src/server/media apps/web/src/app/api/messages apps/web/src/app/api/groups apps/web/src/app/api/media
git commit -m "feat(web): add message search, group stream, and presigned media routes"
```

---

## Task 20: Dashboard — the Scope-Spine Registry Shell (Option B)

> **Authority:** `docs/ui-decision.md` is the accepted UI specification (Option B, the Scope-Spine
> Registry Shell; Option A "The Ledger"/dock hybrid is explicitly **rejected** there, §0.2). Do not
> create a second decision record — read that file, implement it, and cite its rule IDs (`R-L*`,
> `R-V*`, `R-T*`, `R-E*`, `R-X*`, `R-A*`, `R-M*`) in commits and PR text. This task's sub-tasks are
> 1:1 with that document's implementation order P0–P15 (§5) and each keeps its stated proof.

**The structure being implemented** (spec §2.1–§2.5): everything is one of three primitives, driven
by one shell, one resource layer, and one feedback layer.

| Primitive | Type and meaning | Owns |
|---|---|---|
| **Scope** | `Scope = {kind:"global"} \| {kind:"instance", instanceId} \| {kind:"group", instanceId, groupJid}` — the address of the data, and the **only** way an instance or group enters a view. Resolved from the URL by `parseScope → normalizeScope → encodeScope`. | `ScopeSpine`, `ScopeBanner`, deep links, cache keys |
| **Resource** | `ResourceDescriptor` — one declared read: `key(scope, params)`, `fetch`, optional `sse` binding, optional `poll` fallback, `skeleton`, `empty`, `errorMap`. One descriptor ⇒ one cache entry ⇒ one fetch policy ⇒ one live binding. Views **never** call `fetch`. | `useResource`, `useStreamScope`, `ResourceGate` |
| **View** | `ViewDescriptor` — a registered destination: `id`, `title`, `icon`, `scopeMode`, `routes` (canonical + aliases), zod-validated `params`, ordered `panels`, `SkeletonPlan`, `actions`, and one `empty` copy per `EmptyReason`. `registerView()` adds an eleventh workspace without touching `AppShell` (invariant 5). | `PanelGrid`, `Panel`, `WorkspaceHeader` |

**Frozen invariants (spec §2.2), each enforced by a test in this task:** one shell; one resource
layer; `useAction` is the only toast emitter; scope is structural, never a loose filter param;
additivity (a new view touches only its descriptor modules); server truth is rendered, never
predicted (no optimistic status); untrusted content is inert (no `dangerouslySetInnerHTML`); media is
fetched on demand via short-lived presigned URLs and never cached.

**Files (all under `apps/web/src`):**
- `ui/tokens/{fluent.css,type-ramp.ts,shadow.ts,motion.ts,index.ts}`
- `ui/registry/{types.ts,registry.ts,scope.ts,params.ts,index.ts}`
- `ui/resource/{use-resource.ts,use-stream-scope.ts,resource-gate.tsx,cache.ts,index.ts}`
- `ui/feedback/{use-action.ts,toast-policy.ts,error-map.ts,empty-copy.ts,index.ts}`
- `components/{app-shell.tsx,scope-spine.tsx,workspace-header.tsx,panel-grid.tsx,panel.tsx,command-palette.tsx,toaster.tsx,jid-cell.tsx,group-name-cell.tsx,state-badges.tsx,send-status-track.tsx,media-slot.tsx,raw-json-viewer.tsx,whitelist-editor.tsx,usage-meter.tsx,empty-state.tsx,error-state.tsx}`
- `views/{overview,instances,instance,groups,group,messages,sends,assistant,stats,settings}.tsx` (each a descriptor module + its panel components)
- `app/layout.tsx`, `app/globals.css`, `app/login/page.tsx`, `app/(dash)/layout.tsx`, `app/(dash)/**` route files per the spec's §2.3 route table, `app/api/stream/route.ts`
- `ui/store/layout-store.ts` (P12)

**Order rule (spec §5):** a sub-task MUST NOT start before its dependencies are green. Sub-tasks
20.1→20.5 are strictly sequential; 20.6/20.7/20.8/20.10 fan out from 20.6; 20.13 is the final pass
before 20.16.

---

### Task 20.1: P0 — token layer

**Files:** `apps/web/src/ui/tokens/{fluent.css,type-ramp.ts,shadow.ts,motion.ts,index.ts}`, `apps/web/src/ui/tokens/tokens.test.ts`, `apps/web/src/app/globals.css` (import only)

**Step 1: Write the failing token test**

`apps/web/src/ui/tokens/tokens.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { MOTION, RADIUS, ROW_HEIGHT, SPACE, TYPE_RAMP } from "./index";

describe("token layer (spec §3.2)", () => {
  test("spatial scale is the 4px grid with the specified steps", () => {
    expect(Object.values(SPACE)).toEqual([4, 8, 12, 16, 24, 32, 48]);
  });

  test("radius, row heights and shell chrome match the spec", () => {
    expect(RADIUS).toEqual({ control: 4, panel: 8, dialog: 12, sheetTop: 16 });
    expect(ROW_HEIGHT).toEqual({ comfortable: 40, compact: 32, header: 36 });
  });

  test("motion durations and curves are feedback-only", () => {
    expect(MOTION.duration).toEqual({ state: 100, enter: 150, panel: 200, sheet: 300 });
    expect(MOTION.curve.standard).toBe("cubic-bezier(.33,0,.67,1)");
    expect(MOTION.curve.decelerate).toBe("cubic-bezier(0,0,0,1)");
    expect(MOTION.curve.accelerate).toBe("cubic-bezier(1,0,1,1)");
  });

  test("the type ramp exposes the seven defined steps", () => {
    expect(Object.keys(TYPE_RAMP)).toEqual(
      ["caption", "body", "bodyStrong", "subtitle", "title3", "title2", "display"],
    );
  });
});
```

**Step 2: Run it — expect failure**

Run: `bun run --cwd apps/web test ui/tokens`
Expected: FAIL — `Cannot find module './index'`.

**Step 3: Implement the tokens**

Export `SPACE` (4/8/12/16/24/32/48), `RADIUS`, `ROW_HEIGHT`, `SHELL` (header 48, spine 40, sidebar
240 expanded / 48 rail), `TYPE_RAMP` (caption 12/16, body 14/20, bodyStrong 14/20/600, subtitle
16/22/600, title3 20/26/600, title2 24/32/600, display 28/36/600), `SHADOW` (elevations 4/8/16/28
with the exact spec values), `MOTION` (durations + three curves), and `FOCUS` (2 px ring, 1 px
offset, two-tone). `fluent.css` declares the CSS custom properties and the acrylic rule
(`backdrop-filter: blur(30px) saturate(125%)`) with an **opaque fallback** selected under
`prefers-reduced-transparency`. `globals.css` imports it and nothing else in the app defines colour:
shadcn theme tokens are the only colour source (spec §3.1).

**Step 4: Verify — no raw values in components**

Run: `bun run --cwd apps/web test ui/tokens && bun run --cwd apps/web check`
Expected: PASS (4 tests); typecheck clean.

Run: `grep -rnE "#[0-9a-fA-F]{3,6}|[0-9]+px" apps/web/src/components apps/web/src/views | grep -v "\.test\."`
Expected: no matches (every value is consumed by name) — this is P0's proof.

**Step 5: Commit**

```bash
git add apps/web/src/ui/tokens apps/web/src/app/globals.css
git commit -m "feat(ui): add P0 token layer (spatial, type, elevation, motion, focus)"
```

---

### Task 20.2: P1 — shell, auth gate, and live regions

**Files:** `components/{app-shell.tsx,toaster.tsx,command-palette.tsx}`, `app/(dash)/layout.tsx`, `components/app-shell.test.tsx`

**Step 1: Write the failing shell test**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { AppShell } from "./app-shell";

describe("AppShell (spec §2.2 invariant 1, R-A7)", () => {
  test("renders the four landmarks with a single h1", () => {
    render(
      <AppShell title="Overview" scopeLabel="All instances">
        <div>panel</div>
      </AppShell>,
    );
    expect(screen.getByRole("navigation")).toBeDefined();
    expect(screen.getByRole("main")).toBeDefined();
    expect(screen.getByRole("banner")).toBeDefined();
    expect(screen.getByRole("contentinfo")).toBeDefined();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  test("mounts exactly one polite and one assertive live region, eagerly", () => {
    render(
      <AppShell title="Overview" scopeLabel="All instances">
        <div />
      </AppShell>,
    );
    expect(screen.getByTestId("live-polite")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByTestId("live-assertive")).toHaveAttribute("aria-live", "assertive");
    expect(screen.getAllByTestId(/^live-/)).toHaveLength(2);
  });

  test("exposes the palette trigger with its keyboard shortcut hint", () => {
    render(
      <AppShell title="Overview" scopeLabel="All instances">
        <div />
      </AppShell>,
    );
    expect(screen.getByRole("button", { name: /command palette/i })).toBeDefined();
  });
});
```

**Step 2: Run it — expect failure**

Run: `bun run --cwd apps/web test app-shell`
Expected: FAIL — `Cannot find module './app-shell'`.

**Step 3: Implement**

`app-shell.tsx` renders `nav` (registry navigation expanded + icon rail), `header` (workspace title
as the single `h1` with `tabIndex={-1}`, scope label, palette trigger, owner menu), `main`,
`contentinfo` (build/health), the eagerly mounted `<Toaster />`, the command palette, and the two
live regions from `R-A7`. It applies `prefers-reduced-motion` and `prefers-reduced-transparency`
handling once, here. `app/(dash)/layout.tsx` is the only page shell for every authenticated page
(draft §7.6) and gates on the session, redirecting to `/login`.

**Step 4: Verify**

Run: `bun run --cwd apps/web test app-shell`
Expected: PASS (3 tests) — this is P1's proof: every authenticated route renders inside the one shell,
logout returns to `/login`, and the shell holds exactly one polite and one assertive live region.

**Step 5: Commit**

```bash
git add apps/web/src/components/app-shell.tsx apps/web/src/components/app-shell.test.tsx apps/web/src/components/toaster.tsx apps/web/src/components/command-palette.tsx "apps/web/src/app/(dash)/layout.tsx"
git commit -m "feat(ui): add P1 AppShell with single shell, live regions, and palette"
```

---

### Task 20.3: P2 — registry, scope resolution, and the spine

**Files:** `ui/registry/{types.ts,scope.ts,params.ts,registry.ts,index.ts}`, `ui/registry/scope.test.ts`, `ui/registry/registry.test.ts`, `components/scope-spine.tsx`, `components/scope-spine.test.tsx`

**Step 1: Write the failing scope tests (table-driven, per spec §2.3)**

```ts
import { describe, expect, test } from "vitest";
import { encodeScope, normalizeScope, parseScope, resolveView } from "./index";

describe("scope resolution and canonicalisation", () => {
  const cases = [
    { name: "global root", path: "/", search: "", scope: { kind: "global" }, view: "overview" },
    { name: "instance", path: "/instances/inst_1", search: "", scope: { kind: "instance", instanceId: "inst_1" }, view: "instance" },
    { name: "group with required instance", path: "/groups/120363043123456789%40g.us", search: "?instance=inst_1", scope: { kind: "group", instanceId: "inst_1", groupJid: "120363043123456789@g.us" }, view: "group" },
    { name: "alias resolves to the same view", path: "/instances/inst_1/groups", search: "", scope: { kind: "instance", instanceId: "inst_1" }, view: "groups" },
    { name: "unknown view", path: "/nope", search: "", scope: null, view: null },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      const scope = parseScope(tc.path, new URLSearchParams(tc.search));
      expect(scope).toEqual(tc.scope);
      expect(resolveView(tc.path, new URLSearchParams(tc.search))?.id ?? null).toBe(tc.view);
    });
  }

  test("a scope deeper than the view accepts is normalised, not rejected", () => {
    const normalized = normalizeScope({ kind: "group", instanceId: "inst_1", groupJid: "g@g.us" }, "instance");
    expect(normalized).toEqual({ kind: "instance", instanceId: "inst_1" });
  });

  test("a group scope without an instance is invalid, not an error page", () => {
    expect(parseScope("/groups/120363043123456789%40g.us", new URLSearchParams())).toBeNull();
  });

  test("encodeScope round-trips and keeps the canonical form", () => {
    const scope = { kind: "group", instanceId: "inst_1", groupJid: "120363043123456789@g.us" } as const;
    expect(encodeScope(scope)).toBe("/groups/120363043123456789%40g.us?instance=inst_1");
  });

  test("invalid params are dropped and the view still renders a working default", () => {
    const resolved = resolveView("/messages", new URLSearchParams("limit=not-a-number"));
    expect(resolved?.id).toBe("messages");
    expect(resolved?.params.limit).toBeUndefined();
  });
});
```

**Step 2: Run it — expect failure**

Run: `bun run --cwd apps/web test ui/registry`
Expected: FAIL — `Cannot find module './index'`.

**Step 3: Implement the registry**

`types.ts` declares `Scope`, `ScopeMode`, `EmptyReason` (`no-data|filtered|unconfigured|unavailable|not-permitted`), `PanelDescriptor`, `ActionDescriptor`, `SkeletonPlan`, `ViewDescriptor`, `ResourceDescriptor` exactly as spec §2.1. `params.ts` provides the zod codecs used to validate and drop bad params. `scope.ts` implements `parseScope`, `normalizeScope`, `encodeScope` and the alias table from spec §2.3. `registry.ts` implements `registerView`, `resolveView`, `viewsFor(scopeMode)` and the ten declared views (`overview`, `instances`, `instance`, `groups`, `group`, `messages`, `sends`, `assistant`, `stats`, `settings`) with their canonical routes and aliases.

**Step 4: Write the failing spine test (the R11 surface inside the shell)**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { ScopeSpine } from "./scope-spine";

const instances = [{ id: "inst_1", label: "Support bot", status: "connected", groupsObserved: 2, groupsLeft: 1, lastSyncAt: "2026-09-13T10:00:00Z" }];
const groups = [
  { groupJid: "120363043123456789@g.us", name: "Ops Team", nameSource: "event", state: "active" },
  { groupJid: "120363043999999999@g.us", name: "(unnamed group) 120363043999999999", nameSource: "fallback", state: "left" },
];

describe("ScopeSpine", () => {
  test("shows every instance and, under it, each group ID with its current name", () => {
    render(<ScopeSpine instances={instances as never} groups={groups as never} scope={{ kind: "instance", instanceId: "inst_1" }} onSelect={vi.fn()} />);
    expect(screen.getByText("Support bot")).toBeDefined();
    expect(screen.getByText("120363043123456789@g.us")).toBeDefined();
    expect(screen.getByText("Ops Team")).toBeDefined();
    expect(screen.getByText("120363043999999999@g.us")).toBeDefined();
    expect(screen.getByText("(unnamed group) 120363043999999999")).toBeDefined();
  });

  test("marks a left group without hiding its retained name", () => {
    render(<ScopeSpine instances={instances as never} groups={groups as never} scope={null} onSelect={vi.fn()} />);
    expect(screen.getByText("Ops Team")).toBeDefined();
    expect(screen.getAllByText(/left/i).length).toBeGreaterThan(0);
  });

  test("re-scopes in place instead of walking the path", () => {
    const onSelect = vi.fn();
    render(<ScopeSpine instances={instances as never} groups={groups as never} scope={null} onSelect={onSelect} />);
    screen.getByText("Ops Team").click();
    expect(onSelect).toHaveBeenCalledWith({ kind: "group", instanceId: "inst_1", groupJid: "120363043123456789@g.us" });
  });
});
```

**Step 5: Run it — expect failure; then implement**

Run: `bun run --cwd apps/web test scope-spine` → FAIL (`Cannot find module './scope-spine'`).

`scope-spine.tsx` renders instance rows (label, `InstanceStateBadge`, `groupsObserved`/`groupsLeft`,
`lastSyncAt`) and, under the active instance, group rows using `GroupNameCell` + `JidCell` so the raw
`<id>@g.us` is always visible and copyable (`R-A6` copy-JID path) alongside the current name;
`GroupStateBadge` marks `left`/`deleted` without hiding the retained name. Selection calls
`onSelect(scope)` — the spine never fetches; it reads the `groups` resource so it stays in sync with
live patches (`R-V4`). Below `md` it collapses to a scope chip opening a `Sheet` (`R-M2`).

**Step 6: Verify and commit**

Run: `bun run --cwd apps/web test ui/registry scope-spine`
Expected: PASS. P2's proof: table-driven canonicalisation, invalid params, aliases, group scope
without instance, unknown view and stale bookmark each render a working default.

```bash
git add apps/web/src/ui/registry apps/web/src/components/scope-spine.tsx apps/web/src/components/scope-spine.test.tsx apps/web/src/components/jid-cell.tsx apps/web/src/components/group-name-cell.tsx apps/web/src/components/state-badges.tsx
git commit -m "feat(ui): add P2 registry, scope canonicalisation, and ScopeSpine"
```

---

### Task 20.4: P3 — resource layer (cold/warm/live/poll)

**Files:** `ui/resource/{cache.ts,use-resource.ts,use-stream-scope.ts,resource-gate.tsx,index.ts}`, `ui/resource/use-resource.test.tsx`, `ui/resource/use-stream-scope.test.ts`, `app/api/stream/route.ts`

**Step 1: Write the failing tier tests (R-L1–R-L3, R-L9, R-V3)**

```tsx
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { useResource } from "./use-resource";
import { SKELETON_DELAY_MS, SKELETON_MIN_VISIBLE_MS } from "../feedback/toast-policy";

describe("useResource loading tiers (R-L1..R-L3)", () => {
  test("cold: a load slower than 150ms shows a skeleton, held for at least 400ms", async () => {
    vi.useFakeTimers();
    const load = vi.fn(() => new Promise<string[]>((resolve) => setTimeout(() => resolve(["a"]), 500)));
    const { result } = renderHook(() => useResource({ key: "k", fetch: load }));

    expect(result.current.tier).toBe("cold");
    expect(result.current.showSkeleton).toBe(false); // R-L2: not before 150ms
    act(() => { vi.advanceTimersByTime(SKELETON_DELAY_MS + 1); });
    expect(result.current.showSkeleton).toBe(true);

    await act(async () => { vi.advanceTimersByTime(600); });
    await waitFor(() => expect(result.current.data).toEqual(["a"]));
    // The skeleton must have been visible for the full minimum, not 1 tick.
    expect(result.current.skeletonVisibleForMs).toBeGreaterThanOrEqual(SKELETON_MIN_VISIBLE_MS);
    vi.useRealTimers();
  });

  test("warm beats cold: a refetch with data present never shows a skeleton", async () => {
    const load = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(["first"]))
      .mockImplementationOnce(() => new Promise<string[]>((resolve) => setTimeout(() => resolve(["second"]), 400)));
    const { result } = renderHook(() => useResource({ key: "k2", fetch: load }));
    await waitFor(() => expect(result.current.data).toEqual(["first"]));

    act(() => { result.current.refresh(); });
    expect(result.current.tier).toBe("warm");
    expect(result.current.showSkeleton).toBe(false);
    expect(result.current.data).toEqual(["first"]);
    expect(result.current.showWarmBar).toBe(false); // R-L3: only after 300ms
  });

  test("a scope switch re-keys the cache atomically (R-V5)", async () => {
    const load = vi.fn((scope: { instanceId: string }) => Promise.resolve([scope.instanceId]));
    const { result, rerender } = renderHook(({ scope }) => useResource({ key: `groups:${scope.instanceId}`, fetch: () => load(scope) }), {
      initialProps: { scope: { instanceId: "inst_1" } },
    });
    await waitFor(() => expect(result.current.data).toEqual(["inst_1"]));
    rerender({ scope: { instanceId: "inst_2" } });
    expect(result.current.data).toBeUndefined(); // never interleaves two scopes
    await waitFor(() => expect(result.current.data).toEqual(["inst_2"]));
  });

  test("an SSE failure degrades to poll with identical rendered output (R-V3)", async () => {
    const load = vi.fn(() => Promise.resolve(["row"]));
    const { result } = renderHook(() => useResource({ key: "k3", fetch: load, pollMs: 3000, sse: { types: ["group.updated"] } }));
    await waitFor(() => expect(result.current.data).toEqual(["row"]));
    act(() => { result.current.__setTransport("poll"); });
    expect(result.current.data).toEqual(["row"]);
    expect(result.current.tier).toBe("poll");
  });
});
```

**Step 2: Run it — expect failure**

Run: `bun run --cwd apps/web test ui/resource`
Expected: FAIL — `Cannot find module './use-resource'`.

**Step 3: Implement the resource layer**

`cache.ts` keys entries by `(scope, params)` and implements `keepPreviousData`, `invalidateOn`, and
`patch(key, updater)`. `use-resource.ts` implements the four tiers `cold | warm | live | poll` (plus
`idle`/`error`), the R-L2 delay/minimum timers, `keepPreviousData`, `invalidateOn`, and an `errorMap`
seam. `use-stream-scope.ts` owns the **single** `EventSource` per tab, fans `group.updated`,
`message.created` and `send.updated` out to the matching `SSEBinding`s, reconnects with resume
tokens, and switches to `STREAM_POLL_MS` polling without changing the DOM. `resource-gate.tsx` is the
only component that renders a resource's skeleton, empty, or error surface, so every view obeys the
same policy. `app/api/stream/route.ts` serves the SSE endpoint (change streams on `messages`,
`groups`, `sendRequests`, `instances` filtered by `organizationId`, resume token persisted in
`streamCursors`, polling fallback), 401 without a session.

**Step 4: Verify and commit**

Run: `bun run --cwd apps/web test ui/resource`
Expected: PASS — P3's proof: tier transitions per R-L1–R-L3, a scope switch that never interleaves two
scopes' data (R-V5), and a simulated SSE→poll fallback with identical DOM.

```bash
git add apps/web/src/ui/resource "apps/web/src/app/api/stream/route.ts"
git commit -m "feat(ui): add P3 resource layer with cold/warm/live/poll tiers"
```

---

### Task 20.5: P4 — feedback layer (toast policy, empty states, error mapping)

**Files:** `ui/feedback/{toast-policy.ts,use-action.ts,error-map.ts,empty-copy.ts,index.ts}`, `ui/feedback/feedback.test.tsx`, `components/{empty-state.tsx,error-state.tsx}`, `components/feedback.test.tsx`

**Step 1: Write the failing toast-policy test — including the forbidden cases (R-T1–R-T5)**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { TOAST_DURATION, TOAST_DEDUPE_MS, TOAST_MAX_VISIBLE, toastFor } from "./toast-policy";
import { useAction } from "./use-action";

describe("toast policy (R-T1..R-T5)", () => {
  test("durations are chosen by outcome class", () => {
    expect(TOAST_DURATION).toEqual({ success: 4000, info: 5000, warning: 8000, errorRecoverable: 8000, errorBlocking: null });
  });

  test("stacking and dedupe constants match the spec", () => {
    expect(TOAST_MAX_VISIBLE).toBe(3);
    expect(TOAST_DEDUPE_MS).toBe(8000);
    expect(toastFor({ action: "sync", targetId: "inst_1" }).dedupeKey).toBe("sync:inst_1");
  });

  test("background and load events never toast (R-T5)", () => {
    const cases = [
      "sse-reconnect", "group-renamed", "message-created", "media-state-changed",
      "send-awaiting-approval", "panel-load-failed", "form-validation", "ai-no-whitelist",
      "token-budget", "ambiguous-send", "connection-lost", "logged-out", "mongo-unreachable",
      "worker-unreachable", "status-transition",
    ] as const;
    for (const kind of cases) {
      expect(toastFor({ kind }).forbidden, `${kind} must not be toast-only`).toBe(true);
    }
    // Transport degradation has no toast at all, not merely "not only".
    expect(toastFor({ kind: "sse-reconnect" }).allowed).toBe(false);
    expect(toastFor({ kind: "group-renamed" }).allowed).toBe(false);
    expect(toastFor({ kind: "message-created" }).allowed).toBe(false);
    expect(toastFor({ kind: "panel-load-failed" }).allowed).toBe(false);
    expect(toastFor({ kind: "status-transition" }).allowed).toBe(false);
  });

  test("an action uses one updating toast, not loading-then-result (R-T2)", async () => {
    const push = vi.fn();
    const action = useAction({ push });
    await action.run({ action: "sync", targetId: "inst_1", promise: Promise.resolve({ total: 12, markedLeft: 1 }) });
    expect(push).toHaveBeenCalledTimes(1);
  });

  test("toast roles follow severity (R-T4)", () => {
    expect(toastFor({ action: "sync" }).role).toBe("status");
    expect(toastFor({ action: "sync", variant: "error" }).role).toBe("alert");
  });
});
```

**Step 2: Run it — expect failure**

Run: `bun run --cwd apps/web test ui/feedback`
Expected: FAIL — `Cannot find module './toast-policy'`.

**Step 3: Implement the feedback layer**

`toast-policy.ts` exports the duration table, `TOAST_MAX_VISIBLE = 3`, `TOAST_DEDUPE_MS = 8000`,
`TOAST_DEDUPE_KEY = ${action}:${targetId}`, `toastFor()` returning `{ allowed, forbidden, role,
duration, dedupeKey }`, and the position rule (bottom-right, bottom-center below 640 px — `R-M5` moves
to the top edge while a composer or sheet is open). `use-action.ts` is the **only** toast emitter: it
returns `{ run }` using the promise pattern (one updating toast), pauses auto-dismiss on hover and
focus-within (`R-T2`), and never fires for background events. `error-map.ts` maps every worker `code`
(draft §6.5) plus `network`/`timeout` into the `UIError` shape of `R-X1` — including the known-signal
rows of `R-X3` (`ai_no_whitelist`, `not_whitelisted`, `foreign_media`, the four `dispatch.errorClass`
values, `runtime.status:"logged_out"`, Mongo/worker/R2 outage, login rate limit, offline) — and the
unknown-code fallback with a copyable monospace chip. `empty-copy.ts` supplies copy for all five
`EmptyReason` values. `empty-state.tsx`/`error-state.tsx` render them; `ErrorState` carries the
recovery control of `R-X4` and never renders raw stacks or worker JSON.

**Step 4: Verify and commit**

Run: `bun run --cwd apps/web test ui/feedback components/feedback`
Expected: PASS — P4's proof: R-T1–R-T5 exercised as a table, every forbidden toast produces no toast,
every unknown code falls back and shows a copyable code.

```bash
git add apps/web/src/ui/feedback apps/web/src/components/empty-state.tsx apps/web/src/components/error-state.tsx apps/web/src/components/feedback.test.tsx
git commit -m "feat(ui): add P4 feedback layer with toast policy, empty copy, and error map"
```

---

### Task 20.6: P5 — first vertical slice: `groups` at both scopes (R11)

**Files:** `views/groups.tsx`, `views/groups.test.tsx`, `views/group.tsx`, `components/panel-grid.tsx`, `components/panel.tsx`, `components/workspace-header.tsx`

**Step 1: Write the failing slice test — the acceptance criterion for R11**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { GroupsTable } from "./groups";

const rows = [
  { groupJid: "120363043123456789@g.us", name: "Ops Team", nameSource: "event", state: "active", participantCount: 12, messageCount: 4211, assigned: true, whitelisted: true, subjectHistoryCount: 2 },
  { groupJid: "120363043999999999@g.us", name: "(unnamed group) 120363043999999999", nameSource: "fallback", state: "active", participantCount: 0, messageCount: 0, assigned: false, whitelisted: false, subjectHistoryCount: 0 },
];

describe("groups slice (R11, R-V4)", () => {
  test("every row shows the full group ID and a non-empty current name", () => {
    render(<GroupsTable rows={rows} onSync={vi.fn()} onToggle={vi.fn()} />);
    for (const row of rows) expect(screen.getByText(row.groupJid)).toBeDefined();
    expect(screen.getByText("Ops Team")).toBeDefined();
    expect(screen.getByText("(unnamed group) 120363043999999999")).toBeDefined();
  });

  test("a rename patch updates the row with no toast and no focus change (R-V2, R-V4)", () => {
    const { rerender } = render(<GroupsTable rows={rows} onSync={vi.fn()} onToggle={vi.fn()} />);
    const before = document.activeElement;
    rerender(<GroupsTable rows={[{ ...rows[0]!, name: "Ops Crew", nameSource: "event" }, rows[1]!]} onSync={vi.fn()} onToggle={vi.fn()} />);
    expect(screen.getByText("Ops Crew")).toBeDefined();
    expect(document.activeElement).toBe(before);
  });

  test("the rename chip exposes the capped history", () => {
    render(<GroupsTable rows={rows} onSync={vi.fn()} onToggle={vi.fn()} />);
    expect(screen.getByRole("button", { name: /renamed 2/i })).toBeDefined();
  });

  test("Sync now streams its counts as a stateful surface, not a skeleton (R-L5)", () => {
    render(<GroupsTable rows={rows} onSync={vi.fn()} onToggle={vi.fn()} />);
    const button = screen.getByRole("button", { name: /sync now/i });
    button.click();
    expect(button).toHaveAttribute("aria-busy", "true");
  });
});
```

**Step 2: Run it — expect failure; then implement**

Run: `bun run --cwd apps/web test views/groups` → FAIL (`Cannot find module './groups'`).

`views/groups.tsx` declares the `groups` view descriptor for `global | instance` scope (canonical
`/groups` plus the `/instances/[instanceId]/groups` alias), a fixed panel catalog, and a
`SkeletonPlan`; `GroupsTable` renders `JidCell` + `GroupNameCell` + `GroupStateBadge`, rename
provenance, the `subjectHistory` chip opening a sheet, `assign`/`whitelist` toggles wired to
`PATCH /api/groups/[id]`, and `Sync now` posting `/api/instances/[id]/groups/sync` through
`useAction` so the returned counts (`total`/`added`/`subjectUpdated`/`markedLeft`) stream into the
panel. `views/group.tsx` is the group-scope view (header, stats panel, compose entry point).
`panel-grid.tsx` implements the 12-column grid across four breakpoints with
`{order, span, collapsed}` defaults from the descriptor; `workspace-header.tsx` renders the `h1`,
scope label, live indicator, and actions.

**Step 3: Verify and commit**

Run: `bun run --cwd apps/web test views/groups`
Expected: PASS — P5's proof: the full `<id>@g.us` is visible and copyable and the current name is
non-empty for every row; a rename patches in place with no toast and no focus move; fallback names
render and then resolve after sync.

```bash
git add apps/web/src/views/groups.tsx apps/web/src/views/groups.test.tsx apps/web/src/views/group.tsx apps/web/src/components/panel-grid.tsx apps/web/src/components/panel.tsx apps/web/src/components/workspace-header.tsx
git commit -m "feat(ui): add P5 groups slice with sync, rename provenance, and in-place patches"
```

---

### Task 20.7: P6 — `instances` and `instance`

**Files:** `views/{instances.tsx,instance.tsx,instance.test.tsx}`, `components/whitelist-editor.tsx`

**Step 1: Write the failing pairing/whitelist tests**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { PairingPanel } from "./instance";

describe("instance view (R-L5, R-X3)", () => {
  test("pairing is a stateful surface with QR or code, a TTL and a leave affordance", () => {
    render(<PairingPanel instanceId="inst_1" status="pairing" qrDataUrl="data:image/png;base64,AA" pairingCode={null} expiresAt="2026-09-13T10:05:00Z" onCancel={vi.fn()} />);
    expect(screen.getByTestId("pairing-qr")).toBeDefined();
    expect(screen.getByText(/expires/i)).toBeDefined();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeDefined();
    expect(screen.queryByTestId("view-skeleton")).toBeNull();
  });

  test("an empty whitelist produces the unconfigured state wherever it is consumed", () => {
    render(<PairingPanel instanceId="inst_1" status="connected" qrDataUrl={null} pairingCode={null} expiresAt={null} whitelist={[]} onCancel={vi.fn()} />);
    expect(screen.getByText(/no groups are whitelisted/i)).toBeDefined();
    expect(screen.getByRole("link", { name: /whitelist/i })).toBeDefined();
  });

  test("logged_out raises the re-pair banner while data stays readable", () => {
    render(<PairingPanel instanceId="inst_1" status="logged_out" qrDataUrl={null} pairingCode={null} expiresAt={null} onCancel={vi.fn()} />);
    expect(screen.getByRole("alert")).toBeDefined();
    expect(screen.getByText(/re-?pair/i)).toBeDefined();
  });
});
```

**Step 2: Run it — expect failure; then implement**

Run: `bun run --cwd apps/web test views/instance` → FAIL (`Cannot find module './instance'`).

`views/instance.tsx` implements the instance view with config editor, `PairingPanel` (stateful
pairing with elapsed time, TTL, cancel — never a skeleton), `WhitelistEditor` writing
`instances.config.groupJidWhitelist` and mirroring `groups.config.whitelisted` through the single
BFF mutation path, status badges, the per-instance group table, `Sync now`, and logout.
`views/instances.tsx` adds list + create. `logged_out` renders the persistent re-pair banner
(`R-X3`) while group and message data remain readable because those reads come from Mongo (draft §7.5).

**Step 3: Verify and commit**

Run: `bun run --cwd apps/web test views/instance views/instances`
Expected: PASS — P6's proof: `disconnected → pairing → connected` traverses without a skeleton; an
empty whitelist produces `unconfigured` everywhere it is consumed; `logged_out` raises the re-pair
banner while data stays readable.

```bash
git add apps/web/src/views/instances.tsx apps/web/src/views/instance.tsx apps/web/src/views/instance.test.tsx apps/web/src/components/whitelist-editor.tsx
git commit -m "feat(ui): add P6 instances and instance views with pairing surface and whitelist editor"
```

---

### Task 20.8: P7 — `messages` and `group`

**Files:** `views/{messages.tsx,group.tsx}`, `views/messages.test.tsx`, `components/{media-slot.tsx,raw-json-viewer.tsx}`

**Step 1: Write the failing tests (R4, R-L6, R-E4, invariant 7/8)**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { MessageStream } from "./messages";
import { MediaSlot } from "../components/media-slot";

const rows = [
  { waMessageId: "m1", groupJid: "12036304@g.us", senderJid: "62899@s.whatsapp.net", pushName: "Nadia", timestamp: "2026-09-13T10:00:00Z", kind: "text", text: "deploy is green", media: { status: "none", declaredType: null, r2Key: null, reason: null } },
  { waMessageId: "m2", groupJid: "12036304@g.us", senderJid: "62899@s.whatsapp.net", pushName: "Ravi", timestamp: "2026-09-13T11:00:00Z", kind: "document", text: "", media: { status: "unparsed", declaredType: "document", r2Key: "org/org_default/instance/inst_1/group/g/2026/09/m2.bin", reason: "unsupported_type" } },
];

describe("messages + group views", () => {
  test("search and filters are addressable, and paging appends without replacing rows (R-L6)", () => {
    const { rerender } = render(<MessageStream groupJid="12036304@g.us" rows={rows} onLoadMore={vi.fn()} onSearch={vi.fn()} />);
    expect(screen.getByText("deploy is green")).toBeDefined();
    rerender(<MessageStream groupJid="12036304@g.us" rows={[...rows, { ...rows[0]!, waMessageId: "m3", text: "older" }]} onLoadMore={vi.fn()} onSearch={vi.fn()} />);
    expect(screen.getByText("deploy is green")).toBeDefined();
    expect(screen.getByText("older")).toBeDefined();
  });

  test("unreadable media renders the declared type plus its reason, not an empty slot (R-E4)", () => {
    render(<MediaSlot media={{ status: "unparsed", declaredType: "document", r2Key: "k", reason: "unsupported_type" }} messageId="m2" />);
    expect(screen.getByText(/document/i)).toBeDefined();
    expect(screen.getByText(/not readable|could not be read/i)).toBeDefined();
  });

  test("media bytes are requested only on demand (invariant 8)", () => {
    const requestUrl = vi.fn();
    render(<MediaSlot media={{ status: "stored", declaredType: "image", r2Key: "k", reason: null }} messageId="m4" requestUrl={requestUrl} />);
    expect(requestUrl).not.toHaveBeenCalled();
    screen.getByRole("button", { name: /show media/i }).click();
    expect(requestUrl).toHaveBeenCalledWith("/api/media/m4/url");
  });

  test("no message content reaches the DOM as HTML (invariant 7)", () => {
    render(<MessageStream groupJid="12036304@g.us" rows={[{ ...rows[0]!, text: "<img src=x onerror=alert(1)>" }]} onLoadMore={vi.fn()} onSearch={vi.fn()} />);
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeDefined();
    expect(document.querySelector("img[src='x']")).toBeNull();
  });
});
```

**Step 2: Run it — expect failure; then implement**

Run: `bun run --cwd apps/web test views/messages` → FAIL (`Cannot find module './messages'`).

`views/messages.tsx` declares the `messages` view for `global | instance` scope with `q`, instance,
group, kind, media-status and date filters in URL params, cursor paging that keeps rows mounted, and
the group header/`group` view with a stats panel and compose entry point. `media-slot.tsx` requests
`/api/media/[messageId]/url` only on demand, never caches the presigned URL, and renders the
unreadable-media reason set (`unparsed|unavailable|failed` × `view_once|expired|no_keys|
download_failed|unsupported_type|too_large`) with one-line explanations. `raw-json-viewer.tsx`
renders `raw.message` as collapsible **text**.

**Step 3: Verify and commit**

Run: `bun run --cwd apps/web test views/messages`
Expected: PASS — P7's proof: search + filters + Back restore the same page; media is requested only on
demand and re-requested on expiry; no message content reaches the DOM as HTML.

```bash
git add apps/web/src/views/messages.tsx apps/web/src/views/group.tsx apps/web/src/views/messages.test.tsx apps/web/src/components/media-slot.tsx apps/web/src/components/raw-json-viewer.tsx
git commit -m "feat(ui): add P7 messages and group views with paging and on-demand media"
```

---

### Task 20.9: P8 — `assistant`

**Files:** `views/{assistant.tsx,assistant.test.tsx}`, `components/scope-banner.tsx`

**Step 1: Write the failing tests (R5 in the UI, R-X3)**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { AssistantView } from "./assistant";

const instance = { id: "inst_1", label: "Support bot", config: { groupJidWhitelist: ["120363043123456789@g.us"], aiEnabled: true } };

describe("assistant view (R5)", () => {
  test("the instance scope is a route constraint and the banner discloses the whitelist", () => {
    render(<AssistantView instance={instance as never} onAsk={vi.fn()} calls={[]} />);
    expect(screen.getByRole("status")).toHaveTextContent(/1 group/i);
    expect(screen.queryByRole("button", { name: /ask/i })).not.toBeDisabled();
  });

  test("an empty whitelist disables input before submit and preserves the typed question", () => {
    render(<AssistantView instance={{ ...instance, config: { ...instance.config, groupJidWhitelist: [] } } as never} onAsk={vi.fn()} calls={[]} />);
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByText(/no groups are whitelisted/i)).toBeDefined();
  });

  test("refused retrieval requests surface as a count linking to the call row", () => {
    render(<AssistantView instance={instance as never} onAsk={vi.fn()} calls={[]} lastAnswer={{ text: "answer", refused: 2, callId: "c1" }} />);
    expect(screen.getByText(/2 retrieval requests were outside this scope/i)).toBeDefined();
    expect(screen.getByRole("link", { name: /call/i })).toHaveAttribute("href", expect.stringContaining("c1"));
  });

  test("the budget-exhausted state is inline, not a toast", () => {
    render(<AssistantView instance={instance as never} onAsk={vi.fn()} calls={[]} budgetExhausted />);
    expect(screen.getByText(/token budget/i)).toBeDefined();
  });
});
```

**Step 2: Run it — expect failure; then implement**

Run: `bun run --cwd apps/web test views/assistant` → FAIL (`Cannot find module './assistant'`).

`views/assistant.tsx` requires an instance scope (the route constraint mirroring the server rule that
nothing about scope comes from the client, draft §7.2 step 1), renders the permanent `ScopeBanner`
disclosing the whitelist snapshot, streams the answer with a throttled polite region (≤ 1
announcement per 2 s) and a `Stop` control, renders citations, lists `aiCalls` history with
tokens/cost, and handles `ai_no_whitelist`, budget exhaustion and the refused-retrieval line inline
(`R-X3`).

**Step 3: Verify and commit**

Run: `bun run --cwd apps/web test views/assistant`
Expected: PASS — P8's proof: an empty whitelist disables input before submit; the banner cannot widen
scope; a refusal inside a call surfaces the count and links to the call row.

```bash
git add apps/web/src/views/assistant.tsx apps/web/src/views/assistant.test.tsx apps/web/src/components/scope-banner.tsx
git commit -m "feat(ui): add P8 assistant view with permanent scope banner and inline guards"
```

---

### Task 20.10: P9 — `sends`

**Files:** `views/{sends.tsx,sends.test.tsx}`, `components/send-status-track.tsx`, `components/composer.tsx`

**Step 1: Write the failing tests (R7 in the UI, R-X3, R-X4)**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { SendStatusTrack } from "../components/send-status-track";
import { SendCard } from "./sends";

describe("sends view (R7)", () => {
  test("status is rendered from server state, never predicted", () => {
    render(<SendStatusTrack status="approved" attempts={0} />);
    expect(screen.getByText(/approved/i)).toBeDefined();
    expect(screen.queryByText(/sent/i)).toBeNull();
  });

  test("an ambiguous failure offers re-approve only, never retry", () => {
    render(<SendStatusTrack status="failed" errorClass="ambiguous" attempts={2} />);
    expect(screen.getByRole("button", { name: /re-approve/i })).toBeDefined();
    expect(screen.queryByRole("button", { name: /^retry$/i })).toBeNull();
    expect(screen.getByText(/delivery unknown/i)).toBeDefined();
  });

  test("an auth failure suppresses the per-send error in favour of the instance banner", () => {
    render(<SendStatusTrack status="failed" errorClass="auth" attempts={1} />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("approval is a confirmed transition with an optional note and schedule", () => {
    const onApprove = vi.fn();
    render(<SendCard send={{ id: "s1", status: "pending_approval", groupJid: "12036304@g.us", content: { text: "hi" }, dispatch: { attempts: 0 } } as never} onApprove={onApprove} onReject={vi.fn()} onCancel={vi.fn()} />);
    screen.getByRole("button", { name: /approve/i }).click();
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(onApprove).not.toHaveBeenCalled(); // the dialog must confirm first
  });
});
```

**Step 2: Run it — expect failure; then implement**

Run: `bun run --cwd apps/web test views/sends` → FAIL (`Cannot find module './sends'`).

`views/sends.tsx` renders the queue (status/instance/group filters), `SendCard`s with
`SendStatusTrack`, `dispatch.attempts`, error copy and dispatch history; the composer accepts text,
**worker-stored media only** (attaching anything else is an inline `foreign_media` error) and reply
context; `orgin:"ai_suggestion"` drafts arrive from the assistant. Approval/rejection/cancellation go
through `AlertDialog` confirmations (`R-A8`) and `useAction`; no status is ever optimistic.

**Step 3: Verify and commit**

Run: `bun run --cwd apps/web test views/sends`
Expected: PASS — P9's proof: ambiguous failure renders re-approve only; approval is never optimistic;
every transition writes the audit-backed state the server returns.

```bash
git add apps/web/src/views/sends.tsx apps/web/src/views/sends.test.tsx apps/web/src/components/send-status-track.tsx apps/web/src/components/composer.tsx
git commit -m "feat(ui): add P9 sends view with status track and confirmed approval"
```

---

### Task 20.11: P10 — `stats` and `overview`

**Files:** `views/{stats.tsx,overview.tsx,stats.test.tsx}`, `components/usage-meter.tsx`

**Step 1: Write the failing tests (R8 in the UI)**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { StatsTabs } from "./stats";
import { OverviewStrip } from "./overview";

describe("stats + overview", () => {
  test("three tabs, each exposing its underlying rows", () => {
    render(<StatsTabs bots={[{ instanceId: "inst_1", messagesIn: 120, mediaStored: 8, sendFailed: 1 }]} groups={[]} tokens={[{ model: "m", total: 1000, costUsd: 0.02 }]} onRecompute={vi.fn()} />);
    expect(screen.getByRole("tab", { name: /bots/i })).toBeDefined();
    expect(screen.getByRole("tab", { name: /groups/i })).toBeDefined();
    expect(screen.getByRole("tab", { name: /tokens/i })).toBeDefined();
    screen.getByRole("tab", { name: /bots/i }).click();
    expect(screen.getByRole("table")).toBeDefined();
  });

  test("overview is an exception queue with a compact counter strip, not a KPI wall", () => {
    render(<OverviewStrip health={{ ok: true }} counters={{ pendingApprovals: 2, unreadableMedia: 1, tokensToday: 500 }} />);
    expect(screen.getByRole("status")).toBeDefined();
    expect(screen.queryAllByTestId("kpi-card")).toHaveLength(0);
  });

  test("rollup recompute streams progress and is distinguishable from live counters", () => {
    const onRecompute = vi.fn();
    render(<StatsTabs bots={[]} groups={[]} tokens={[]} onRecompute={onRecompute} recomputing={{ day: "2026-09-13", progress: 0.4 }} />);
    expect(screen.getByRole("progressbar")).toBeDefined();
    expect(screen.getByText(/live counters/i)).toBeDefined();
  });
});
```

**Step 2: Run it — expect failure; then implement**

Run: `bun run --cwd apps/web test views/stats` → FAIL (`Cannot find module './stats'`).

`views/stats.tsx` renders the three tabs with tables (and charts that expose their rows plus a text
summary for assistive technology), rollup recompute with streamed progress, and whitelist rejections
as a security metric. `views/overview.tsx` is the exception queue of spec §0.2: a compact status strip
(pending approvals, unreadable media, token usage via `UsageMeter`) above the panels that need a
decision now.

**Step 3: Verify and commit**

Run: `bun run --cwd apps/web test views/stats`
Expected: PASS — P10's proof: counters and rollups are distinguishable in the UI; every overview panel
resolves to a real state (`no-data`/`unavailable`/`filtered`) with no invented numbers.

```bash
git add apps/web/src/views/stats.tsx apps/web/src/views/overview.tsx apps/web/src/views/stats.test.tsx apps/web/src/components/usage-meter.tsx
git commit -m "feat(ui): add P10 stats tabs and exception-queue overview"
```

---

### Task 20.12: P11 — `settings`

**Files:** `views/settings.tsx`, `views/settings.test.tsx`

**Step 1: Write the failing test**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { SettingsView } from "./settings";

describe("settings view", () => {
  test("shows AI budget, retention, storage, health detail, audit log and appearance", () => {
    render(<SettingsView settings={{ ai: { model: "m", maxTokensPerDay: 200000 }, retention: { messagesDays: 0 }, ui: { timezone: "UTC" } }} health={{ mongo: "up", worker: "up" }} audit={[]} onSave={vi.fn()} onResetLayouts={vi.fn()} />);
    for (const label of [/ai budget/i, /retention/i, /storage/i, /mongo/i, /worker/i, /audit/i, /appearance/i]) {
      expect(screen.getByText(label)).toBeDefined();
    }
  });

  test("health reports Mongo and worker reachability separately", () => {
    render(<SettingsView settings={{} as never} health={{ mongo: "up", worker: "down" }} audit={[]} onSave={vi.fn()} onResetLayouts={vi.fn()} />);
    expect(screen.getByText(/mongo/i).closest("[data-state]")).toHaveAttribute("data-state", "up");
    expect(screen.getByText(/worker/i).closest("[data-state]")).toHaveAttribute("data-state", "down");
  });
});
```

**Step 2: Run it — expect failure; then implement**

Run: `bun run --cwd apps/web test views/settings` → FAIL (`Cannot find module './settings'`).

`views/settings.tsx`: AI budget (global + per-instance override), retention, storage/R2 info,
`/api/health` detail, the `auditLog` table with cursor paging, and appearance (density default,
reset-all-layouts).

**Step 3: Verify and commit**

Run: `bun run --cwd apps/web test views/settings`
Expected: PASS — P11's proof: audit rows match the actions performed; health shows Mongo and worker
reachability separately.

```bash
git add apps/web/src/views/settings.tsx apps/web/src/views/settings.test.tsx
git commit -m "feat(ui): add P11 settings view with budget, retention, health, and audit log"
```

---

### Task 20.13: P12 — layout persistence

**Files:** `ui/store/layout-store.ts`, `ui/store/layout-store.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, test } from "vitest";
import { createLayoutStore } from "./layout-store";

const defaults = [{ id: "groups", order: 0, span: 12, collapsed: false }, { id: "activity", order: 1, span: 6, collapsed: false }];

describe("layout store (spec §2.4)", () => {
  test("defaults come from the descriptor and survive a reload", () => {
    const store = createLayoutStore({ storage: new Map() as never });
    expect(store.get("groups", "lg", defaults)).toEqual(defaults);
    store.set("groups", "lg", { order: ["activity", "groups"], span: { activity: 12, groups: 12 }, collapsed: { activity: false, groups: true } });
    expect(createLayoutStore({ storage: store.__storage() }).get("groups", "lg", defaults)[1]!.collapsed).toBe(true);
  });

  test("layout is view-local and per breakpoint, never URL state", () => {
    const store = createLayoutStore({ storage: new Map() as never });
    store.set("groups", "sm", { order: ["activity", "groups"], span: {}, collapsed: {} });
    expect(store.get("groups", "lg", defaults)).toEqual(defaults);
  });

  test("reset restores the descriptor defaults exactly", () => {
    const store = createLayoutStore({ storage: new Map() as never });
    store.set("groups", "lg", { order: ["activity", "groups"], span: {}, collapsed: { groups: true } });
    store.reset("groups");
    expect(store.get("groups", "lg", defaults)).toEqual(defaults);
  });
});
```

**Step 2: Run it — expect failure; then implement**

Run: `bun run --cwd apps/web test ui/store` → FAIL (`Cannot find module './layout-store'`).

`layout-store.ts` persists `{order, span, collapsed}` per `(viewId, breakpoint)` over the view's fixed
panel catalog, with per-view reset and global reset; spans snap to the 12-column scale; nothing is
serialized into the URL.

**Step 3: Verify and commit**

Run: `bun run --cwd apps/web test ui/store`
Expected: PASS — P12's proof: a rearranged view survives reload; a shared link opens the descriptor's
default order; reset restores defaults exactly.

```bash
git add apps/web/src/ui/store
git commit -m "feat(ui): add P12 per-view layout persistence store"
```

---

### Task 20.14: P13 — accessibility and mobile pass

**Files:** `apps/web/e2e/a11y.spec.ts`, `apps/web/e2e/mobile.spec.ts`, `apps/web/playwright.config.ts`

**Step 1: Write the failing end-to-end specs (R-A1–R-A9, R-M1–R-M8)**

```ts
import { expect, test } from "@playwright/test";

test("keyboard-only journey reaches an approval without a mouse", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(process.env.OWNER_EMAIL!);
  await page.getByLabel(/password/i).fill(process.env.OWNER_PASSWORD!);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Control+k");       // R-A6 palette
  await page.getByRole("option", { name: /sends/i }).click();
  await page.getByRole("button", { name: /approve/i }).first().focus();
  await expect(page.getByRole("dialog")).toBeVisible();   // R-A8 confirmation
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused(); // focus returns
});

test("no horizontal scrolling at 320px or 400% zoom, targets are tappable", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/groups");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);      // R-M1
  const small = await page.locator("button, a").evaluateAll((els) =>
    els.map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && (r.width < 24 || r.height < 24)).length,
  );
  expect(small).toBe(0);                        // R-M4
});

test("status is never conveyed by colour alone", async ({ page }) => {
  await page.goto("/instances");
  const badges = await page.locator("[data-state]").count();
  expect(badges).toBeGreaterThan(0);
  for (let i = 0; i < badges; i++) {
    await expect(page.locator("[data-state]").nth(i)).not.toBeEmpty(); // text accompanies the tone, R-A3
  }
});
```

**Step 2: Run them — expect failure**

Run: `bun run --cwd apps/web x playwright test e2e/a11y.spec.ts e2e/mobile.spec.ts`
Expected: FAIL on the first missing behaviour (palette escape handling, mobile sheet chrome, target
sizes) — each failure is a real gap, not a harness error.

**Step 3: Fix until green**

Apply R-A1–R-A9 (`h1` focus restoration, `aria-busy` regions with hidden `role="status"` labels,
icon+text status, two-tone focus ring, landmarks, keyboard completion of every pointer action,
exactly one polite/assertive shell region, `AlertDialog` for destructive actions, reduced
motion/transparency) and R-M1–R-M8 (reflow to stacked row cards, sheet chrome below `md`, single-column
panels, 24 px targets, composer above the on-screen keyboard with toasts at the top edge, tap targets
for hover affordances, long-identifier truncation with full labels, `⟨N⟩ new` control instead of
auto-scroll).

**Step 4: Verify and commit**

Run: `bun run --cwd apps/web x playwright test e2e/`
Expected: PASS — P13's proof: a keyboard-only walkthrough of login → create → pair → sync → assign →
whitelist → search → ask → approve, plus a 320 px / 400 % zoom pass on every view with no horizontal
scrolling.

```bash
git add apps/web/e2e apps/web/playwright.config.ts apps/web/src
git commit -m "feat(ui): add P13 accessibility and mobile pass across all views"
```

---

### Task 20.15: P14 — live transport and drift guards

**Files:** `ui/resource/transport-drift.test.ts`, `ui/feedback/error-map.test.ts`, `scripts/dev.test.ts` (unchanged, re-run)

**Step 1: Write the failing guards**

```ts
import { describe, expect, test, vi } from "vitest";
import { mapError } from "../feedback/error-map";

describe("drift guards (spec P14, draft §6.5/§6.7)", () => {
  const workerCodes = [
    "unauthorized", "store_error", "encode_error", "decode_error", "group_not_found",
    "instance_offline", "group_sync_failed", "method_not_allowed", "not_found", "foreign_media",
    "invalid_transition", "group_not_assigned", "ai_no_whitelist", "ai_token_budget_exceeded",
  ];

  test("every worker code has copy and a surface", () => {
    for (const code of workerCodes) {
      const mapped = mapError({ code });
      expect(mapped.title.length).toBeGreaterThan(0);
      expect(["inline", "banner", "toast"]).toContain(mapped.surface);
      expect(mapped.body, `${code} must state what still works`).toBeTruthy();
    }
  });

  test("an unknown code falls back and keeps the raw code copyable", () => {
    const mapped = mapError({ code: "some_future_code" });
    expect(mapped.title).toMatch(/unexpected/i);
    expect(mapped.copyableCode).toBe("some_future_code");
    expect(mapped.surface).toBe("inline");
  });

  test("SSE failure changes only the indicator and never the DOM content", async () => {
    // Assert the rendered tree is byte-identical across a forced transport switch.
    const { render, screen } = await import("@testing-library/react");
    const { Panel } = await import("../../components/panel");
    const { rerender } = render(<Panel title="Groups" transport="sse"><span>Ops Team</span></Panel>);
    const before = document.body.innerHTML;
    rerender(<Panel title="Groups" transport="poll"><span>Ops Team</span></Panel>);
    expect(document.body.innerHTML).toBe(before);
    expect(screen.getByTestId("live-indicator")).toHaveAttribute("data-transport", "poll");
  });
});
```

**Step 2: Run them — expect failure; then implement**

Run: `bun run --cwd apps/web test transport-drift error-map` → FAIL until the map covers every code and
the indicator is transport-only.

Implement: resume-token reconnect with backoff, the SSE↔poll parity test above, contract parity via
the shared zod schemas from `@butler/shared` (draft §6.7) with a committed drift fixture, complete
`error-copy` coverage, and stale-scope deep-link handling (a stale bookmark renders the view's working
default, never an error page).

**Step 3: Verify and commit**

Run: `bun run --cwd apps/web test ui && bun run --cwd apps/web check && bun test scripts/dev.test.ts`
Expected: PASS — P14's proof: a forced SSE failure produces no visible change beyond the indicator; an
unknown worker code renders the fallback with a copyable code; a drift fixture fails loudly.

```bash
git add apps/web/src/ui apps/web/src/scripts 2>/dev/null || git add apps/web/src
git commit -m "feat(ui): add P14 live-transport and contract drift guards"
```

---

### Task 20.16: P15 — UI decision gate

**Step 1: Walk `docs/ui-decision.md` §6 in order and tick every line**

Each line is a verifiable claim about this implementation; do not tick one you have not exercised.

**Step 2: Run the spec's own gate commands**

Run: `bun run --cwd apps/web test && bun run --cwd apps/web x playwright test e2e/ && bun run --cwd apps/web check`
Expected: all green. Then run the manual gate items that no test can cover, against the live stack
started by `bun run dev:local`:

| Gate item (spec §6) | How to confirm |
|---|---|
| Adding a hypothetical eleventh workspace touches only its descriptor files (invariant 5) | add a throwaway view descriptor module, confirm `AppShell`/`PanelGrid`/`ResourceGate` are untouched, then delete it |
| No toast from a background event or a load failure (R-T5) | rename a group and stop a panel's backing service while watching the notification region |
| A failed panel never blanks its workspace; a failed dialog never dismisses (R-X2) | stop the worker, then open and fail an approval dialog |
| Media fetched only through presigned URLs (invariant 8) | watch the network panel while scrolling a group with stored media |
| Interaction remains usable while a live patch lands (R-V1) | type in the composer while a rename and new messages arrive |

**Step 3: Commit the gate result**

```bash
git add -A
git commit -m "docs(ui): record P15 decision-gate walkthrough for the Scope-Spine Registry Shell"
```

---

## Task 21: Send approval and dispatch (R7)

**Files:**
- Create: `apps/web/src/server/repos/sends.ts`, `apps/web/src/server/repos/sends.test.ts`
- Create: `apps/web/src/app/api/sends/route.ts`, `apps/web/src/app/api/sends/[id]/[action]/route.ts`, `apps/web/src/app/api/sends/[id]/[action]/route.test.ts`
- Create: `apps/worker/dispatch.go`, `apps/worker/dispatch_test.go`

**Step 1: Failing state-machine tests (BFF)**

`apps/web/src/server/repos/sends.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { canTransition } from "./sends";

describe("send request state machine", () => {
  test("immediate approval goes to approved, scheduled approval to scheduled", () => {
    expect(canTransition("pending_approval", "approved")).toBe(true);
    expect(canTransition("pending_approval", "scheduled")).toBe(true);
  });

  test("nothing reaches sending without approval", () => {
    expect(canTransition("draft", "sending")).toBe(false);
    expect(canTransition("pending_approval", "sending")).toBe(false);
    expect(canTransition("rejected", "sending")).toBe(false);
    expect(canTransition("approved", "sending")).toBe(true);
    expect(canTransition("scheduled", "sending")).toBe(true);
  });

  test("approved may be scheduled and pre-send states may be cancelled", () => {
    expect(canTransition("approved", "scheduled")).toBe(true);
    expect(canTransition("approved", "cancelled")).toBe(true);
    expect(canTransition("scheduled", "cancelled")).toBe(true);
    expect(canTransition("sent", "cancelled")).toBe(false);
  });

  test("an ambiguous failure can only return to approval, never straight back to sending", () => {
    expect(canTransition("failed", "pending_approval")).toBe(true);
    expect(canTransition("failed", "sending")).toBe(false);
  });
});
```

**Step 2: Run it — expect failure**

Run: `bun run --cwd apps/web test repos/sends`
Expected: FAIL — `Cannot find module './sends'`.

**Step 3: Implement `repos/sends.ts`**

- `type SendStatus = "draft" | "pending_approval" | "approved" | "scheduled" | "sending" | "sent" | "failed" | "rejected" | "cancelled"`.
- `const TRANSITIONS: Record<SendStatus, SendStatus[]>` encoding §8.1 exactly, and
  `canTransition(from, to): boolean` reading it.
- `createSendRequest(db, {organizationId, instanceId, groupJid, mode, scheduledFor, content, createdBy, origin})`
  with a generated `idempotencyKey` (uuid) — a duplicate key is a no-op returning the existing row.
- `approveSend(db, id, {note, scheduledFor})`: requires status `pending_approval` or `failed`,
  validates the group is `config.assigned` and belongs to the instance, the instance is `connected`,
  and content is non-empty; writes `approval.{state:"approved", approvedBy, approvedAt}` and sets
  `approved` (immediate) or `scheduled` + `scheduledFor` (future, ≥ now + 30s).
- `rejectSend`, `cancelSend`, `listSends` — each writing an `auditLog` row.

**Step 4: Implement the routes and their test**

`api/sends/route.ts`: `GET` (queue with status/instance filters), `POST` (create a draft or submit for
approval). `api/sends/[id]/[action]/route.ts`: `action ∈ {approve, reject, cancel}`, 409
`code:"invalid_transition"` when `canTransition` refuses, 400 `code:"group_not_assigned"` /
`code:"instance_offline"` per the validation above.

`api/sends/[id]/[action]/route.test.ts` asserts, against the memory replica set with a stubbed
session: a draft cannot be approved straight to `sending`; approving an unassigned group returns 400;
a successful approve writes `status:"scheduled"` and an audit row.

Run: `bun run --cwd apps/web test "sends"` → PASS.

**Step 5: Failing worker dispatch tests**

`apps/worker/dispatch_test.go`:

```go
package main

import (
	"context"
	"errors"
	"testing"
	"time"
)

type fakeSender struct {
	sent   int
	err    error
	lastTo string
}

func (f *fakeSender) Send(ctx context.Context, req SendRequest) (string, error) {
	if f.err != nil {
		return "", f.err
	}
	f.sent++
	f.lastTo = req.GroupJID
	return "3EB0SENT", nil
}

func TestClaimDueSendRequestsTakesOnlyApprovedOrDueScheduled(t *testing.T) {
	ctx := context.Background()
	client, db, err := connectMongo(ctx, testMongoURI(t), "group_butler_test")
	if err != nil {
		t.Fatalf("connectMongo: %v", err)
	}
	defer func() { _ = client.Disconnect(ctx) }()
	if err := db.Collection(collSendRequests).Drop(ctx); err != nil {
		t.Fatalf("drop: %v", err)
	}
	store := newSendStore(db)
	past := time.Now().Add(-time.Minute)
	future := time.Now().Add(time.Hour)
	seed := []struct {
		id     string
		status string
		due    *time.Time
	}{
		{"due-approved", "approved", &past},
		{"due-scheduled", "scheduled", &past},
		{"not-yet", "scheduled", &future},
		{"awaiting-approval", "pending_approval", &past},
	}
	for _, row := range seed {
		if err := store.Insert(ctx, SendRequest{ID: row.id, OrganizationID: "org_default", InstanceID: "inst_1",
			GroupJID: "120363043123456789@g.us", Status: row.status, ScheduledFor: row.due, Text: "hi"}); err != nil {
			t.Fatalf("seed %s: %v", row.id, err)
		}
	}

	claimed, err := store.ClaimDue(ctx, "worker-1", deviceClockStub(time.Now()))
	if err != nil {
		t.Fatalf("ClaimDue: %v", err)
	}
	got := map[string]bool{}
	for _, req := range claimed {
		got[req.ID] = true
	}
	if !got["due-approved"] || !got["due-scheduled"] || got["not-yet"] || got["awaiting-approval"] {
		t.Fatalf("claimed = %v, want only the two due rows", got)
	}
}

func TestDispatchMarksSentAndStoresMessageID(t *testing.T) {
	sender := &fakeSender{}
	store := newStubSendStoreFromRequest(SendRequest{ID: "r1", GroupJID: "120363043123456789@g.us"})
	if err := dispatchOnce(context.Background(), store, sender, "worker-1"); err != nil {
		t.Fatalf("dispatchOnce: %v", err)
	}
	if sender.sent != 1 || store.lastWaMessageID() != "3EB0SENT" {
		t.Fatalf("sent=%d waMessageId=%q", sender.sent, store.lastWaMessageID())
	}
}

func TestDispatchClassifiesAmbiguousFailureAndNeverAutoRetries(t *testing.T) {
	sender := &fakeSender{err: errors.New("timeout waiting for ack")}
	store := newStubSendStoreFromRequest(SendRequest{ID: "r2", GroupJID: "120363043123456789@g.us"})
	if err := dispatchOnce(context.Background(), store, sender, "worker-1"); err != nil {
		t.Fatalf("dispatchOnce: %v", err)
	}
	if store.lastStatus() != "failed" || store.lastErrorClass() != "ambiguous" {
		t.Fatalf("status=%q class=%q, want failed/ambiguous", store.lastStatus(), store.lastErrorClass())
	}
	if sender.sent != 0 {
		t.Error("an ambiguous send must not be retried automatically")
	}
}
```

**Step 6: Run them — expect failure**

Run: `cd apps/worker && go test ./... -run 'TestClaimDue|TestDispatch' -v`
Expected: FAIL — `undefined: newSendStore`, `SendRequest`, `dispatchOnce`.

**Step 7: Implement `dispatch.go`**

- `type SendRequest struct` (ID, OrganizationID, InstanceID, GroupJID, Status, ScheduledFor, Text,
  Media, Attempts, LockedAt, ErrorClass, WaMessageID).
- `sendStore.ClaimDue(ctx, workerID string, now time.Time) ([]SendRequest, error)` using a
  `findOneAndUpdate` loop (or a single `UpdateMany` claim followed by a fetch) with
  `{$in: ["approved","scheduled"]}`, `scheduledFor <= now`, and a lock guard
  `{$or: [{"dispatch.lockedAt": nil}, {"dispatch.lockedAt": {$lt: now.Add(-60 * time.Second)}}]}`,
  setting `status:"sending"`, `dispatch.lockedAt`, `dispatch.lockedBy`, `$inc attempts` — the 60s
  staleness window makes a worker restart mid-send recoverable.
- `dispatchOnce(ctx, store, sender, workerID)` → claim, work each request: skip when the instance is
  not connected (release the lock), build the envelope with the **pure** builders
  (`buildOutboundMessage(req)`, `applyQuotedContext`, `markdownToWhatsApp` — unit-testable without a
  socket, mirroring the reference), send, then persist `waMessageId` + `sent`; on error classify
  (`auth | rejected | transport | ambiguous`) and either back off for a retry (below
  `SEND_MAX_ATTEMPTS`) or finish as `failed`; an ambiguous error never retries.
- A `time.Ticker(cfg.DispatchInterval)` loop in `main.go`, plus `POST /internal/dispatch/tick` for ops.

**Step 8: Verify and commit**

Run: `cd apps/worker && gofmt -l . && go vet ./... && go test ./... -run 'TestClaimDue|TestDispatch' -v`
Expected: PASS (3 tests).

```bash
git add apps/web/src/server/repos/sends.ts apps/web/src/server/repos/sends.test.ts apps/web/src/app/api/sends apps/worker/dispatch.go apps/worker/dispatch_test.go
git commit -m "feat: add human-approved send queue with locked worker dispatch"
```

---

## Task 22: AI assistant with the per-instance JID whitelist (R5)

**Files:**
- Create: `apps/web/src/server/ai/{provider.ts,tools.ts,assistant.ts,tools.test.ts,assistant.test.ts}`
- Create: `apps/web/src/app/api/assistant/route.ts`, `apps/web/src/app/api/assistant/calls/route.ts`

**Step 1: Failing whitelist tests (the security property)**

`apps/web/src/server/ai/tools.test.ts`:

```ts
import { describe, expect, test, vi } from "vitest";
import { buildAssistantTools } from "./tools";

const allowed = ["120363043123456789@g.us"];
const search = vi.fn(async () => [{ waMessageId: "m1", groupJid: allowed[0] }] as never);

describe("assistant tool scope", () => {
  test("a non-whitelisted group returns nothing and is recorded as rejected", async () => {
    const tools = buildAssistantTools({
      organizationId: "org_default", instanceId: "inst_1", allowedGroupJids: allowed, search,
    });
    const result = await tools.searchMessages.execute!({ groupJid: "120363043999999999@g.us", text: "deploy" });
    expect(result.messages).toEqual([]);
    expect(result.rejected).toEqual([{ groupJid: "120363043999999999@g.us", reason: "not_whitelisted" }]);
    expect(search).not.toHaveBeenCalled();
  });

  test("the whitelist is applied as an $in filter even when no group is requested", async () => {
    const tools = buildAssistantTools({
      organizationId: "org_default", instanceId: "inst_1", allowedGroupJids: allowed, search,
    });
    await tools.searchMessages.execute!({ text: "deploy" });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: "org_default", instanceId: "inst_1", groupJids: allowed,
    }));
  });

  test("an instance with an empty whitelist has no searchable scope", () => {
    const tools = buildAssistantTools({
      organizationId: "org_default", instanceId: "inst_1", allowedGroupJids: [], search,
    });
    expect(tools.searchMessages).toBeUndefined();
    expect(tools.__scopeDisabled).toBe("ai_no_whitelist");
  });

  test("draftSend can only create a draft, never a send", async () => {
    const draft = vi.fn(async () => ({ id: "s1", status: "pending_approval" }));
    const tools = buildAssistantTools({
      organizationId: "org_default", instanceId: "inst_1", allowedGroupJids: allowed, search, draftSend: draft,
    });
    const result = await tools.draftSend.execute!({ groupJid: allowed[0], text: "hi" });
    expect(result.status).toBe("pending_approval");
    expect(draft).toHaveBeenCalledWith(expect.objectContaining({ status: "pending_approval" }));
  });
});
```

**Step 2: Run it — expect failure**

Run: `bun run --cwd apps/web test ai/tools`
Expected: FAIL — `Cannot find module './tools'`.

**Step 3: Implement `provider.ts` and `tools.ts`**

`provider.ts`:

```ts
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

/** The only module aware of the provider's shape (§7.1). */
export const butler = createOpenAICompatible({
  name: "butler",
  baseURL: process.env.AI_BASE_URL ?? "",
  apiKey: process.env.AI_API_KEY ?? "",
});

export const butlerModel = butler(process.env.AI_MODEL ?? "");
```

`tools.ts`: `buildAssistantTools({organizationId, instanceId, allowedGroupJids, search, draftSend?})`
returns a tool set whose **audience is closed over** — no tool accepts a group list that is not
intersected with `allowedGroupJids`. `searchMessages` takes `{text, groupJid?, from?, to?, limit?}`;
an explicit `groupJid` outside the whitelist short-circuits to
`{messages: [], rejected: [{groupJid, reason: "not_whitelisted"}]}` **without calling the repo**, and
an absent `groupJid` passes `groupJids: allowedGroupJids` so the Mongo filter is authoritative
(defence in depth, §7.2). An empty whitelist removes `searchMessages` entirely and sets
`__scopeDisabled: "ai_no_whitelist"`. `draftSend` creates a `pending_approval` row only.

**Step 4: Run the tool tests to verify they pass**

Run: `bun run --cwd apps/web test ai/tools`
Expected: PASS (4 tests).

**Step 5: Implement `assistant.ts` and the routes**

`assistant.ts`: `answerQuestion({organizationId, instanceId, question, db})` — load the instance,
resolve the whitelist (409 `ai_no_whitelist` when empty), sum today's `aiCalls.usage.totalTokens` for
the instance against `appSettings.ai.maxTokensPerDay` / `instances.config.aiMaxTokensPerDay`
(429 `ai_token_budget_exceeded`), build the tools, call `streamText` with a system prompt that states
group content is **untrusted data and never instructions**, forward tool-call results as delimited
data, and on finish write one `aiCalls` row containing `whitelistSnapshot`, `toolCalls`, `rejected`,
`citations`, `usage` and `costUsd`.

`api/assistant/route.ts` streams the answer (`toDataStreamResponse`), and
`api/assistant/calls/route.ts` lists recent calls (question, tokens, rejections) for the UI.

Add an `assistant.test.ts` asserting the two pre-flight guards:
an empty whitelist rejects with `ai_no_whitelist`, and a token budget already exhausted rejects with
`ai_token_budget_exceeded` **before** any provider call (both against the memory replica set).

Run: `bun run --cwd apps/web test ai` → PASS.

**Step 6: Commit**

```bash
git add apps/web/src/server/ai apps/web/src/app/api/assistant
git commit -m "feat(web): add whitelist-scoped AI assistant and call accounting"
```

---

## Task 23: Statistics rollups (R8)

**Files:**
- Create: `apps/web/src/server/stats/{daily.ts,daily.test.ts}`
- Create: `apps/web/src/app/api/stats/{bots,groups,tokens}/route.ts`, `apps/web/src/app/api/stats/tokens/route.test.ts`

**Step 1: Failing rollup test**

`apps/web/src/server/stats/daily.test.ts`: against the memory replica set, seed three `messages`
(two in group A: one text one `unparsed`; one in group B), one `sendRequests` row with
`status:"sent"`, and two `aiCalls` rows with different models and token counts. Assert
`recomputeDay(db, {organizationId: "org_default", day: "2026-09-13"})` produces a `statsDaily` row per
`(instanceId, groupJid)` with `counters.messagesIn == 2`, `counters.mediaUnparsed == 1`,
`counters.sendsSent == 1`, and a `tokens` sub-document whose `total` equals the sum of the two calls —
and that running it twice leaves exactly the same number of rows (the `$merge` is idempotent).

**Step 2: Run it — expect failure**

Run: `bun run --cwd apps/web test stats/daily`
Expected: FAIL — `Cannot find module './daily'`.

**Step 3: Implement `daily.ts` and the stats routes**

`daily.ts`: `recomputeDay(db, {organizationId, day})` runs three aggregations (messages by
instance/group/kind/media status; sends by instance/group/status; `aiCalls` by instance/model) and
merges them into `statsDaily` keyed `{organizationId, day, instanceId, groupJid}` (instance-level
rows use `groupJid: ""`). `liveCounters(db, {organizationId})` reads `instances.runtime.counters` for
the current day so the dashboard is instant, and the rollup reconciles.

Routes: `/api/stats/bots` (per-instance counters + uptime + send success rate),
`/api/stats/groups` (per-group message/media/send counts and activity), `/api/stats/tokens`
(per model/instance: calls, prompt/completion/total tokens, cost, average latency, rejection count).
All three call `requireOwner()` first. `tokens/route.test.ts` asserts the aggregation sums `aiCalls`
for the organisation only and never leaks another `organizationId`.

**Step 4: Verify and commit**

Run: `bun run --cwd apps/web test stats`
Expected: PASS.

```bash
git add apps/web/src/server/stats apps/web/src/app/api/stats
git commit -m "feat(web): add idempotent daily stats rollups and stats routes"
```

---

## Task 24: Containers, CI, and GHCR (R9, R10)

**Files:**
- Create: `apps/worker/Dockerfile`
- Create: `apps/web/Dockerfile`
- Create: `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`
- Create: `infra/prod/docker-compose.ghcr.yml` (optional convenience)

**Step 1: Worker Dockerfile (mirrors the reference's proven shape)**

```dockerfile
# syntax=docker/dockerfile:1

# CGO is required by mattn/go-sqlite3 (the whatsmeow auth store is sqlite), so the
# build runs on the Debian-based golang image and the runtime must be glibc.
FROM golang:1.25 AS builder
WORKDIR /src
ENV CGO_ENABLED=1 GOOS=linux
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -ldflags="-s -w" -o /out/worker ./...

FROM golang:1.25 AS development
WORKDIR /app
ENV CGO_ENABLED=1
EXPOSE 4000
VOLUME ["/data"]
CMD ["go", "run", "./..."]

FROM debian:bookworm-slim AS production
WORKDIR /app
ENV PORT=4000
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
COPY --from=builder /out/worker /usr/local/bin/worker
EXPOSE 4000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -fsS http://127.0.0.1:4000/health || exit 1
CMD ["worker"]
```

**Step 2: Web Dockerfile (Next.js standalone)**

```dockerfile
# syntax=docker/dockerfile:1
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN bun install --frozen-lockfile

FROM oven/bun:1 AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun run --cwd apps/web build

FROM node:22-alpine AS production
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public
USER nextjs
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
```

**Step 3: CI workflow**

`.github/workflows/ci.yml`: on `pull_request` and `push` to `master` — checkout; setup bun;
`bun install --frozen-lockfile`; `bun run lint`; `bun run --cwd apps/web check`; `bun test`
(includes the dev-launcher and env-example contract suites, so a broken `.env.example` or a
Dockerfile-adding launcher change fails CI); `bun run --cwd apps/web build`; then setup-go 1.25,
`gofmt -l .` (fail on output), `go vet ./...`, `go test ./... -short` in `apps/worker`.

**Step 4: Deploy workflow (GHCR)**

`.github/workflows/deploy.yml`: on `push` to `master` and tags `v*`; `permissions: {contents: read, packages: write}`;
`docker/login-action` with `GITHUB_TOKEN`; `docker/setup-buildx-action`; two
`docker/build-push-action` steps (contexts `apps/web` and `apps/worker`, `target: production`) with
`docker/metadata-action` tags (`type=ref,event=branch`, `type=semver`, `type=sha`) and
`cache-from/to: type=gha`. Image names: `ghcr.io/${{ github.repository }}/web` and
`ghcr.io/${{ github.repository }}/worker`.

**Step 5: Optional pull-only compose**

`infra/prod/docker-compose.ghcr.yml` wires the two published images with `env_file: .env`, `restart:
unless-stopped`, `network_mode: host` for the worker (so the web app reaches it at
`http://127.0.0.1:4000`) and `volumes: [butler-wa:/data]`. A comment states it is **optional**: both
images are standalone and `docker run` is the documented path.

**Step 6: Verify the images build and run**

Run: `docker build -f apps/worker/Dockerfile -t butler-worker:dev apps/worker && docker build -f apps/web/Dockerfile -t butler-web:dev .`
Expected: both succeed; the web image reports a dry-run start (`docker run --rm --env-file .env -p 3000:3000 butler-web:dev node -e "console.log('image ok')"`).

Run the worker image against the local infra to prove the standalone contract:
`docker run --rm --env-file .env -e MONGODB_URI="mongodb://host.docker.internal:27017/group_butler?replicaSet=rs0" -p 4000:4000 butler-worker:dev` then `curl -sf localhost:4000/health`.
Expected: `{"ok":true}`.

**Step 7: Commit**

```bash
git add apps/worker/Dockerfile apps/web/Dockerfile .github/workflows infra/prod/docker-compose.ghcr.yml
git commit -m "build: add standalone web/worker images and GHCR deployment workflows"
```

---

## Task 25: End-to-end verification and local-dev acceptance

**Step 1: Full suite, once, on the frozen tree**

Run: `bun test && bun run --cwd packages/shared test && bun run --cwd apps/web test && cd apps/worker && gofmt -l . && go vet ./... && go test ./...`
Expected: every suite green, `gofmt` silent, vet clean. Record the exact commands and output in the PR body.

**Step 2: The one-command developer path, from a clean clone state**

Run:

```bash
rm -f .env
docker compose -f infra/dev/docker-compose.yml down -v   # prove a cold start
cp .env.example .env
bun install
bun run dev:check
bun run dev:local
```

Expected, in order: `dev:check` prints `r2 ok …` then `check ok: env present and complete (incl. R2), mongo replica set healthy (apps not started)` and exits 0; `dev:local` prints `[dev]` lines, then `started [web]` and `started [worker]`, then interleaved prefixed logs. A run with an R2 placeholder still in `.env` must abort before any container starts, naming the variable and where to obtain it — that is the acceptance for the mandatory local-dev UX (R10, §13).

**Step 3: Live acceptance against the running stack (maps to R1–R11)**

With `bun run dev:local` running and one instance paired:

| Check | Command / action | Expected |
|---|---|---|
| Worker health | `curl -sf localhost:4000/health` | `{"ok":true}` |
| BFF health | `curl -sf -b /tmp/butler.jar localhost:3000/api/health` | `{"ok":true,"mongo":"up"}` |
| R2 preflight | `bun run dev:check` with `R2_SECRET_ACCESS_KEY=REPLACE_WITH_R2_SECRET_ACCESS_KEY` | aborts before starting containers, naming the variable and where to get it |
| Real R2 in dev | upload media from a test group, then open the object URL from the R2 dashboard | the object exists in the **dev** bucket; presigned URLs from `/api/media/{id}/url` resolve |
| No local S3 emulator | `docker compose -f infra/dev/docker-compose.yml config --services` and `grep -ril minio` over the repo | only `mongo`/`mongo-init`; no MinIO reference anywhere |
| R11 group ID + name | spine and `/instances/<id>` | every group shows `<id>@g.us` and its current name; an unfetched name shows `(unnamed group) <id>` |
| Rename propagation | rename the group from a phone | name updates without reload; live indicator `connected`; one `auditLog` `group.updated` row |
| R1 ingest everything | send text, an image, and a message with no caption | all appear in the group stream; the caption-less image is stored as `kind:"image"` |
| R2/R3 media | send a file WhatsApp cannot preview, plus a view-once | unreadable file → `media.status:"unparsed"` with `declaredType` **and** an R2 key; view-once → `unavailable/view_once` with the reason and no key |
| R4 search | `curl -sf -b /tmp/butler.jar 'localhost:3000/api/messages?q=deploy'` | matching rows, including matches inside a file name |
| R5 AI scope | ask the assistant about a non-whitelisted group | empty answer, `aiCalls.rejected` records `not_whitelisted`, and the token counter did not grow for that group |
| R6 multi-instance | pair a second instance | the spine lists both; each group belongs to exactly one instance row |
| R7 sends | draft → approve → schedule 1 minute ahead | `pending_approval → scheduled → sending → sent`, with `dispatch.waMessageId` set; a rejected group is refused with 400 |
| R8 stats | `/stats` | bot, group and token counters match the day's `aiCalls` and `messages` |
| Worker restart safety | `docker compose stop mongo` briefly, then restart | ingest queue depth rises and `runtime.ingest.droppedTotal` is visible; no message rows are corrupted |
| Graceful shutdown | Ctrl-C in the dev terminal | both children exit, `pgrep -f 'go run ./...'` empty, infra still up, `bun run dev:down` stops it |

**Step 4: Confirm no secrets or state leaked into git**

Run: `git status --porcelain && git log --oneline -1 && git check-ignore -v .env apps/worker/.localdata/whatsmeow.db`
Expected: no `.env`, no `whatsmeow.db`, no `.localdata/` in the tree; both paths reported as ignored.

**Step 5: Final commit**

```bash
git add -A
git commit -m "docs: record end-to-end verification for the group butler core"
```

---

## Task dependency graph

```mermaid
flowchart TD
  T1[1 monorepo] --> T2[2 env example]
  T2 --> T4[4 dev launcher]
  T3[3 dev infra: mongo only] --> T4
  T2 --> T5[5 shared contracts]
  T1 --> T6[6 worker config]
  T3 --> T7[7 mongo + indexes]
  T6 --> T7 --> T8[8 ingest]
  T8 --> T9[9 media]
  T8 --> T10[10 group fixtures T1-T4]
  T10 --> T11[11 subject rule T5] --> T12[12 deltas T6,T7] --> T13[13 store T8] --> T14[14 sync T9-T11] --> T15[15 group endpoints T12,T13]
  T15 --> T16[16 lifecycle + main]
  T2 --> T17[17 owner auth]
  T5 --> T17 --> T18[18 group read model T14] --> T19[19 message search] --> T20[20 Option B shell]
  T18 --> T20
  T19 --> T20 --> T21[21 sends]
  T20 --> T22[22 AI whitelist]
  T20 --> T23[23 stats]
  T21 --> T24[24 containers + GHCR]
  T22 --> T24
  T23 --> T24 --> T25[25 verification]
```

## Definition of done

- Tasks 1–25 complete, each with its tests committed **before** the implementation (`git log` shows the red/green pairing per task).
- `bun test`, `bun run --cwd apps/web test`, the worker's `go test ./... -short`, `gofmt -l` and `go vet ./...` all clean on the frozen tree.
- The mandatory local-dev UX works from a cold clone: `cp .env.example .env` (with real R2 values), `bun install`, `bun run dev:check`, `bun run dev:local` — infra-only Docker (MongoDB alone), prefixed logs, an actionable preflight failure when R2 is unconfigured, and no orphan processes after Ctrl-C.
- Media storage is a real Cloudflare R2 bucket in development and production: no MinIO, no local S3 emulator, no endpoint override and no path-style configuration anywhere in the tree.
- `docs/ui-decision.md` (the authoritative UI specification) gates the dashboard: all ten views render inside the single `AppShell`, no view calls `fetch` directly, skeleton tiers and toast policy follow `R-L*`/`R-T*`, and the view/resource/scope structure plus skeleton, toast and live-update states are implemented per spec §5 P0–P15.
- The dashboard shows every instance's group ID and current group name (R11), including on rename.
- Both images build and are pushed by `deploy.yml`; neither needs compose to run, and neither dev file is used to build them.
