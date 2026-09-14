import {
  GroupNameSourceSchema,
  GroupStateSchema,
  GroupSyncSummarySchema,
  GroupUpdatedEventSchema,
  type GroupSyncSummary,
  type GroupUpdatedEvent,
} from "@butler/shared";
import { z } from "zod";
import { resourceCache, resourceKey, type StreamFrame } from "../../../resource";
import type { Scope } from "../../types";

/**
 * The groups view's read model and its one write seam (docs/ui-decision.md §4.2
 * R-V1/R-V2/R-V4, §4.5 R-X1; architecture-draft.md §7.5, §6.6.6).
 *
 * Everything here is between the wire and the panel, and it is deliberately not
 * a component: the wire rows are parsed here, so a drift between the BFF's read
 * model and this build fails as a declared error instead of as `undefined`
 * fields on screen; the one live patch is applied here, so the row, the header
 * and the scope's label all move from one frame in one pass; and the cache keys
 * are built here, so no component ever assembles one.
 *
 * Two rules shape the patch. **A frame that carries no name is not a rename**
 * (the worker never stores an empty subject: `apps/worker/groupdelta.go`
 * `applySubjectDelta`), so the name already on screen stays, which is what lets
 * a fallback name survive a state change and then resolve when a real one
 * arrives. **Server truth is rendered, never predicted** (§2.2 invariant 6):
 * a mutation's answer is what the row becomes, and a sync summary that says
 * `ok: false` is a failure however it was answered.
 */

/** The two reads this view declares, by id (§2.1: one descriptor ⇒ one cache entry). */
export const GROUPS_ALL = "groups.all";
export const GROUPS_INSTANCE = "groups.instance";

/**
 * The §7.5 wire row, as the BFF's read model answers it. `instanceId` and
 * `instanceLabel` are present only on the cross-instance read (`/api/groups`),
 * which is exactly what the global address needs to show each row's instance.
 *
 * The two closed vocabularies are read out of the shared schemas that own them
 * (`z.enum(schema.options)`) rather than restated: `@butler/shared` pins zod 3
 * while this app pins zod 4, so the shared schema is the value source and this
 * file's own `z` is the parser it is built with — one vocabulary, no cast, and
 * no chance of the list of states drifting from the worker's.
 */
const WireRowSchema = z.object({
  groupJid: z.string().min(1),
  name: z.string(),
  nameSource: z.enum(GroupNameSourceSchema.options),
  nameSetAt: z.string().nullable(),
  nameSetBy: z.string().nullable(),
  participantCount: z.number().int().nonnegative(),
  state: z.enum(GroupStateSchema.options),
  assigned: z.boolean(),
  whitelisted: z.boolean(),
  lastActivityAt: z.string().nullable(),
  messageCount: z.number().int().nonnegative(),
  subjectHistoryCount: z.number().int().nonnegative(),
  instanceId: z.string().min(1).optional(),
  instanceLabel: z.string().optional(),
});

const WirePageSchema = z.object({
  instanceId: z.string().min(1).optional(),
  syncedAt: z.string().nullable().optional(),
  groups: z.array(WireRowSchema),
});

export type GroupRow = z.infer<typeof WireRowSchema>;

/** What one groups read holds: the rows, and when the instance last synced. */
export interface GroupsData {
  readonly groups: readonly GroupRow[];
  readonly syncedAt: string | null;
}

/**
 * The one failure a read or a mutation throws: the server's own code, and
 * nothing else. The error map turns it into the copy, the surface, and the
 * retry the operator gets (§4.5 R-X1); a code nobody recognises still keeps the
 * raw code for the chip, because the alternative is a failure nobody can name.
 */
export class GroupsRequestError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "GroupsRequestError";
  }
}

/** The worker's rename-ring cap (`apps/worker/groupdelta.go` `subjectHistoryMax`). */
const SUBJECT_HISTORY_CAP = 20;

/** The stable code of an answer this build cannot read (§4.5: raw codes only). */
const UNREADABLE = "decode_error";

/** The server's own code for a failed answer, or the best one this build can name. */
async function failureCode(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    const code = (body as { code?: unknown } | null)?.code;
    if (typeof code === "string" && code.length > 0) return code;
  } catch {
    // The body was not JSON, so the status is the only evidence there is.
  }
  return response.status === 401 ? "unauthorized" : "unknown";
}

/** One request, with the two failures every call can have mapped to a code. */
async function readJson(input: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(input, {
    ...init,
    credentials: "same-origin",
    headers: { accept: "application/json", ...init.headers },
  });
  if (!response.ok) throw new GroupsRequestError(await failureCode(response));
  try {
    return await response.json();
  } catch {
    throw new GroupsRequestError(UNREADABLE);
  }
}

function parsePage(body: unknown): GroupsData {
  const parsed = WirePageSchema.safeParse(body);
  if (!parsed.success) throw new GroupsRequestError(UNREADABLE);
  return { groups: parsed.data.groups, syncedAt: parsed.data.syncedAt ?? null };
}

/** The cross-instance read of §7.5: every instance's groups, each row naming its own. */
export async function readAllGroups(): Promise<GroupsData> {
  return parsePage(await readJson("/api/groups"));
}

/** One instance's groups, read from Mongo so the table renders while it is offline. */
export async function readInstanceGroups(scope: Scope): Promise<GroupsData> {
  if (scope.kind !== "instance") throw new GroupsRequestError("invalid_request");
  return parsePage(await readJson(`/api/instances/${encodeURIComponent(scope.instanceId)}/groups`));
}

export interface GroupConfigPatch {
  readonly assigned?: boolean;
  readonly whitelisted?: boolean;
}

/**
 * Write one group's configuration — `assigned` and/or `whitelisted` — and return
 * the row the server now holds, so the panel shows the server's answer rather
 * than the one it asked for.
 */
export async function setGroupConfig(input: {
  groupJid: string;
  instanceId?: string;
  patch: GroupConfigPatch;
}): Promise<GroupRow> {
  const body: Record<string, unknown> = { ...input.patch };
  // The cross-instance read can see one JID on several instances; naming the
  // instance is what makes the write unambiguous there.
  if (input.instanceId !== undefined && input.instanceId !== "") body.instanceId = input.instanceId;

  const parsed = z
    .object({ group: WireRowSchema })
    .safeParse(
      await readJson(`/api/groups/${encodeURIComponent(input.groupJid)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  if (!parsed.success) throw new GroupsRequestError(UNREADABLE);
  return parsed.data.group;
}

/**
 * Ask the worker, through the BFF, to re-read the instance's groups. The answer
 * is the worker's own summary, so the counts on screen are the counts it
 * produced (§4.1 R-L5) — and a summary that reports `ok: false` is raised as a
 * failure rather than reported as a success.
 */
export async function syncInstanceGroups(scope: Scope): Promise<GroupSyncSummary> {
  if (scope.kind !== "instance") throw new GroupsRequestError("invalid_request");

  const parsed = GroupSyncSummarySchema.safeParse(
    await readJson(`/api/instances/${encodeURIComponent(scope.instanceId)}/groups/sync`, { method: "POST" }),
  );
  if (!parsed.success) throw new GroupsRequestError(UNREADABLE);
  if (!parsed.data.ok) throw new GroupsRequestError("group_sync_failed");
  return parsed.data;
}

/** The descriptor id a scope's groups read lives under. */
export function groupsResourceId(scope: Scope): string {
  return scope.kind === "instance" ? GROUPS_INSTANCE : GROUPS_ALL;
}

/** The cache key of that read: the address a patch or an invalidation names. */
export function groupsKey(scope: Scope): string {
  return resourceKey(groupsResourceId(scope), scope);
}

/**
 * Move a row the server just returned into the mounted read. The update is in
 * place and silent (R-V2): the operator's own action is reported by the toast
 * policy, and the row it produced is simply the row now on screen.
 */
export function applyGroupRow(scope: Scope, row: GroupRow, instanceId?: string): void {
  resourceCache.patch<GroupsData>(groupsKey(scope), (data) => {
    let moved = false;
    const groups = data.groups.map((existing) => {
      if (existing.groupJid !== row.groupJid) return existing;
      if (
        instanceId !== undefined &&
        existing.instanceId !== undefined &&
        existing.instanceId !== instanceId
      ) {
        return existing;
      }
      moved = true;
      // A merge, not a replacement: the write's answer carries the same §7.5 row
      // without the instance fields only the cross-instance read adds, and a
      // spread that does not name them leaves them where they were.
      return { ...existing, ...row };
    });
    return moved ? { ...data, groups } : data;
  });
}

/**
 * A sync changes every row, including the names of groups nothing has renamed
 * since; the two reads are marked stale so a mounted one re-reads silently and
 * a fallback name resolves against what the sync actually stored (R-V3: no bar,
 * no skeleton, no tier change).
 */
export function invalidateGroupsReads(): void {
  resourceCache.invalidate([GROUPS_ALL, GROUPS_INSTANCE]);
}

/** A rename as the header and the scope's own label read it (R-V4). */
export interface GroupRename {
  readonly scope: Scope;
  /** The group it happened to. The note names it, because a rename is only
   *  legible with its subject — at the global address, four rows can share one
   *  name. */
  readonly groupJid: string;
  readonly name: string;
  readonly previousName: string | null;
  readonly occurredAt: string;
}

/** One frame, read as the view reads it: the rows it moves, and the rename it states. */
export interface GroupUpdate {
  readonly data: GroupsData;
  /** Present when the frame moved a name: the header line and the scope label. */
  readonly renamed: GroupRename | null;
}

/**
 * One row after one frame. A frame that carries no name is not a rename, so the
 * name already on screen stays — a fallback included — and a name that did not
 * actually move (a resumed stream may repeat its last change) does not falsify
 * the provenance the sync recorded.
 */
function applyEvent(row: GroupRow, event: GroupUpdatedEvent): GroupRow {
  const named =
    event.changes.includes("subject") &&
    event.name.trim() !== "" &&
    (row.name !== event.name || row.nameSource === "fallback");
  if (!named && row.state === event.state) return row;

  const superseded = named && row.nameSource !== "fallback" && row.name !== event.name;
  return {
    ...row,
    name: named ? event.name : row.name,
    nameSource: named ? "event" : row.nameSource,
    nameSetAt: named ? event.nameSetAt : row.nameSetAt,
    // The published event names no renamer, so a live rename's "who" is unknown
    // until the next sync; keeping the previous one would attribute this name to
    // whoever set the last one (draft §5.1 `subjectSetBy`).
    nameSetBy: named ? null : row.nameSetBy,
    state: event.state,
    // The worker pushes exactly one history entry per real rename, onto a capped
    // ring (`applySubjectDelta`, `appendSubjectHistory`).
    subjectHistoryCount: superseded
      ? Math.min(row.subjectHistoryCount + 1, SUBJECT_HISTORY_CAP)
      : row.subjectHistoryCount,
  };
}

/**
 * Apply one `group.updated` frame to a cached page, in one pass (R-V4). Rows are
 * matched by their stable ids — the JID and, where the read carries one, the
 * instance — so a frame for another instance's group can never move this row
 * (R-V5), and a group this page does not hold still yields its rename, because
 * the scope's label is about the scope and not about this list.
 */
export function groupUpdate(data: GroupsData, frame: StreamFrame, scope: Scope): GroupUpdate {
  const parsed = GroupUpdatedEventSchema.safeParse(frame.data);
  if (!parsed.success) return { data, renamed: null };
  const event = parsed.data;
  if (scope.kind === "instance" && event.instanceId !== scope.instanceId) {
    return { data, renamed: null };
  }

  let moved = false;
  const groups = data.groups.map((row) => {
    if (row.groupJid !== event.groupJid) return row;
    if (row.instanceId !== undefined && row.instanceId !== event.instanceId) return row;
    const next = applyEvent(row, event);
    if (next !== row) moved = true;
    return next;
  });

  const renamed =
    event.changes.includes("subject") && event.name.trim() !== ""
      ? {
          scope: { kind: "group", instanceId: event.instanceId, groupJid: event.groupJid } satisfies Scope,
          groupJid: event.groupJid,
          name: event.name,
          previousName: event.previousName,
          occurredAt: event.occurredAt,
        }
      : null;

  return { data: moved ? { ...data, groups } : data, renamed };
}

/** A sync summary as one line, every figure the worker's own. */
export function syncSummaryLine(summary: GroupSyncSummary): string {
  return `${summary.total} groups read, ${summary.added} added, ${summary.subjectUpdated} renamed, ${summary.markedLeft} left`;
}
