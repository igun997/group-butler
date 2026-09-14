# Group Butler API contract

This reference describes the implemented Next.js BFF routes in `apps/web/src/app/api`. It is intended for a 1:1 UI mock or client implementation.

## Scope and transport

- Base path: `/api`.
- JSON responses use UTF-8 JSON unless the route is the SSE stream.
- Dates in responses are ISO 8601 / RFC 3339 strings. A field documented as `null` is deliberately nullable.
- Every route handler returns `Cache-Control: no-store`. The edge middleware's early `401` response is the only exception.
- `GET /api/health` and `POST /api/auth/login` are public. The edge middleware rejects a missing `butler_session` cookie on every other API path with `401 {"error":"unauthorized"}`.
- Every protected data and control-plane handler verifies the signed cookie. `POST /api/auth/logout` is the exception: after the edge cookie-presence gate it clears the cookie and records the configured owner, without deriving identity from the supplied cookie.
- Instance-scoped routes also verify that the instance belongs to the authenticated organization. A foreign or absent instance is `404`, never forwarded to the worker.

## Common error shape

Most application errors are:

```ts
type ApiError = {
  error: string;
  code?: string;
  groupJids?: string[];
};
```

`error` is suitable for an operator-facing fallback message. UI logic should branch on `code` where present, not on the message text.

Common codes:

| Code | Status | Meaning |
| --- | --- | --- |
| `invalid_request` | 400 | JSON body, schema, or a supplied value is invalid. |
| `invalid_cursor` | 400 | A message cursor was not minted by this API. |
| `not_found` | 404 | Resource is absent or outside the caller's organization. |
| `label_conflict` | 409 | An instance label already exists. |
| `invalid_state` | 409 | The requested transition is unavailable in the resource's current state. |
| `instance_offline` | 409 | The target WhatsApp instance is not connected. |
| `group_not_assigned` | 409 | The target group is not assigned to the selected instance. |
| `ambiguous_send` | 409 | A failed outbound send has ambiguous delivery and cannot be retried. |
| `store_error` | 502 | MongoDB could not atomically persist the requested mutation and audit entry. |
| `worker_unreachable` | 502 | The BFF could not contact the WhatsApp worker. |
| `group_sync_failed` | 502 | The worker could not complete group synchronization. |
| `stream_unavailable` | 503 | MongoDB change streams are unavailable. |
| `media_unavailable` | 503 | R2 presigning is not configured or available. |

Worker-proxied routes can additionally return `unauthorized`, `method_not_allowed`, `instance_cleanup_failed`, or `internal`, always as `{ error, code }` with a mapped `502` status. Do not expose raw worker errors in the UI.

## Shared response models

```ts
type InstanceStatus = "disconnected" | "pairing" | "connected" | "logged_out" | "error";
type PairingMode = "qr" | "code";
type GroupState = "active" | "left" | "deleted" | "suspended";
type GroupNameSource = "sync" | "event" | "fallback";

type InstanceSnapshot = {
  id: string;
  label: string;
  mode: PairingMode;
  status: InstanceStatus;
  phoneNumber?: string;
  botJid?: string;
  botLid?: string;
  pairingError?: string;
  qr?: string;
  pairingCode?: string;
  connectedAt?: string;
  lastSeenAt?: string;
  createdAt: string;
};

type InstanceConfig = {
  instanceId: string;
  groupJidWhitelist: string[];
};

type GroupSubjectEntry = {
  name: string;
  at: string | null;
  by: string | null;
};

type GroupMember = {
  jid: string;
  phoneJid: string;
  lid: string;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  displayName: string;
};

type Group = {
  groupJid: string;
  name: string;
  nameSource: GroupNameSource;
  nameSetAt: string | null;
  nameSetBy: string | null;
  participantCount: number;
  state: GroupState;
  assigned: boolean;
  whitelisted: boolean;
  lastActivityAt: string | null;
  messageCount: number;
  subjectHistoryCount: number;
  subjectHistory: GroupSubjectEntry[];
};

type InstanceGroup = Group & {
  instanceId: string;
  instanceLabel: string;
};

type MessageMedia = {
  status: string;
  declaredType: string | null;
  r2Key: string | null;
  mime: string | null;
  fileName: string | null;
  reason: string | null;
};

type Message = {
  waMessageId: string;
  instanceId: string;
  groupJid: string;
  senderJid: string;
  pushName: string;
  fromMe: boolean;
  timestamp: string | null;
  kind: string;
  text: string;
  media: MessageMedia;
};

type SendStatus =
  | "pending_approval"
  | "approved"
  | "scheduled"
  | "rejected"
  | "cancelled"
  | "sending"
  | "sent"
  | "failed";

type Send = {
  id: string;
  organizationId: string;
  instanceId: string;
  groupJid: string;
  text: string;
  idempotencyKey: string;
  status: SendStatus;
  scheduledFor: string;
  approval: {
    state: "pending" | "approved" | "rejected";
    approvedBy?: "owner";
    approvedAt?: string;
  };
  dispatch: {
    attempts: number;
    lockedAt: string | null;
    lockedBy: string | null;
    waMessageId: string | null;
    errorClass: string | null;
  };
  createdAt: string;
  updatedAt: string;
};
```

`Group.name` is never blank. When WhatsApp has no observed subject, the API returns a fallback name derived from the JID. `groupJidWhitelist: []` means the instance is configured but no group has been granted.

## Health and authentication

### `GET /api/health`

Public dependency probe. It returns `200` only when MongoDB and the worker are both healthy; otherwise `503`.

```ts
type Health = {
  ok: boolean;
  mongo: "ok" | "error";
  worker: { reachable: boolean; ok: boolean; error?: string };
};
```

### `POST /api/auth/login`

Request:

```json
{ "email": "owner@example.com", "password": "secret" }
```

Success, `200` and `Set-Cookie`:

```json
{ "authenticated": true, "email": "owner@example.com", "organizationId": "org_default" }
```

Failure contracts:

| Status | Response | Condition |
| --- | --- | --- |
| 401 | `{ "error": "Invalid credentials" }` | Invalid credentials or malformed login JSON/body. |
| 429 | `{ "error": "Too many attempts" }` | Rate limit reached. Includes `Retry-After` seconds. |
| 503 | `{ "error": "Cannot record the attempt" }` | Authentication audit record could not be written. |

### `POST /api/auth/logout`

Success, `200`:

```json
{ "authenticated": false }
```

The response clears `butler_session` with `Max-Age=0`. A failed audit write returns `503 { "error": "Cannot record the attempt" }` and does not clear the cookie.

### `GET /api/auth/session`

Success, `200`:

```json
{ "authenticated": true, "email": "owner@example.com", "organizationId": "org_default" }
```

No valid session, `401`:

```json
{ "authenticated": false }
```

## Instances

### `GET /api/instances`

Returns the worker's current snapshots:

```ts
{ instances: InstanceSnapshot[] }
```

### `POST /api/instances`

Creates an instance and starts pairing. Request fields are strict, extra fields are rejected:

```ts
{
  label: string;          // non-empty after trim
  mode: "qr" | "code";
  phoneNumber?: string;   // required when mode is "code"
}
```

Success is `201` with an `InstanceSnapshot`. Invalid input is `400` with `code: "invalid_request"`.

### `GET /api/instances/:id`

Returns the live worker `InstanceSnapshot` for an owned instance.

### `PATCH /api/instances/:id`

Replaces the BFF-owned group whitelist. Request fields are strict:

```ts
{
  groupJidWhitelist: string[]; // 0 to 500 distinct valid `...@g.us` JIDs
}
```

Success:

```ts
{ config: InstanceConfig }
```

The change is mirrored to each affected `Group.whitelisted` field atomically. Unknown JIDs return:

```json
{
  "error": "the whitelist names groups this instance does not have",
  "code": "invalid_request",
  "groupJids": ["...@g.us"]
}
```

### `DELETE /api/instances/:id`

Deletes the worker instance. Success:

```json
{ "ok": true }
```

### `GET /api/instances/:id/config`

Reads the BFF-owned configuration without contacting the worker:

```ts
{ config: InstanceConfig }
```

### `POST /api/instances/:id/pairing-code`

Requests a pairing code from the worker for a code-mode instance. Returns the updated `InstanceSnapshot`.

### `GET /api/instances/:id/groups`

Returns the stored group read model, including groups while the instance is offline:

```ts
{
  instanceId: string;
  syncedAt: string | null;
  groups: Group[];
}
```

Groups are ordered with assigned groups first, then most recently active.

### `POST /api/instances/:id/groups/sync`

Runs a full worker group synchronization. Success:

```ts
{
  ok: boolean;
  instanceId: string;
  durationMs: number;
  source: "connect" | "timer" | "manual" | "event" | "message";
  total: number;
  added: number;
  subjectUpdated: number;
  metadataUpdated: number;
  markedLeft: number;
  subjectRejected: number;
  unchanged: number;
}
```

## Groups

### `GET /api/groups`

Returns every group visible to the organization:

```ts
{ groups: InstanceGroup[] }
```

### `GET /api/groups/:groupJid?instance=:instanceId`

The `instance` query parameter is required. Success:

```ts
{ group: Group; instanceLabel: string; members: GroupMember[] }
```

A missing `instance` is `400 { "error": "instance_required" }`. An unknown group or foreign group is `404 { "error": "not_found" }`.

### `PATCH /api/groups/:groupJid`

Updates BFF-owned group configuration. Request fields are strict:

```ts
{
  assigned?: boolean;
  whitelisted?: boolean;
  instanceId?: string; // required only to disambiguate a JID shared by multiple instances
}
```

At least one of `assigned` or `whitelisted` is required. Success:

```ts
{ group: Group }
```

If a group JID exists under multiple owned instances and `instanceId` is absent, the result is `409` with `code: "invalid_request"`. Changing `whitelisted` atomically updates the owning instance's whitelist.

## Automatic owner-mention replies

`POST /api/internal/reply-jobs` is a worker-only callback. It requires
`Authorization: Bearer <REPLY_CALLBACK_SECRET>` and is intentionally excluded
from cookie authentication. The request is:

```ts
{ organizationId: string; instanceId: string; groupJid: string; waMessageId: string }
```

The BFF accepts the job only when the source message is in the stated group,
the group is assigned and whitelisted, and the sender's canonical phone JID is
listed in `organizations.config.autoReplyAuthorizedJids`. It retrieves context
only from that group, then creates one idempotent approved send with
`provenance.source: "owner_mention"` and `provenance.replyToMessageId`.

Every model call writes one `aiCalls` row, before the answer is decided and on
success and failure alike: `{ organizationId, instanceId, groupJid,
kind: "assistant", model, status: "ok" | "error", latencyMs, usage: {
inputTokens, outputTokens, totalTokens }, createdAt }`. A token figure is `null`
when the provider did not report it — never `0`, which would read as a free call.
The write is best-effort: a statistics row the database refused is logged, not
turned into a second model call or a 5xx.

The worker emits WhatsApp `composing` before delivery and `paused` after it
returns, including error paths.

### `GET /api/groups/:groupJid/messages?instanceId=:instanceId`

The `instanceId` query parameter is required. Success:

```ts
{ groupJid: string; messages: Message[]; nextCursor: string | null }
```

Optional query parameters:

| Parameter | Behavior |
| --- | --- |
| `q` | Literal text search. |
| `kinds` | Comma-separated message kinds. |
| `media` | Exact media status. |
| `limit` | Clamped to 1 through 200, default 50. |
| `cursor` | Opaque cursor from `nextCursor`. |

## Messages and media

### `GET /api/messages`

Global newest-first message search. Success:

```ts
{ messages: Message[]; nextCursor: string | null }
```

Optional query parameters:

| Parameter | Behavior |
| --- | --- |
| `q` | Literal text search. |
| `instanceId` | Narrows results to one instance. |
| `groupJid` | Narrows results to one group. |
| `kind` | Narrows results to one message kind. |
| `mediaStatus` | Narrows results to one media lifecycle status. |
| `from`, `to` | RFC 3339 timestamps. Invalid dates are ignored. |
| `limit` | Clamped to 1 through 200, default 50. |
| `cursor` | Opaque cursor from `nextCursor`. Invalid values are `400` with `code: "invalid_cursor"`. |

### `GET /api/messages/:messageId/raw?instance=:instanceId`

The `instance` query parameter is required. Success:

```ts
{ message: unknown; truncated: boolean; bytes: number }
```

`message` is stored data, not HTML. Render it as escaped text or JSON. Missing `instance` is `400 { "error": "instance_required" }`; an unavailable raw tree is `404 { "error": "not_found" }`.

### `GET /api/media/:messageId/url?instanceId=:instanceId`

The `instanceId` query parameter is required. Success:

```ts
{ url: string; expiresInSeconds: number }
```

This returns a short-lived private-object URL. Do not cache it. An absent media record, a key outside the caller's organization, and missing access all return `404 { "error": "not_found" }`.

## Outbound sends

### `GET /api/sends`

Returns up to 200 sends, newest first:

```ts
{ sends: Send[] }
```

### `POST /api/sends`

Creates or returns an idempotent send request. Request fields are strict:

```ts
{
  instanceId: string;       // 1 to 128 chars
  groupJid: string;         // ends in `@g.us`
  text: string;             // trimmed, 1 to 4096 chars
  idempotencyKey: string;   // 16 to 128 chars, `[A-Za-z0-9_-]`
}
```

Success is `201`:

```ts
{ send: Send }
```

Repeating the same `idempotencyKey` returns the already-stored send. The target instance must exist, be connected, and have the group assigned. Otherwise the route returns `404 not_found`, `409 group_not_assigned`, or `409 instance_offline`.

### `POST /api/sends/:id/approve`

Optionally schedules a pending or retryable failed send:

```ts
{ scheduledFor?: string } // RFC 3339 with explicit offset
```

An omitted body is valid. When supplied, `scheduledFor` must be at least 30 seconds in the future. Success:

```ts
{ send: Send }
```

A future time creates status `scheduled`; otherwise an approvable send has status `approved`. An already-sent, rejected, cancelled, or ambiguous send returns `409`.

### `POST /api/sends/:id/reject`

Rejects only a `pending_approval` send. Success:

```ts
{ send: Send }
```

### `POST /api/sends/:id/cancel`

Cancels only an `approved` or `scheduled` send. Success:

```ts
{ send: Send }
```

## Operations

### `GET /api/scheduler`

Proxies the worker's `GET /scheduler` behind the owner session, with
`Cache-Control: no-store`. It reports the scheduled loops this worker owns — the
worker declares each one with its interval as it starts and records a pass after
the work, so a loop that has not finished one yet appears with `lastRunAt: null`
rather than being absent.

```ts
{
  loops: Array<{
    name: string;              // "group-sync" | "media-janitor" | "send-dispatch"
    intervalMs: number;
    lastRunAt: string | null;  // null until the loop has completed a pass
    lastError: string;         // "" after a clean pass
    runs: number;              // completed passes since this worker started
  }>;
}
```

An unreachable worker is `502 { "error", "code": "worker_unreachable" }`; an
answer this dashboard cannot read is `502 { "error", "code": "internal" }`. The
usage read below does not depend on this route, so the two sections of the
operations page fail independently.

### Server read models (no HTTP route)

The usage half of the page is read through `apps/web/src/server/console.ts`,
because MongoDB owns the numbers and the page must render them while the worker
is down. `loadScheduler(): Promise<Loaded<LoopReport[]>>` wraps the route above,
and `loadUsage(organizationId)` returns:

```ts
type UsageDay = {
  day: string;                     // UTC calendar day, "YYYY-MM-DD"
  maxTokensPerDay: number | null;  // appSettings.ai.maxTokensPerDay; null when unconfigured
  recorded: boolean;               // whether anything at all was recorded
  instances: Array<{
    instanceId: string;
    label: string;
    recorded: boolean;             // a row of zeroes is not a day of work
    counters: {
      messagesIn: number;          // statsDaily.counters.messagesIn
      mediaStored: number;
      mediaUnparsed: number;
      sendsOk: number;             // statsDaily.counters.sendsSent
      sendsFailed: number;         // statsDaily.counters.sendsFailed
      receipts: number;
    };
    tokens: {
      calls: number;               // assistant aiCalls rows today
      inputTokens: number | null;  // null ⇔ the provider reported no figure
      outputTokens: number | null;
      totalTokens: number | null;
    };
  }>;
};
```

Loaders return values, never throws: `{ ok: true, data }` or
`{ ok: false, error }` with a fixed phrase. A row is the organisation's live
instances plus any instance that recorded usage today (a removal does not delete
today's work).

## Server-sent events

### `GET /api/stream`

Authenticated `text/event-stream` channel. The first frame is the comment `: open`; heartbeat comments `: ping` follow every 15 seconds. The server accepts a resume token from `Last-Event-ID`, then `?resume=`, then the stored organization cursor.

Frames use ordinary SSE syntax:

```text
id: <opaque resume token>
event: <event name>
data: <JSON payload>
```

Event contracts:

| Event | Payload |
| --- | --- |
| `group.updated` | `{ type: "group.updated", instanceId, groupJid, changes, name, previousName, nameSetAt, state, occurredAt }`, where `changes` contains any of `subject`, `topic`, `announce`, `locked`, `state`, `participants`. |
| `message.created` | `Message` |
| `message.updated` | `Message` |
| `send.updated` | `{ id, instanceId, groupJid, status, approval, dispatch, updatedAt }` |
| `instance.updated` | The stored instance runtime row. |

The stream needs MongoDB replica-set change streams. If the deployment cannot serve them, it returns `503 { "error": "stream_unavailable" }`. A UI should fall back to polling the regular GET routes.

## Client implementation checklist

1. Store no API response in shared cache. Treat all control-plane and media responses as live state.
2. Send credentials with browser requests: `credentials: "same-origin"`.
3. Use opaque message and SSE cursor values only as returned. Do not construct or decode them.
4. Scope group, raw-message, and media requests with their required instance parameter.
5. Present send transitions as a state machine: create `pending_approval`, approve to `approved` or `scheduled`, reject from pending, cancel from approved/scheduled, and never retry an ambiguous failure.
6. When `/api/stream` is unavailable or closes, poll the affected GET read models.
