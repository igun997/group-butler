import type { Db, Document, Filter } from "mongodb";
import { COLLECTIONS } from "../collections";

/**
 * The `media` subdocument of one message, as the dashboard displays it: the
 * worker/pipeline lifecycle plus what the row can be read as. `r2Key` is the
 * only field a presign needs (§11.4); it is `null` until bytes are stored.
 */
export interface MessageMediaRow {
  status: string;
  declaredType: string | null;
  r2Key: string | null;
  mime: string | null;
  fileName: string | null;
}

/** One R4 search hit on the wire: identity, ordering key, body and attachment. */
export interface MessageRow {
  waMessageId: string;
  instanceId: string;
  groupJid: string;
  senderJid: string;
  pushName: string;
  fromMe: boolean;
  timestamp: string | null;
  kind: string;
  text: string;
  media: MessageMediaRow;
}

/**
 * Every search always carries the `organizationId` the route read from the
 * verified session; there is no overload without it (assumption 2).
 */
export interface MessageSearchInput {
  organizationId: string;
  /** Free text: literal, escaped and bounded — never a pattern (§11.5). */
  query?: string;
  instanceId?: string;
  groupJid?: string;
  senderJid?: string;
  kind?: string;
  mediaStatus?: string;
  from?: Date;
  to?: Date;
  /** Clamped to `[1, MESSAGE_MAX_LIMIT]`. */
  limit?: number;
  /** An opaque `(timestamp, waMessageId)` key minted by `nextMessageCursor`. */
  cursor?: string;
}

/** A page with no `limit` is this big; the ceiling is `MESSAGE_MAX_LIMIT`. */
export const MESSAGE_DEFAULT_LIMIT = 50;

/**
 * The hard page ceiling. It is a constant, not a caller's wish: one request can
 * never ask for the whole collection, whatever `limit` says.
 */
export const MESSAGE_MAX_LIMIT = 200;

/** The query is quoted text, so it also has a bounded length. */
const MAX_QUERY_LENGTH = 256;

/** Thrown for a cursor the repository did not mint; the route maps it to a 400. */
export class InvalidMessageCursorError extends Error {
  constructor() {
    super("invalid message cursor");
    this.name = "InvalidMessageCursorError";
  }
}

/** A stored `messages` document, read only through the projection below. */
type MessageDoc = {
  waMessageId?: string;
  instanceId?: string;
  groupJid?: string;
  senderJid?: string;
  pushName?: string;
  fromMe?: boolean;
  timestamp?: Date;
  kind?: string;
  text?: string;
  media?: {
    status?: string;
    declaredType?: string;
    r2Key?: string;
    mime?: string;
    fileName?: string;
  };
};

/**
 * The newest first — `waMessageId` breaks a timestamp tie so the cursor has a
 * total order to walk, and so two rows can never swap between pages.
 */
const SORT = { timestamp: -1, waMessageId: -1 } as const;

/**
 * Never fetch `raw.message`: it is a truncated protobuf tree (up to
 * `RAW_JSON_MAX_BYTES`) and a page of them would be a payload nobody reads.
 */
const PROJECTION = {
  _id: 0,
  waMessageId: 1,
  instanceId: 1,
  groupJid: 1,
  senderJid: 1,
  pushName: 1,
  fromMe: 1,
  timestamp: 1,
  kind: 1,
  text: 1,
  "media.status": 1,
  "media.declaredType": 1,
  "media.r2Key": 1,
  "media.mime": 1,
  "media.fileName": 1,
} as const;

/** A user query is text, never a pattern; every metacharacter is quoted. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The page size one request is allowed to ask for: `[1, MESSAGE_MAX_LIMIT]`,
 * with the default for a missing or unparseable value.
 */
export function clampMessageLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return MESSAGE_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(value), 1), MESSAGE_MAX_LIMIT);
}

function toRow(doc: MessageDoc): MessageRow {
  const media = doc.media ?? {};
  return {
    waMessageId: doc.waMessageId ?? "",
    instanceId: doc.instanceId ?? "",
    groupJid: doc.groupJid ?? "",
    senderJid: doc.senderJid ?? "",
    pushName: doc.pushName ?? "",
    fromMe: doc.fromMe ?? false,
    timestamp:
      doc.timestamp instanceof Date && Number.isFinite(doc.timestamp.getTime())
        ? doc.timestamp.toISOString()
        : null,
    kind: doc.kind ?? "unknown",
    text: doc.text ?? "",
    media: {
      status: media.status ?? "none",
      declaredType: media.declaredType ?? null,
      r2Key: media.r2Key ?? null,
      mime: media.mime ?? null,
      fileName: media.fileName ?? null,
    },
  };
}

/** The opaque keyset of one row, safe to hand to a client as a cursor. */
export function encodeMessageCursor(row: MessageRow): string {
  return Buffer.from(JSON.stringify([row.timestamp, row.waMessageId]), "utf8").toString("base64url");
}

function decodeMessageCursor(cursor: string): { timestamp: Date; waMessageId: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidMessageCursorError();
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) throw new InvalidMessageCursorError();
  const [timestamp, waMessageId] = parsed as [unknown, unknown];
  if (typeof timestamp !== "string" || typeof waMessageId !== "string" || waMessageId === "") {
    throw new InvalidMessageCursorError();
  }
  const at = new Date(timestamp);
  if (!Number.isFinite(at.getTime())) throw new InvalidMessageCursorError();
  return { timestamp: at, waMessageId };
}

/**
 * The cursor for the next page, or `null` when this page is the last. Only a
 * full page can promise another one; a row without its ordering key cannot
 * carry a keyset at all, so it ends the walk rather than restarting it.
 */
export function nextMessageCursor(rows: MessageRow[], limit: number): string | null {
  if (rows.length < limit) return null;
  const last = rows[rows.length - 1];
  if (!last || last.timestamp === null) return null;
  return encodeMessageCursor(last);
}

/**
 * The tenant lookup, the §5.1 compound filters and the cursor predicate every
 * branch of a search shares. Nothing here is optional: `organizationId` is the
 * one term no caller can omit.
 */
function messageFilter(input: MessageSearchInput): Filter<Document> {
  const filter: Filter<Document> = { organizationId: input.organizationId };

  if (input.instanceId) filter.instanceId = input.instanceId;
  if (input.groupJid) filter.groupJid = input.groupJid;
  if (input.senderJid) filter.senderJid = input.senderJid;
  if (input.kind) filter.kind = input.kind;
  if (input.mediaStatus) filter["media.status"] = input.mediaStatus;

  const range: { $gte?: Date; $lte?: Date } = {};
  if (input.from) range.$gte = input.from;
  if (input.to) range.$lte = input.to;
  if (range.$gte || range.$lte) filter.timestamp = range;

  if (input.cursor) {
    const { timestamp, waMessageId } = decodeMessageCursor(input.cursor);
    filter.$and = [
      { $or: [{ timestamp: { $lt: timestamp } }, { timestamp, waMessageId: { $lt: waMessageId } }] },
    ];
  }
  return filter;
}

/**
 * R4: the dashboard's advanced search (§6.4) — one query over the folded search
 * text, the flattened raw tree and the media filename, narrowed by the §5.1
 * compound filters and walked by a keyset on `(timestamp, waMessageId)`.
 *
 * A free-text term is answered by two index-backed branches, because MongoDB
 * rejects `$text` inside `$or` (verified against the production index set):
 *
 * - the weighted `messages_text` index (`$text` over `text`, `rawSearch` and
 *   `media.fileName`), which is the token/ranked search §6.4 specifies;
 * - an anchored, escaped prefix over the case-folded `textSearch` field, backed
 *   by `messages_typeahead`, which is what keeps type-ahead working before a
 *   word is complete.
 *
 * The branches are unioned and de-duplicated here, then ordered and cut to the
 * page. Fetching `limit` rows from each branch is enough: any row in the global
 * top `limit` is within the top `limit` of every branch that contains it, so the
 * keyset cursor stays exact and no branch ever scans the collection.
 */
export async function searchMessages(db: Db, input: MessageSearchInput): Promise<MessageRow[]> {
  const limit = clampMessageLimit(input.limit);
  const filter = messageFilter(input);
  const messages = db.collection(COLLECTIONS.messages);

  const term = (input.query ?? "").trim().slice(0, MAX_QUERY_LENGTH);
  if (term === "") {
    const docs = await messages
      .find<MessageDoc>(filter, { projection: PROJECTION })
      .sort(SORT)
      .limit(limit)
      .toArray();
    return docs.map(toRow);
  }

  const typeahead = new RegExp(`^${escapeRegExp(term.toLowerCase())}`);
  const [byText, byTypeahead] = await Promise.all([
    messages
      .find<MessageDoc>({ ...filter, $text: { $search: term } }, { projection: PROJECTION })
      .sort(SORT)
      .limit(limit)
      .toArray(),
    messages
      .find<MessageDoc>({ ...filter, textSearch: typeahead }, { projection: PROJECTION })
      .sort(SORT)
      .limit(limit)
      .toArray(),
  ]);

  const byIdentity = new Map<string, MessageRow>();
  for (const doc of [...byText, ...byTypeahead]) {
    const row = toRow(doc);
    const identity = `${row.instanceId}\u0000${row.waMessageId}`;
    if (!byIdentity.has(identity)) byIdentity.set(identity, row);
  }
  return [...byIdentity.values()].sort(compareRows).slice(0, limit);
}

/** Newest first; a absent timestamp sorts last, `waMessageId` breaks the tie. */
function compareRows(left: MessageRow, right: MessageRow): number {
  const leftAt = left.timestamp ?? "";
  const rightAt = right.timestamp ?? "";
  if (leftAt !== rightAt) return leftAt < rightAt ? 1 : -1;
  if (left.waMessageId === right.waMessageId) return 0;
  return left.waMessageId < right.waMessageId ? 1 : -1;
}

/**
 * The stored R2 key of one message, or `null` when there is no such message in
 * this organisation, or it has no media.
 *
 * `waMessageId` is only unique within `(organizationId, instanceId)` — the
 * `uniq_message` index says so — so the instance is part of the identity, not a
 * filter: without it the same message id in another instance could select the
 * wrong object. Both the organisation and the instance come from the route's
 * verified inputs, which is what makes `/api/media/[messageId]/url` IDOR-safe.
 */
export async function messageMediaKey(
  db: Db,
  organizationId: string,
  instanceId: string,
  waMessageId: string,
): Promise<string | null> {
  const doc = await db
    .collection(COLLECTIONS.messages)
    .findOne<{ media?: { r2Key?: string } }>(
      { organizationId, instanceId, waMessageId },
      { projection: { _id: 0, "media.r2Key": 1 } },
    );
  const key = doc?.media?.r2Key;
  return typeof key === "string" && key !== "" ? key : null;
}
