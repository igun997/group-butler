import { Timestamp, type ChangeStream, type Db, type Document } from "mongodb";
import type { GroupUpdatedEvent } from "@butler/shared";
import { COLLECTIONS } from "../../../server/collections";
import { UnauthorizedError, requireOwner } from "../../../server/auth/owner";
import { getDb } from "../../../server/mongo";
import { toInstanceRow, type InstanceDoc } from "../../../server/repos/instances";
import { toMessageRow, type MessageDoc } from "../../../server/repos/messages";

/**
 * `GET /api/stream` — the one live channel (docs/architecture-draft.md §7.4,
 * docs/ui-decision.md §3.3 items 4–5).
 *
 * A database-level change stream watches the four collections the dashboard
 * shows and filters them by the session's `organizationId`, so one cursor and
 * one resume token cover all of them and a frame can never carry another
 * tenant's document. The token rides out as the SSE `id:`, which is what lets a
 * reconnecting client resume without replaying the day; the last delivered token
 * is also persisted per tenant in `streamCursors`, and is consumed as the resume
 * point when a connection presents no token of its own.
 *
 * Change streams need a replica set. When the deployment cannot provide one the
 * route answers `503 stream_unavailable` rather than holding an idle connection
 * open — the client's coordinator reads that as a failed stream and degrades to
 * its 3-second polling fallback, which is invisible by design (`R-V3`).
 */

/** The collections the dashboard tails. Their names come from the shared table. */
const WATCHED = [COLLECTIONS.messages, COLLECTIONS.groups, COLLECTIONS.sendRequests, COLLECTIONS.instances];

/** Keeps a proxy from closing an idle SSE connection. */
const SSE_HEARTBEAT_MS = 15_000;
/** A change stream can fire hard; the cursor is durable, not chatty. */
const CURSOR_SAVE_MS = 1_000;

export const dynamic = "force-dynamic";

interface ChangeStreamSupport {
  supported: boolean;
  /** The cluster time the probe ran at; a fresh stream starts from here. */
  startAt: Timestamp | null;
}

/**
 * A `Timestamp` as this module's own class. The driver's reply carries one, but
 * a bundler that loads two copies of the BSON runtime would defeat an
 * `instanceof` alone, and a mis-detected operation time silently drops changes.
 */
function asTimestamp(value: unknown): Timestamp | null {
  if (value instanceof Timestamp) return value;
  const candidate = value as { t?: unknown; i?: unknown } | null | undefined;
  if (candidate && typeof candidate.t === "number" && typeof candidate.i === "number") {
    return new Timestamp({ t: candidate.t, i: candidate.i });
  }
  return null;
}

/**
 * Whether this deployment can serve change streams at all. `hello` names a
 * replica set (`setName`) or a mongos (`msg: "isdbgrid"`); a standalone mongod
 * names neither, and `$changeStream` would fail on its first `next()`.
 *
 * The probe's `operationTime` is returned with the answer: anchoring a fresh
 * stream to it closes the gap between the probe and the aggregate being
 * established, so a change that lands while the client is still connecting is
 * not silently dropped. Mongo's `startAtOperationTime` is *inclusive*, so a
 * fresh connection may repeat the single most recent change; that is the safe
 * side of the trade (a repeat is idempotent, a gap is a stale view), and rows
 * are keyed by stable ids so a patch for one that is already applied is a no-op
 * (`R-V1`).
 */
async function changeStreamSupport(db: Db): Promise<ChangeStreamSupport> {
  try {
    const hello = await db.command({ hello: 1 });
    return {
      supported: typeof hello.setName === "string" || hello.msg === "isdbgrid",
      startAt: asTimestamp(hello.operationTime),
    };
  } catch {
    return { supported: false, startAt: null };
  }
}

interface StreamFrame {
  event: string;
  data: unknown;
}

/**
 * The subset of a change-stream document this route reads. The driver's
 * `ChangeStreamDocument` is a union that includes ops with no `ns` or
 * `fullDocument`; the `$match` below restricts the stream to four collections,
 * and every op on them carries these fields, so this is the whole vocabulary
 * the route depends on.
 */
type ChangeLike = {
  operationType: string;
  ns?: { coll?: string } | null;
  fullDocument?: Document | null;
  fullDocumentBeforeChange?: Document | null;
  updateDescription?: { updatedFields?: Document } | null;
  clusterTime?: unknown;
  _id?: unknown;
};

/**
 * This tenant's resume-token row (§5.1). The identity is the tenant, never one
 * row shared by everyone: two organisations must not resume from each other's
 * position, and `organizationId` is written alongside the token so the row says
 * which tenant it belongs to.
 */
function cursorId(organizationId: string): string {
  return `sse:${organizationId}`;
}

type StreamCursorDoc = {
  _id: string;
  organizationId?: string;
  resumeToken?: unknown;
  updatedAt?: Date;
};

function encodeResumeToken(token: unknown): string | null {
  if (!token || typeof token !== "object") return null;
  return Buffer.from(JSON.stringify(token), "utf8").toString("base64url");
}

function decodeResumeToken(value: string | null): unknown {
  if (!value) return undefined;
  try {
    const token: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    // A resume token is a BSON document. Anything else — a bare string, a list,
    // a number — is not one, and must not reach the server as a resume point.
    return typeof token === "object" && token !== null && !Array.isArray(token) ? token : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Go's zero `time.Time`, which the worker writes for a stamp WhatsApp never
 * gave it (§5.1). It means "no stamp", so it renders as `null`, never as a
 * year-one rename.
 */
const NO_STAMP_MS = new Date("0001-01-01T00:00:00Z").getTime();

function isoStamp(value: unknown): string | null {
  if (!(value instanceof Date)) return null;
  return Number.isFinite(value.getTime()) && value.getTime() > NO_STAMP_MS ? value.toISOString() : null;
}

/**
 * The §6.6.6 change vocabulary in a fixed order, so one stored mutation always
 * produces the same `changes` array whatever order Mongo happens to store the
 * fields in.
 */
const GROUP_CHANGES: readonly GroupUpdatedEvent["changes"][number][] = [
  "subject",
  "topic",
  "announce",
  "locked",
  "state",
  "participants",
];

/** Which stored `observed.*` field means which published change. */
const GROUP_CHANGE_BY_PATH: Record<string, GroupUpdatedEvent["changes"][number]> = {
  "observed.subject": "subject",
  "observed.topic": "topic",
  "observed.isAnnounce": "announce",
  "observed.isLocked": "locked",
  "observed.state": "state",
  "observed.participantCount": "participants",
};

type GroupDoc = {
  instanceId?: string;
  groupJid?: string;
  observed?: {
    subject?: string;
    state?: string;
    subjectUpdatedAt?: Date;
  };
};

/**
 * The normalized `group.updated` patch (§6.6.6): the same payload the worker
 * publishes, rebuilt from the stored document so the dashboard's live patch and
 * the read model can never disagree.
 *
 * `previousName` comes from the pre-image when the deployment enabled
 * change-stream pre/post images and is `null` otherwise — an unknown previous
 * name is stated as unknown rather than guessed.
 */
function groupEvent(change: ChangeLike): GroupUpdatedEvent {
  const document = (change.fullDocument ?? {}) as GroupDoc;
  const observed = document.observed ?? {};
  const before = (change.fullDocumentBeforeChange ?? null) as GroupDoc | null;

  const changedPaths =
    change.operationType === "update"
      ? Object.keys(change.updateDescription?.updatedFields ?? {})
      : Object.keys(observed).map((key) => `observed.${key}`);
  const changed = new Set<GroupUpdatedEvent["changes"][number]>();
  for (const path of changedPaths) {
    const mapped = GROUP_CHANGE_BY_PATH[path];
    if (mapped) changed.add(mapped);
  }
  const changes = GROUP_CHANGES.filter((change) => changed.has(change));

  const clusterTime = asTimestamp(change.clusterTime);
  return {
    type: "group.updated",
    instanceId: document.instanceId ?? "",
    groupJid: document.groupJid ?? "",
    changes,
    name: observed.subject ?? "",
    previousName: before?.observed?.subject ?? null,
    nameSetAt: isoStamp(observed.subjectUpdatedAt),
    state: (observed.state ?? "active") as GroupUpdatedEvent["state"],
    occurredAt: clusterTime ? new Date(clusterTime.t * 1000).toISOString() : new Date().toISOString(),
  };
}

/** The sends state machine's visible fields; the `sends` read model lands in Task 21. */
interface SendPatch {
  id: string;
  instanceId: string;
  groupJid: string;
  status: string;
  approval: string;
  dispatch: string;
  updatedAt: string | null;
}

type SendDoc = {
  _id?: unknown;
  instanceId?: string;
  groupJid?: string;
  status?: string;
  approval?: { state?: string };
  dispatch?: { errorClass?: string | null };
  updatedAt?: Date;
};

function sendPatch(document: SendDoc): SendPatch {
  return {
    id: String(document._id ?? ""),
    instanceId: document.instanceId ?? "",
    groupJid: document.groupJid ?? "",
    status: document.status ?? "draft",
    approval: document.approval?.state ?? "pending",
    dispatch: document.dispatch?.errorClass ?? "",
    updatedAt: isoStamp(document.updatedAt),
  };
}

/** One change as the dashboard's frame, or `null` for a change it does not show. */
function frameFor(change: ChangeLike): StreamFrame | null {
  switch (change.ns?.coll) {
    case COLLECTIONS.groups:
      return { event: "group.updated", data: groupEvent(change) };
    case COLLECTIONS.messages:
      return {
        event: change.operationType === "insert" ? "message.created" : "message.updated",
        data: toMessageRow((change.fullDocument ?? {}) as MessageDoc),
      };
    case COLLECTIONS.sendRequests:
      return { event: "send.updated", data: sendPatch((change.fullDocument ?? {}) as SendDoc) };
    case COLLECTIONS.instances:
      return { event: "instance.updated", data: toInstanceRow((change.fullDocument ?? {}) as InstanceDoc) };
    default:
      return null;
  }
}

function serializeFrame(id: string | null, frame: StreamFrame): string {
  const lines: string[] = [];
  if (id) lines.push(`id: ${id}`);
  lines.push(`event: ${frame.event}`, `data: ${JSON.stringify(frame.data)}`);
  return `${lines.join("\n")}\n\n`;
}

/**
 * Where this tenant's stream last delivered. It is the resume point for a
 * connection that presents no token of its own — a reloaded page, or a client
 * whose last event id is gone — so the connection catches up on the gap instead
 * of starting mid-change and dropping it.
 */
/**
 * The one answer for "this deployment cannot serve a live stream right now".
 * Every path that cannot open the channel — Mongo unreachable, no replica set,
 * a cursor read that fails — says the same thing, with the same `no-store`, so
 * a failure is never a framework error page and the client's degrade path has
 * exactly one shape to read.
 */
function streamUnavailable(): Response {
  return Response.json({ error: "stream_unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
}

async function readStreamCursor(db: Db, organizationId: string): Promise<unknown> {
  const cursor = await db
    .collection<StreamCursorDoc>(COLLECTIONS.streamCursors)
    .findOne({ _id: cursorId(organizationId) });
  return cursor?.resumeToken;
}

async function saveStreamCursor(db: Db, organizationId: string, resumeToken: unknown): Promise<void> {
  await db
    .collection<StreamCursorDoc>(COLLECTIONS.streamCursors)
    .updateOne(
      { _id: cursorId(organizationId) },
      { $set: { organizationId, resumeToken, updatedAt: new Date() } },
      { upsert: true },
    );
}

function openChangeStream(
  db: Db,
  organizationId: string,
  resume: unknown,
  startAt: Timestamp | null,
): ChangeStream<Document, ChangeLike> {
  const pipeline: Document[] = [
    {
      $match: {
        "ns.coll": { $in: WATCHED },
        "fullDocument.organizationId": organizationId,
      },
    },
  ];
  const options = {
    fullDocument: "updateLookup" as const,
    fullDocumentBeforeChange: "whenAvailable" as const,
    ...(resume ? { resumeAfter: resume } : startAt ? { startAtOperationTime: startAt } : {}),
  };
  return db.watch<Document, ChangeLike>(pipeline, options);
}

export async function GET(request: Request): Promise<Response> {
  let organizationId: string;
  try {
    ({ organizationId } = await requireOwner());
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
    return Response.json({ error: "unauthorized" }, { status: 401, headers: { "cache-control": "no-store" } });
  }

  let db: Db;
  let support: ChangeStreamSupport;
  try {
    db = await getDb();
    support = await changeStreamSupport(db);
  } catch {
    // Mongo is unreachable: there is no stream to serve, and holding a
    // connection open would only look healthy while delivering nothing.
    return streamUnavailable();
  }
  if (!support.supported) return streamUnavailable();

  // Resume precedence: the client's own token first — `Last-Event-ID` is what an
  // `EventSource` sends by itself, and `?resume=` is what the coordinator adds
  // when it opens a replacement source — and then this tenant's persisted
  // cursor, so a connection that presents neither still catches up on the gap
  // instead of starting past a change it never saw. Both are decoded the same
  // way, and a token that is not a token is `undefined` rather than a crash.
  const clientToken = decodeResumeToken(
    request.headers.get("last-event-id") ?? new URL(request.url).searchParams.get("resume"),
  );
  let persisted: unknown;
  if (clientToken === undefined) {
    try {
      persisted = await readStreamCursor(db, organizationId);
    } catch {
      // The cursor read is part of opening the channel: a failure here is the
      // same unavailable stream, not a 500 for the operator to decode.
      return streamUnavailable();
    }
  }
  const resume = clientToken ?? persisted;

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let changeStream: ChangeStream<Document, ChangeLike> | null = null;
      let pending: unknown;
      let savedAt = 0;

      const send = (chunk: string): void => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const onAbort = (): void => {
        closed = true;
        void changeStream?.close().catch(() => {});
      };
      request.signal.addEventListener("abort", onAbort);
      const heartbeat = setInterval(() => {
        if (!closed) send(": ping\n\n");
      }, SSE_HEARTBEAT_MS);

      send(": open\n\n");

      // A resume token minted by another deployment, or one whose oplog entry
      // is gone, must not kill the connection: it is retried once from the
      // current cluster time so the client keeps its stream. A stream that
      // breaks *after* delivering a frame is a different thing — the client's
      // own `Last-Event-ID` is a better resume point than a replay.
      let attempt = 0;
      let delivered = false;
      while (!closed && attempt < 2) {
        try {
          changeStream = openChangeStream(db, organizationId, attempt === 0 ? resume : undefined, support.startAt);
          for await (const change of changeStream) {
            if (closed) break;
            delivered = true;
            const token = encodeResumeToken(change._id);
            if (change._id) pending = change._id;
            const frame = frameFor(change);
            if (frame) send(serializeFrame(token, frame));
            if (pending && Date.now() - savedAt >= CURSOR_SAVE_MS) {
              savedAt = Date.now();
              await saveStreamCursor(db, organizationId, pending).catch(() => undefined);
            }
          }
          break;
        } catch {
          await changeStream?.close().catch(() => undefined);
          changeStream = null;
          if (closed) break;
          if (attempt === 0 && resume && !delivered) {
            attempt += 1;
            continue;
          }
          break;
        }
      }

      clearInterval(heartbeat);
      request.signal.removeEventListener("abort", onAbort);
      await changeStream?.close().catch(() => undefined);
      if (pending) await saveStreamCursor(db, organizationId, pending).catch(() => undefined);
      try {
        controller.close();
      } catch {
        // The client aborted first; there is nothing left to close.
      }
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
