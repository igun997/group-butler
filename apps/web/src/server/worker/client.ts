import type { GroupSyncSummary, InstanceList, InstanceSnapshot, SchedulerReport } from "@butler/shared";
import { GroupSyncSummarySchema, InstanceListSchema, InstanceSnapshotSchema, SchedulerReportSchema } from "@butler/shared";
import { z } from "zod";

/**
 * The BFF's client for the worker control plane (docs/architecture-draft.md
 * §6.5). Three properties are the reason this is a module rather than a `fetch`
 * in each route:
 *
 * 1. **One credential.** The bearer token is read from the server environment
 *    here and never appears in a route, a log, or an answer to the browser.
 * 2. **Bounded.** Every call has a deadline and a size cap, so a hung or
 *    pathological worker cannot hold a dashboard request or this process's
 *    memory.
 * 3. **Contract-checked.** Every answer is parsed through the shared zod schema
 *    (§6.7), so a drift between the Go structs and the dashboard fails here
 *    instead of surfacing as `undefined` fields in the UI. Nothing the worker
 *    sends is forwarded to the browser unchecked.
 */

/**
 * The §6.5 stable error codes, plus the two this layer answers with itself.
 * `worker_unreachable` means the worker could not be reached at all;
 * `internal` means it answered something this dashboard cannot use, including a
 * code it does not know. The group-maintenance codes are the worker's own
 * answers to a refused `POST …/groups/{groupJid}/admin`: a group it cannot see,
 * a bot that is not an admin, and the two refusals WhatsApp itself hands back.
 */
export type WorkerErrorCode =
  | "invalid_request"
  | "not_found"
  | "label_conflict"
  | "invalid_state"
  | "instance_offline"
  | "unauthorized"
  | "method_not_allowed"
  | "instance_cleanup_failed"
  | "group_sync_failed"
  | "group_not_found"
  | "not_admin"
  | "group_admin_failed"
  | "revoke_failed"
  | "internal"
  | "worker_unreachable";

/**
 * One failed worker call, already translated into the answer the browser gets:
 * `status` is the BFF's own, `code` is the vocabulary the dashboard maps to UI
 * copy, and `message` is a fixed phrase. The worker's own error text never
 * reaches the browser (§6.5), because it can carry internals — a Mongo error, an
 * address, a JID.
 */
export interface WorkerFailure {
  status: number;
  code: WorkerErrorCode;
  message: string;
}

/** A call's outcome. Failures are values, so a route cannot forget to map one. */
export type WorkerResult<T> = { ok: true; data: T } | { ok: false; failure: WorkerFailure };

/**
 * The minimum a response schema has to offer. Structural rather than a zod
 * type, so the shared package's schemas are accepted whatever zod version it
 * pins, and this module needs no opinion about them beyond `parse`.
 */
export interface WorkerSchema<T> {
  parse(value: unknown): T;
}

/** A control call is short; a hung worker must not hold a dashboard request open. */
export const WORKER_TIMEOUT_MS = 5_000;

/**
 * A manual sync is a live `GetJoinedGroups` round trip plus reconciliation
 * (§6.6.6), which is legitimately slower than a read of stored state.
 */
export const WORKER_SYNC_TIMEOUT_MS = 30_000;

/**
 * The largest worker answer this process will buffer. The documented payloads
 * are a few kilobytes — a QR data URL is the largest at a few tens — so this is
 * two orders of magnitude of headroom, not a tuned limit.
 */
export const WORKER_BODY_MAX_BYTES = 256 * 1024;

/** An answer this dashboard cannot use is an upstream fault, in one phrase. */
const UPSTREAM_FAILURE: WorkerFailure = {
  status: 502,
  code: "internal",
  message: "the WhatsApp service failed to answer",
};

/** A sync that did not complete: the one failure the transport also detects. */
const SYNC_FAILURE: WorkerFailure = {
  status: 502,
  code: "group_sync_failed",
  message: "the group sync failed",
};

/**
 * Every documented worker code, with the status and the fixed phrase the BFF
 * answers. Worker statuses are not passed through: a 401 from the worker is
 * this deployment's misconfiguration, not the browser's, so it is a gateway
 * failure here.
 */
const WORKER_FAILURES: Readonly<Record<string, WorkerFailure>> = {
  invalid_request: { status: 400, code: "invalid_request", message: "the WhatsApp service rejected this request" },
  not_found: { status: 404, code: "not_found", message: "not found" },
  label_conflict: { status: 409, code: "label_conflict", message: "an instance with that label already exists" },
  invalid_state: { status: 409, code: "invalid_state", message: "the instance is not in a state that allows this" },
  instance_offline: { status: 409, code: "instance_offline", message: "the instance has no live WhatsApp session" },
  unauthorized: {
    status: 502,
    code: "unauthorized",
    message: "the WhatsApp service refused this server's credentials",
  },
  method_not_allowed: {
    status: 502,
    code: "method_not_allowed",
    message: "the WhatsApp service does not offer this operation",
  },
  instance_cleanup_failed: { status: 502, code: "instance_cleanup_failed", message: "the instance could not be removed" },
  group_sync_failed: SYNC_FAILURE,
  // A group the worker cannot address at all is the browser's 404; a bot that
  // is not an admin is a 403 the console explains as "give the bot admin
  // rights"; the two WhatsApp refusals are upstream faults, not the caller's.
  group_not_found: { status: 404, code: "group_not_found", message: "the group could not be found" },
  not_admin: { status: 403, code: "not_admin", message: "the bot is not an administrator of this group" },
  group_admin_failed: { status: 502, code: "group_admin_failed", message: "the WhatsApp service refused this group change" },
  revoke_failed: { status: 502, code: "revoke_failed", message: "the message could not be revoked" },
  internal: UPSTREAM_FAILURE,
};

function unreachable(message: string): WorkerResult<never> {
  return { ok: false, failure: { status: 502, code: "worker_unreachable", message } };
}

/** `WORKER_URL` and `WORKER_SECRET` as this container sees them (§7.7). */
function workerConfig(): { url: URL; secret: string } | null {
  const raw = process.env.WORKER_URL?.trim();
  const secret = process.env.WORKER_SECRET?.trim();
  if (!raw || !secret) return null;
  let url: URL;
  try {
    url = new URL(raw.endsWith("/") ? raw : `${raw}/`);
  } catch {
    return null;
  }
  return { url, secret };
}

export interface WorkerCall<T> {
  /**
   * Route segments under `WORKER_URL`. They are percent-encoded here, so an id
   * taken from a URL segment cannot escape the route it is meant to address.
   */
  segments: string[];
  schema: WorkerSchema<T>;
  method?: "GET" | "POST" | "DELETE";
  /** JSON body; `omitempty`-style, so `undefined` sends none. */
  body?: unknown;
  timeoutMs?: number;
}

/**
 * One call to the control plane. The result is never thrown: a transport
 * failure, a deadline, an unreadable answer and a documented worker error are
 * all values a route maps with `workerFailureResponse`.
 */
export async function callWorker<T>(call: WorkerCall<T>): Promise<WorkerResult<T>> {
  const config = workerConfig();
  if (!config) return unreachable("the WhatsApp service address is not configured");

  const target = new URL(call.segments.map(encodeURIComponent).join("/"), config.url);
  let response: Response;
  try {
    response = await fetch(target, {
      method: call.method ?? "GET",
      headers: {
        authorization: `Bearer ${config.secret}`,
        accept: "application/json",
        ...(call.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: call.body === undefined ? undefined : JSON.stringify(call.body),
      cache: "no-store",
      // A redirect is refused rather than followed: the bearer token must never
      // travel to a host that the worker's own answer names.
      redirect: "manual",
      signal: AbortSignal.timeout(call.timeoutMs ?? WORKER_TIMEOUT_MS),
    });
  } catch {
    // A refused connection, a DNS failure and the deadline all land here; the
    // distinction is not one the dashboard can act on differently.
    return unreachable("the WhatsApp service did not answer");
  }

  let text: string | null;
  try {
    text = await readBounded(response);
  } catch {
    // The answer never finished arriving: a reset connection or a truncated
    // body fails the read, and the deadline can fire here too. That is the same
    // loss as a request that never connected, so it answers with the same safe
    // failure rather than letting a transport error escape as a 500.
    return unreachable("the WhatsApp service did not answer");
  }
  if (text === null) return { ok: false, failure: UPSTREAM_FAILURE };
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = undefined;
  }

  if (response.status >= 300 && response.status < 400) {
    return unreachable("the WhatsApp service answered with a redirect");
  }
  if (!response.ok) {
    return { ok: false, failure: workerFailureFor(payload) };
  }
  if (payload === undefined) return { ok: false, failure: UPSTREAM_FAILURE };

  try {
    return { ok: true, data: call.schema.parse(payload) };
  } catch {
    return { ok: false, failure: UPSTREAM_FAILURE };
  }
}

/** Reads at most `WORKER_BODY_MAX_BYTES`, or `null` when the answer is larger. */
async function readBounded(response: Response): Promise<string | null> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > WORKER_BODY_MAX_BYTES) return null;
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

/**
 * The `{ error, code }` body of a failed worker call (§6.5), reduced to the
 * fixed phrase for its code. An unknown code, a missing code and an unreadable
 * body all answer as `internal`: the browser is told the classification it can
 * act on and nothing about what the worker said.
 */
function workerFailureFor(payload: unknown): WorkerFailure {
  const code = (payload as { code?: unknown } | null)?.code;
  if (typeof code !== "string") return UPSTREAM_FAILURE;
  return WORKER_FAILURES[code] ?? UPSTREAM_FAILURE;
}

/**
 * The browser-facing answer for a failed call. `no-store` for the same reason
 * every authenticated answer here is: nothing about this deployment's worker may
 * be cached by a shared cache.
 */
export function workerFailureResponse(failure: WorkerFailure): Response {
  return Response.json(
    { error: failure.message, code: failure.code },
    { status: failure.status, headers: { "cache-control": "no-store" } },
  );
}

/** `GET /instances` (§6.5): every instance's live session snapshot. */
export function listWorkerInstances(): Promise<WorkerResult<InstanceList>> {
  return callWorker({ segments: ["instances"], schema: InstanceListSchema });
}

/**
 * `GET /scheduler` (§6.5): the cadence and last outcome of each loop this worker
 * runs. It answers from the loop registry rather than from stored state, so a
 * worker with no loop started yet answers an empty list rather than an error.
 */
export function getWorkerScheduler(): Promise<WorkerResult<SchedulerReport>> {
  return callWorker({ segments: ["scheduler"], schema: SchedulerReportSchema });
}

/** `POST /instances` (§6.5): create the row and begin pairing. */
export const CreateInstanceRequestSchema = z
  .strictObject({
    label: z.string().trim().min(1),
    mode: z.enum(["qr", "code"]),
    phoneNumber: z.string().trim().min(1).optional(),
  })
  // The worker's own rule (`createInstanceRequest.validate`): code pairing needs
  // a number to text the code to. Refused here so the browser gets a 400 it can
  // explain rather than a worker round trip that fails the same way.
  .refine((body) => body.mode !== "code" || body.phoneNumber !== undefined, {
    message: "phoneNumber is required for code pairing",
    path: ["phoneNumber"],
  });

export type CreateInstanceRequest = z.infer<typeof CreateInstanceRequestSchema>;

export function createWorkerInstance(body: CreateInstanceRequest): Promise<WorkerResult<InstanceSnapshot>> {
  return callWorker({ segments: ["instances"], method: "POST", body, schema: InstanceSnapshotSchema });
}

/** `GET /instances/{id}`: one snapshot, which the dashboard polls while pairing. */
export function getWorkerInstance(instanceId: string): Promise<WorkerResult<InstanceSnapshot>> {
  return callWorker({ segments: ["instances", instanceId], schema: InstanceSnapshotSchema });
}

/** The worker's `DELETE /instances/{id}` acknowledgement. */
const InstanceDeletedSchema = z.object({ ok: z.literal(true) });

/** `DELETE /instances/{id}`: logout, delete the device, soft-delete the row. */
export function deleteWorkerInstance(instanceId: string): Promise<WorkerResult<{ ok: true }>> {
  return callWorker({ segments: ["instances", instanceId], method: "DELETE", schema: InstanceDeletedSchema });
}

/** `POST /instances/{id}/pairing-code`: request a code for a `code`-mode instance. */
export function requestWorkerPairingCode(instanceId: string): Promise<WorkerResult<InstanceSnapshot>> {
  return callWorker({ segments: ["instances", instanceId, "pairing-code"], method: "POST", schema: InstanceSnapshotSchema });
}

/**
 * `POST /instances/{id}/pair`: put an instance that is not connected back into
 * pairing. The worker refuses with `invalid_state` when it is already connected,
 * and answers the current snapshot when it is already pairing, so the console
 * never has to decide which of those it is asking for.
 */
export function pairWorkerInstance(instanceId: string): Promise<WorkerResult<InstanceSnapshot>> {
  return callWorker({ segments: ["instances", instanceId, "pair"], method: "POST", schema: InstanceSnapshotSchema });
}

/**
 * `POST /instances/{id}/check`: verify the instance's real socket state, which
 * the worker repairs by reconnecting when the stored credential is still valid.
 * It is a live round trip, not a re-read of stored state, so a "Check now" that
 * finds a dead session changes the snapshot instead of reporting the stale one.
 */
export function checkWorkerInstance(instanceId: string): Promise<WorkerResult<InstanceSnapshot>> {
  return callWorker({ segments: ["instances", instanceId, "check"], method: "POST", schema: InstanceSnapshotSchema });
}

/** `POST /instances/{id}/groups/sync` (§6.6.6): a full sync, reported as it ran. */
export async function requestWorkerGroupSync(instanceId: string): Promise<WorkerResult<GroupSyncSummary>> {
  const result = await callWorker({
    segments: ["instances", instanceId, "groups", "sync"],
    method: "POST",
    schema: GroupSyncSummarySchema,
    timeoutMs: WORKER_SYNC_TIMEOUT_MS,
  });
  // A 200 whose own summary is not `ok` is not a completed sync, and the
  // dashboard acts on the counts: reporting it as a success would claim a
  // reconcile happened that the worker just said did not (§6.6.5). Failing
  // visibly is the only honest answer to a contradiction.
  if (result.ok && !result.data.ok) return { ok: false, failure: SYNC_FAILURE };
  return result;
}

/**
 * One group's live metadata, read from WhatsApp rather than from the stored
 * row: `botIsAdmin` is what says whether a staged group change can be performed
 * at all, and no stored field can answer it.
 */
export const WorkerGroupInfoSchema = z.object({
  ok: z.literal(true),
  groupJid: z.string().min(1),
  name: z.string(),
  topic: z.string(),
  isAnnounce: z.boolean(),
  isLocked: z.boolean(),
  participantCount: z.number().int().nonnegative(),
  botIsAdmin: z.boolean(),
  botIsSuperAdmin: z.boolean(),
});

export type WorkerGroupInfo = z.infer<typeof WorkerGroupInfoSchema>;

/** One member of a group. `displayName` is absent when WhatsApp supplies none. */
export const WorkerGroupParticipantSchema = z.object({
  jid: z.string().min(1),
  isAdmin: z.boolean(),
  isSuperAdmin: z.boolean(),
  displayName: z.string().optional(),
});

export type WorkerGroupParticipant = z.infer<typeof WorkerGroupParticipantSchema>;

export const WorkerGroupParticipantsSchema = z.object({
  ok: z.literal(true),
  groupJid: z.string().min(1),
  participants: z.array(WorkerGroupParticipantSchema),
});

export type WorkerGroupParticipants = z.infer<typeof WorkerGroupParticipantsSchema>;

/** `GET /instances/{id}/groups/{groupJid}/info`: the group's live metadata. */
export function getWorkerGroupInfo(instanceId: string, groupJid: string): Promise<WorkerResult<WorkerGroupInfo>> {
  return callWorker({
    segments: ["instances", instanceId, "groups", groupJid, "info"],
    schema: WorkerGroupInfoSchema,
  });
}

/** `GET /instances/{id}/groups/{groupJid}/participants`: who is in the group. */
export function getWorkerGroupParticipants(
  instanceId: string,
  groupJid: string,
): Promise<WorkerResult<WorkerGroupParticipants>> {
  return callWorker({
    segments: ["instances", instanceId, "groups", groupJid, "participants"],
    schema: WorkerGroupParticipantsSchema,
  });
}

/** What one `members` call did about one JID. `unreported` was not mentioned by
 * WhatsApp's answer, so it must not be read as done. */
const GroupAdminMemberResultSchema = z.object({
  jid: z.string().min(1),
  status: z.enum(["ok", "failed", "unreported"]),
  errorCode: z.number().int().optional(),
});

/**
 * The worker's `POST …/groups/{groupJid}/admin` body: its own action name and
 * that action's parameters, which are the staged row's `params` unchanged.
 *
 * One action per worker action, so the executor's `action` discriminator maps
 * onto exactly this vocabulary and nothing else.
 */
export type GroupAdminRequest =
  | { action: "rename"; name: string }
  | { action: "announce"; announce: boolean }
  | { action: "locked"; locked: boolean }
  | { action: "photo"; dataUrl: string }
  | { action: "members"; membership: "add" | "remove" | "promote" | "demote"; jids: string[] }
  | { action: "leave" }
  | { action: "revoke"; waMessageId: string };

/**
 * What the worker answered. `ok` is `false` for a `members` call that WhatsApp
 * did not confirm for every JID — a partial success, not a failed call, which is
 * why the per-JID `results` are what the caller records.
 */
export const WorkerGroupActionResultSchema = z.object({
  ok: z.boolean(),
  pictureId: z.string().optional(),
  revokeMessageId: z.string().optional(),
  results: z.array(GroupAdminMemberResultSchema).optional(),
  failed: z.array(z.string()).optional(),
});

export type WorkerGroupActionResult = z.infer<typeof WorkerGroupActionResultSchema>;

/**
 * `POST /instances/{id}/groups/{groupJid}/admin`: one destructive group change,
 * already approved by the owner. The standard control deadline applies: the
 * worker answers when WhatsApp has, and a call it cannot answer in time is
 * reported as unreachable rather than left hanging.
 */
export function runWorkerGroupAction(
  instanceId: string,
  groupJid: string,
  body: GroupAdminRequest,
): Promise<WorkerResult<WorkerGroupActionResult>> {
  return callWorker({
    segments: ["instances", instanceId, "groups", groupJid, "admin"],
    method: "POST",
    body,
    schema: WorkerGroupActionResultSchema,
    timeoutMs: WORKER_TIMEOUT_MS,
  });
}
