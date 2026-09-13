# WhatsMeow worker reference notes

Source reviewed: `hallo-zetta/services/whatsapp`, its Dockerfile, and `.github/workflows/{ci,deploy}.yml`. These are implementation notes, not a request to copy its MySQL/Redis topology.

## Session lifecycle and HTTP contract

- Keep one in-memory `session` and one `*whatsmeow.Client` per application session ID. Protect the session map and mutable client/session fields with locks.
- Create flow: persist session metadata as `pairing`, make a fresh WhatsMeow device, register the event handler before `Connect`, then return QR or phone-pairing code after a short bounded wait. Normalize phone input to digits before pairing.
- Restore flow: at startup, load metadata for previously paired sessions, locate the matching auth device by the persisted phone/JID, and reconnect it. The source deliberately never reuses an arbitrary registered device for a new session.
- Connected flow: record canonical bot JID/LID and phone, clear pairing artifacts, persist `connected`, and emit a connection event. Enable reconnect, but treat `LoggedOut` differently: disconnect, delete the auth device, mark metadata `disconnected`, and remove the live session.
- Graceful shutdown must only disconnect clients. Do not log out, or a deployment invalidates every linked device. Explicit session deletion must log out, delete the WhatsMeow device, delete metadata, and remove it from memory.
- Reject duplicate live ownership of the same WhatsApp account. Compare canonical non-AD JIDs across live clients before accepting a restored or newly connected device.

Suggested minimal worker API, called only by the Next BFF:

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Liveness only, no auth-dependent data. |
| `GET /sessions` | List persisted sessions merged with live pairing state. |
| `POST /sessions` | Create `{ label, mode: "qr" | "code", phoneNumber? }`; return a session snapshot with QR data URL or pairing code where applicable. |
| `GET /sessions/:id` | Return the live/restored snapshot, or a disconnected stub for an unknown ID. |
| `DELETE /sessions/:id` | Explicit logout and complete auth/metadata cleanup. |
| `POST /sessions/:id/send` | Send text/media/reply content and return WhatsApp message ID. |
| `POST /sessions/:id/presence` | Send composing, recording, or paused presence. |

Keep snapshots small: `id`, `label`, `phoneNumber`, `status`, `qr`, `pairingCode`, `pairingError`. Expose QR only while the session is pairing. Bound JSON body sizes, request deadlines, QR/pairing waits, and outbound calls in the new worker.

## Persistent state and multi-session layout

Separate durable data into two stores:

1. **Application-owned MongoDB metadata**, keyed by tenant and session ID: label, tenant ID, status, phone/JIDs, timestamps, event cursor/delivery state, and an explicit auth-device reference.
2. **WhatsMeow auth SQL store**, which retains device credentials and protocol state. Use a durable SQLite volume for one worker replica, or PostgreSQL when replicas/access coordination require shared SQL auth state. Set SQLite foreign keys on.

The reference uses one shared `sqlstore.Container` plus a MySQL `whatsapp_sessions` table. For the MongoDB target, preserve the logical split but replace every metadata query/update with a Mongo repository. Never assume MongoDB can substitute for `sqlstore`.

Recommended tenancy invariant: every worker request includes a BFF-authenticated tenant/session identity; all Mongo reads and writes filter by both. Index `{ tenantId: 1, sessionId: 1 }` uniquely. Do not use a process-global map as the source of truth, it is only a live-client cache.

For horizontal scale, establish single ownership before connecting a device. A shared auth store alone does not prevent two workers from connecting the same session. Use a Mongo lease with expiry/renewal or route each session consistently to one worker; release it on graceful shutdown and validate ownership before reconnecting.

## Events and callback delivery to the Next BFF

The reference publishes JSON envelopes to Redis both per session (`wa:events:<id>`) and firehose (`wa:events:all`):

```json
{ "type": "message.inbound", "sessionId": "...", "payload": { "...": "..." } }
```

It publishes `qr`, `pairing_code`, `connected`, `message.inbound`, `message.receipt`, and `contact.lid_mapped`. Its inbound message payload includes normalized sender identity, group context, WhatsApp message ID, body, mention state/reason, quoted-message fields, and uploaded-media metadata. It gates group messages unless the bot was mentioned.

For the new target, have the worker call a private Next BFF callback endpoint instead of coupling the worker to Redis. Include an immutable `eventId`, `type`, `occurredAt`, `tenantId`, `sessionId`, and payload. The BFF must deduplicate on `eventId` and persist/process events transactionally. Sign callbacks, retry with bounded exponential backoff, and retain a Mongo outbox/delivery record so a worker restart cannot silently lose a message. Do not block WhatsMeow's event handler on callback I/O: enqueue delivery after parsing and persist enough data to retry.

Receipts need special handling: recipient delivery/read receipts can have `IsFromMe=false`; do not discard them merely on that flag. Normalize WhatsMeow's empty receipt type to `delivered`. Read receipts are inherently absent when recipients disable them.

## Worker authentication

The reference protects all routes except `/health` with `Authorization: Bearer <WORKER_SECRET>` and compares it with `subtle.ConstantTimeCompare`. Its default `dev-secret` is acceptable only for local development.

For production, keep the worker off the public ingress if possible and require BFF-to-worker service authentication on every non-health route. Use a secret supplied only at runtime, rotate it, and reject startup when it is missing or development-default. Prefer a short-lived, audience-bound signed service token (or mTLS where the platform supports it) over a permanent bearer token. Include request time, nonce/idempotency key, method/path binding, and replay-window validation. Authenticate worker-to-BFF callbacks independently with a distinct secret/key; do not reuse the request credential. Log request IDs and tenant/session IDs, never Authorization headers, QR strings, pairing codes, or media bytes.

## Media downloads and R2

The reference detects inbound media, downloads through `client.Download`, uploads bytes to R2, then emits `{ type, key, mime, size, fileName?, url? }`. R2 keys are `whatsapp/<session>/<type>/<random>.<extension>`. For outbound media it downloads the stored object before passing it to WhatsApp.

For the MongoDB/R2 worker:

- Make the object key tenant-scoped: `whatsapp/<tenantId>/<sessionId>/<mediaType>/<random>.<ext>`; session-only keys can cross tenant boundaries.
- Treat MIME type, filename, and extension as untrusted. Allowlist media classes, validate magic bytes where feasible, normalize filenames, and enforce both declared and streamed byte limits before buffering/uploading.
- The reference reads complete objects into memory for inbound upload and outbound send. Replace this with a bounded streaming path where the WhatsMeow API permits it, otherwise enforce explicit size caps and concurrency limits.
- Store object key and server-observed size/mime in Mongo. Prefer BFF-issued signed download URLs rather than an R2 public bucket URL for private message media.
- Failed media transfer should not discard the text message or kill the WhatsApp event loop. Emit the inbound event with media absent or a structured media-error state, depending on the BFF contract.

## Development storage: Cloudflare R2, not MinIO

Local development uses the real Cloudflare R2 bucket through its S3-compatible API. Do not add a MinIO service, a local S3 emulator, or environment switching between them.

### Required environment contract

Use the same unprefixed, server-only variables in the Go worker and Next.js server code:

```text
R2_ACCOUNT_ID=<Cloudflare account ID>
R2_BUCKET=<existing R2 bucket name>
R2_ACCESS_KEY_ID=<R2 S3 API Access Key ID>
R2_SECRET_ACCESS_KEY=<R2 S3 API Secret Access Key>
```

Derive the normal endpoint as `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com` and set S3 region to `auto`. If the bucket has a jurisdiction, use the matching endpoint instead: `https://<ACCOUNT_ID>.eu.r2.cloudflarestorage.com`, `.us.`, or `.fedramp.`. Do not construct one client that mixes jurisdictional buckets; Cloudflare requires the matching endpoint for each jurisdiction.

Keep credentials in `.env.local` or the developer's secret manager, never in `.env.example`, `NEXT_PUBLIC_*`, browser JavaScript, Docker image layers, test fixtures, logs, or error messages. Create a bucket-scoped R2 API token with only the object permissions each service needs. Use a separate token for an administrative provisioning tool, not for the app or worker.

### Go worker: AWS SDK v2

The existing worker adapter already uses the correct basic shape: `s3.New` with static R2 credentials, `Region: "auto"`, and `BaseEndpoint` set to the account endpoint. Retain that model, but make all four required variables mandatory when media is enabled and reject incomplete configuration at startup.

- Use `BaseEndpoint` with the S3 client's default endpoint resolver, not AWS SDK v1 `EndpointResolver` or a custom immutable endpoint. AWS recommends the v2 endpoint path and specifically cautions against replacing S3's v2 resolver.
- Use `PutObject`, `GetObject`, `HeadObject`, and `DeleteObject` only as needed. R2 supports those operations, but do not assume AWS S3 ACLs, bucket policy APIs, object tags, or SSE-KMS behavior are available.
- Scope keys by tenant and session, validate key prefixes before all read/delete operations, send accurate `ContentType`, close every object body, and preserve bounded streaming and size limits from the media guidance above.

### Next.js: server-side S3 client and browser uploads

Create the Next S3 client only in server code, configured with the same endpoint, `region: "auto"`, and R2 credentials. Browser components must call a BFF route/action that authorizes tenant, session, key prefix, object type, and size before it signs a single-object operation.

- For browser upload/download, have the server generate short-lived `PutObject`/`GetObject` presigned URLs. Cloudflare documents that a presigned URL grants one operation on one object and is a bearer token until expiry.
- Sign `ContentType` on a PUT and require the browser to send exactly that header. Configure bucket CORS only for the explicit local and deployed BFF origins and only the required methods/headers. R2 presigned URLs work on the S3 API domain, not a custom domain.
- Store the resulting object key and server-observed metadata in Mongo. Keep the bucket private. Do not use `R2_PUBLIC_URL` as the normal media access path; user media should be read through a BFF-authorized short-lived URL.

### Launcher preflight

Before starting Next or Go, require all four R2 variables together when media is enabled. Validate that the account ID, bucket, and endpoint shape agree, and make a bounded authenticated `HeadBucket` or a scoped disposable-object operation against the real endpoint. Fail with the missing variable name or operation, never a secret. Do not run a destructive bucket-create, bucket-delete, or broad list operation as a development preflight.

### Remove old MinIO assumptions

- Remove `MINIO_*`, `S3_ENDPOINT=http://localhost...`, local access-key defaults, `S3_FORCE_PATH_STYLE` flags intended for MinIO, and any MinIO Compose service, volume, port, health check, or startup wait.
- Remove “create bucket locally” bootstrap behavior. The R2 bucket is pre-created and selected by `R2_BUCKET`.
- Remove public-local-bucket or unsigned localhost URL assumptions. Local apps reach the real HTTPS Cloudflare endpoint using private server credentials or a BFF-issued presigned URL.

Sources: [Cloudflare R2 S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/), [R2 authentication](https://developers.cloudflare.com/r2/api/tokens/), [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/), and [AWS SDK for Go v2 endpoint configuration](https://docs.aws.amazon.com/sdk-for-go/v2/developer-guide/configure-endpoints.html).

## Docker build convention

The reference uses a multi-stage Go Dockerfile: Debian-based Go builder, `go mod download` cached before source copy, stripped binary, then `debian:bookworm-slim` runtime with CA certificates. It has `development` and `production` targets, exposes `4000`, and mounts `/data` for SQLite auth.

CGO is enabled because `github.com/mattn/go-sqlite3` is used. Therefore the production image must provide compatible libc; the reference intentionally does not use `scratch` or static distroless. Retain a durable `/data` volume only if SQLite remains the auth store. If PostgreSQL becomes the auth store, remove the required SQLite volume and keep the runtime image as small as dependency requirements allow. Add a non-root runtime user, explicit health check, and `.dockerignore` in the new worker.

## GitHub Actions and GHCR convention

The reference deployment workflow triggers on `master` pushes and `v*` tags, grants `contents: read` and `packages: write`, logs into `ghcr.io` using `GITHUB_TOKEN`, derives branch/semver/SHA tags with `docker/metadata-action@v5`, and builds/pushes the worker with:

- context: `./services/whatsapp`
- Dockerfile: `./services/whatsapp/Dockerfile`
- target: `production`
- `docker/setup-buildx-action@v3` and `docker/build-push-action@v6`
- GitHub Actions layer cache (`type=gha`)

Mirror that job for the new worker image, using an image path such as `ghcr.io/${{ github.repository }}/whatsapp-worker`. Pin the workflow action majors consistently with the repository convention. Add a worker-specific CI job that runs `go test ./...` and `go vet ./...`; the reference CI only validates the web app, so it would not protect new Go code.

## Incompatibilities and required changes for MongoDB/R2

- **MySQL metadata is incompatible.** The reference `SessionStore` uses MySQL DSNs, `?` placeholders, `NOW()`, and a `whatsapp_sessions` table. Replace it with Mongo collections, indexes, atomic updates, and tenant scoping.
- **MongoDB is not a WhatsMeow auth-store backend in this reference.** `whatsmeow/sqlstore` is configured only for SQLite or PostgreSQL. Keep auth state in durable SQLite/PostgreSQL unless the upstream WhatsMeow version explicitly provides and supports a Mongo store.
- **The Redis event bus is not a Next BFF callback.** The reference relies on Redis Pub/Sub and intentionally swallows publish errors. Replace it with authenticated, durable callback delivery and retries; otherwise events are lossy and the BFF is coupled to Redis.
- **The SQLite deployment assumption is single-owner.** A mounted local `/data/whatsmeow.db` cannot safely back multiple independent worker replicas. Use sticky routing/leases or PostgreSQL auth storage.
- **R2 public URLs may be incompatible with private conversation media.** The reference optionally exposes a public URL and has no size/streaming protection. Use private objects plus BFF-issued signed URLs and enforce transfer limits.
- **The static worker secret is insufficient as a production service boundary.** Replace the local convenience secret/default with enforced runtime secrets and signed or mutually authenticated service requests.

## Joined groups and group names: exact WhatsMeow APIs

The installed module version is `go.mau.fi/whatsmeow v0.0.0-20260516102357-8d3700152a69`, taken from the source worker's `go.mod`. The APIs below were verified against that exact local module cache, not inferred from an older example.

| Need | Exact API | Result / notes |
| --- | --- | --- |
| List groups joined by the linked account | `client.GetJoinedGroups(ctx)` | Returns `([]*types.GroupInfo, error)`. Each entry includes `JID`, embedded `GroupName` (`Name`, `NameSetAt`, `NameSetBy`, `NameSetByPN`), topic, ownership, participants, and settings. |
| Refresh one group by ID | `client.GetGroupInfo(ctx, groupJID)` | Returns `(*types.GroupInfo, error)`. Pass a `types.JID` for the group, not a raw string. `types.GroupInfo.JID` is the canonical `@g.us` group ID to persist. |
| Rename a group | `client.SetGroupName(ctx, groupJID, name)` | Returns `error`. It updates the WhatsApp group subject. Validate against the product's chosen name policy and surface WhatsApp's error. The module documents a 25-character limit for `CreateGroup`, not explicitly for `SetGroupName`. |
| Update the description, not the name | `client.SetGroupTopic(ctx, groupJID, previousID, newID, topic)` | Returns `error`. Empty `previousID` causes the client to call `GetGroupInfo`; empty `newID` causes it to generate a message ID. This is not the rename API. |
| Receive external group-name changes | `*events.GroupInfo` in the registered event handler | `event.JID` identifies the group; `event.Name` is a non-nil `*types.GroupName` only for a name change. `*events.JoinedGroup` embeds a full `types.GroupInfo` for newly joined/created groups. |

### Source evidence

- `group.go:502-545` implements `GetJoinedGroups`. It sends the WhatsApp `participating` group query, parses each `group` response into `*types.GroupInfo`, and returns the list. It also updates internal LID/contact mappings, so callers should use the returned values rather than reconstructing group IDs.
- `group.go:590-656` exposes `GetGroupInfo(ctx, jid)`, performs a `query` against the supplied group JID, maps not-found and forbidden responses to `ErrGroupNotFound` and `ErrNotInGroup`, parses the result, and refreshes the group cache.
- `types/group.go:20-50` defines `types.GroupInfo`: `JID` is the group ID, and embedded `GroupName` supplies `Name` plus name-set metadata. `group.go:705-713` confirms that the JID comes from the server's `id` attribute and the name from `subject`.
- `group.go:323-330` implements `SetGroupName` by issuing a `subject` update to the supplied group JID. `types/events/events.go:447-489` defines `JoinedGroup` and `GroupInfo`, including `GroupInfo.Name`.

### Worker design

Persist a tenant-scoped group projection in MongoDB:

```text
{ tenantId, sessionId, groupJid, name, nameSetAt, nameSetBy, syncedAt }
```

Use `{ tenantId: 1, sessionId: 1, groupJid: 1 }` as a unique index. On initial sync, call `GetJoinedGroups`, upsert every returned group by canonical `GroupInfo.JID.String()`, and mark only groups absent from a completed sync as no longer joined. Do not derive a group ID from its name, names are mutable and non-unique.

On a `*events.JoinedGroup`, upsert its embedded `GroupInfo`; on `*events.GroupInfo` with `Name != nil`, atomically update only `name`, `nameSetAt`, and name-setter fields for `event.JID`. Before a BFF-triggered rename, verify the session owns the requested tenant/group mapping, call `SetGroupName`, then refresh with `GetGroupInfo` or wait for the authoritative `GroupInfo` event before declaring the Mongo projection current. Do not write the requested name as confirmed merely because the mutation returned nil.

### TDD seams and proof plan

Keep WhatsMeow behind a narrow adapter used by the group application service:

```go
type GroupGateway interface {
    GetJoinedGroups(context.Context) ([]*types.GroupInfo, error)
    GetGroupInfo(context.Context, types.JID) (*types.GroupInfo, error)
    SetGroupName(context.Context, types.JID, string) error
}
```

Keep the Mongo group repository and BFF event publisher as separate interfaces. This lets service tests use behavior-oriented fakes without mocking WhatsMeow internals. Follow a vertical red-green-refactor sequence:

1. Write a failing sync test: two returned `GroupInfo` values are upserted under the caller's tenant/session with their canonical JIDs and names. Implement only that sync path, then rerun green.
2. Write a failing test that an external `events.GroupInfo{Name: ...}` updates the stored name for its exact JID and cannot update another tenant/session. Implement the event projection, then rerun green.
3. Write a failing rename test: a group not owned by the caller never reaches `SetGroupName`; an owned group calls it with the stored canonical JID and triggers a refresh/event-pending state. Implement the authorization and mutation path, then rerun green.
4. Write error tests one at a time for `ErrNotInGroup`, a failed rename, and a partial list failure. Assert observable BFF responses and that a failed sync never marks groups absent.

The test suite proves the worker's application logic and tenancy boundaries. It cannot prove WhatsApp server behavior. Add a separately gated integration smoke test against a dedicated linked WhatsApp test account: list joined groups, compare returned `JID`/name with `GetGroupInfo`, rename a disposable test group, wait for the name-change event or refresh, and restore the original name. Run it only with explicit test-account credentials, never in shared CI.

## Local development launcher patterns

### What the reference does

- `package.json` separates infrastructure from host processes: `docker:up` starts only MySQL, Redis, and Hindsight through `docker-compose.yml` plus `docker-compose.dev.yml`, then runs migrations. `dev` starts Vite, and `whatsapp:worker` starts Go from `services/whatsapp`.
- `docker-compose.dev.yml` publishes infrastructure on host ports (`3307`, `6380`, `8888`, `9999`) while the base compose file keeps them internal. It also has optional development overrides for running app/worker inside Docker, but the documented local path is two host terminals.
- `.env.example` makes host versus Compose addresses explicit: host app/worker use `localhost`, bridge-network services use their Compose names. It documents why related URLs must agree.
- The production installer uses `#!/usr/bin/env bash`, `set -euo pipefail`, an anchored repository root, and a bounded curl readiness loop. Its `docker:up` package script instead uses a fixed `sleep 3`, which is not a reliable readiness check.

### Recommendation for Group Butler

Create one explicit Bash launcher, for example `scripts/dev.sh`, with a thin package-script entry such as `dev:all`. Do not put process supervision, traps, or environment parsing in a long `package.json` shell one-liner.

1. Resolve the repository root from the script location, `cd` there, and use `#!/usr/bin/env bash` plus `set -euo pipefail`. Bash is deliberate here: arrays, PID tracking, and robust `trap` cleanup are not portable `sh` features. Do not advertise the launcher as POSIX `sh` compatible.
2. Start only development infrastructure with `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d <infra services>`. Keep Next and the Go worker on the host so their logs are immediate and their normal hot reload/debugger workflows work. Do not start production app/worker Compose services in this path.
3. Wait on actual health, not a guessed delay. Prefer `docker compose ... ps --format json` or `docker inspect` health status for services with healthchecks; poll each required TCP/HTTP endpoint with a finite timeout and an actionable failure message. Run migrations only after MongoDB is reachable, before starting Next/Go.
4. Start Next and Go as separate child processes, capture both PIDs, and prefix/retain their logs so interleaved output remains attributable. If either child exits unexpectedly, terminate the sibling and exit nonzero. `wait -n` is Bash-specific, another reason to make the shell requirement explicit.
5. Trap `INT`, `TERM`, and `EXIT`. The cleanup handler must send termination to only the child process groups it started, wait for them, and preserve the original exit status. Default cleanup must leave infra running for faster iteration; offer an explicit `--down` option to run `docker compose ... down` when requested.
6. Load one documented local environment file before launching both host processes. Next commonly loads `.env.local` itself, but Go does not, so choose one source of truth and pass it to both. Do not blindly `source` a developer-owned `.env`: that executes shell code. Use an env loader with dotenv parsing, or make the Bash launcher reject values that are not declarative `KEY=VALUE` entries and export parsed pairs safely.
7. Validate required local variables before starting children: Mongo connection string, worker/BFF URLs and distinct callback credentials, R2 settings when media is enabled, and non-development secrets where the worker refuses defaults. Print variable names and expected endpoint shapes, never values.

### Readable `.env.example` rules

- Put each variable in a short functional section: application/BFF, MongoDB, Go worker/auth, R2, optional integrations. State host-local defaults next to every URL and separately document Compose DNS equivalents.
- Include only safe local defaults and empty placeholders. Never put working credentials, production URLs, public R2 URLs, or a reusable worker secret in the example.
- Give each required value a one-line purpose and an exact local format. Keep coupled values adjacent, for example BFF origin, worker listen URL, BFF callback URL, and their separate credentials.
- Keep the file declarative: one `KEY=value` per line; no command substitutions, shell expansion, exports, YAML syntax, or quoted multiline values. This makes it readable and compatible with a safe loader.
- Mark optional features explicitly and state their disabled behavior, such as “leave all R2 variables empty to disable media persistence.” Do not mix local host port values with Compose service hostnames in the same default.

### Launcher verification plan

Before treating a launcher as complete, exercise it from a clean shell: missing required env fails before any process starts; infra starts and each dependency becomes healthy; migrations run once; Next and Go both receive the intended environment; killing either child stops the other without removing infra; Ctrl-C leaves no child processes; and `--down` removes only the launcher's development Compose stack. These are launcher behavior tests, not product-code tests.

## Cloudflare R2-only local development

Use the real Cloudflare R2 bucket locally. Do not add MinIO, a local S3 emulator, or an environment switch between local storage and R2.

### Server environment contract

```text
R2_ACCOUNT_ID=<Cloudflare account ID>
R2_BUCKET=<pre-created R2 bucket>
R2_ACCESS_KEY_ID=<R2 S3 API Access Key ID>
R2_SECRET_ACCESS_KEY=<R2 S3 API Secret Access Key>
```

Both the Go worker and Next.js server use these unprefixed, server-only variables. The normal endpoint is `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`; use S3 region `auto`. Jurisdictional buckets instead require the matching `.eu.`, `.us.`, or `.fedramp.` endpoint, with a separate client per jurisdiction.

Keep credentials only in `.env.local` or a developer secret manager. Never expose them through `NEXT_PUBLIC_*`, browser code, images, fixtures, logs, or `.env.example`. Use bucket-scoped R2 API tokens with only object permissions; use a separate admin token for provisioning.

### Go AWS SDK v2 and Next S3 client

- Go: configure `s3.New` or `s3.NewFromConfig` with `Region: "auto"`, static R2 API credentials, and `BaseEndpoint` set to the R2 account endpoint. Keep the default S3 v2 endpoint resolver; do not use SDK v1 `EndpointResolver` or a custom immutable resolver.
- Next: configure the S3 client in server-only code with the same values. Browser code calls an authorized BFF route/action, never R2 directly with credentials.
- The BFF validates tenant, session, key prefix, media type, and size before creating a short-lived one-object `PutObject` or `GetObject` presigned URL. Sign `ContentType` for PUT and require the browser to send it exactly. A presigned URL is a bearer token until it expires.
- Keep the bucket private. Store object key and server-observed metadata in Mongo. Use BFF-authorized presigned downloads instead of `R2_PUBLIC_URL` for message media. Presigned URLs must use the R2 S3 API domain, not a custom domain.
- R2 supports the needed object operations (`PutObject`, `GetObject`, `HeadObject`, `DeleteObject`), but do not assume AWS S3 ACLs, bucket-policy APIs, object tags, or SSE-KMS support.

### Launcher preflight and MinIO removal

When media is enabled, the dev launcher requires all four R2 variables together, checks the endpoint/account/bucket shape, and makes one bounded authenticated `HeadBucket` or scoped disposable-object check. It reports only the missing variable or failed operation, never a secret. Do not create/delete buckets or perform broad object listing as preflight.

Remove all MinIO assumptions: `MINIO_*`, `S3_ENDPOINT=http://localhost...`, local access-key defaults, MinIO-only `S3_FORCE_PATH_STYLE`, MinIO Compose service/volume/port/health wait, local bucket creation, and unsigned localhost object URLs. R2 buckets are pre-created and selected by `R2_BUCKET`.

Sources: [Cloudflare R2 S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/), [R2 authentication](https://developers.cloudflare.com/r2/api/tokens/), [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/), and [AWS SDK for Go v2 endpoint configuration](https://docs.aws.amazon.com/sdk-for-go/v2/developer-guide/configure-endpoints.html).
