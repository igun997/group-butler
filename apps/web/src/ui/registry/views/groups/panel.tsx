"use client";

import type { GroupSyncSummary } from "@butler/shared";
import { type ReactNode, useCallback, useId, useMemo, useState } from "react";
import { ErrorState } from "../../../../components/error-state";
import { LiveIndicator } from "../../../../components/live-indicator";
import { COMPACT_QUERY, useMediaQuery } from "../../../../components/media-query";
import { utcStamp } from "../../../../components/utc-stamp";
import { WorkspaceHeader } from "../../../../components/workspace-header";
import { useAction } from "../../../feedback";
import type { MappedError } from "../../../feedback";
import {
  ResourceGate,
  scopeLabels,
  scopeSegment,
  useStreamScope,
  type StreamBinding,
  type StreamFrame,
  type StreamTransport,
} from "../../../resource";
import type { PanelProps, ResourceDescriptor, Scope } from "../../types";
import { syncGroupsAction } from "./actions";
import { GroupsCards, GroupsTable, groupsColumns, rowKey, type GroupRowController, type GroupToggle } from "./columns";
import {
  applyGroupRow,
  groupUpdate,
  invalidateGroupsReads,
  setGroupConfig,
  syncSummaryLine,
  type GroupRename,
  type GroupRow,
  type GroupsData,
} from "./model";
import { allGroupsResource, instanceGroupsResource } from "./resources";

/**
 * The groups workspace (docs/ui-decision.md §4.1, §4.2, §4.7; draft §7.5).
 *
 * The read, the two row controls, the sync, and the live patch meet here, and
 * each arrives from where it belongs: the rows come through `ResourceGate`, so
 * the loading tier, the empty copy and the failure surface are the descriptor's
 * and never this component's; the operations go through `useAction`, so an
 * outcome is reported by the policy and a forbidden toast cannot be emitted from
 * here; and one `group.updated` frame is applied by one function that moves the
 * row, the group's own scope label, and this workspace's line in a single pass
 * (R-V4) without focusing, scrolling, or toasting (R-V1, R-V2).
 *
 * Controls appear only once the scope's data is known (R-L8): the header and its
 * `Sync now` are rendered with the rows, and the empty state carries its own way
 * out, so a cold or failed read offers no control that cannot yet mean anything.
 *
 * Every piece of state the panel holds is stamped with the scope it belongs to.
 * Two instances are two scopes, and one scope's summary, rename line, or pending
 * flag may never be read as the other's (R-V5).
 */

/** What a failed operation left behind when the toast could not carry it (R-X2). */
interface GroupsFailure {
  readonly error: MappedError;
  readonly retry: () => void;
}

interface GroupsSync {
  readonly pending: boolean;
  /** The worker's own summary of the last manual sync in this scope, or `null`. */
  readonly summary: GroupSyncSummary | null;
  readonly failure: GroupsFailure | null;
  run(): void;
}

/** One scope's sync state, so a stale scope's outcome is never read as the current one. */
interface SyncState {
  readonly pending: boolean;
  readonly summary: GroupSyncSummary | null;
  readonly failure: GroupsFailure | null;
}

interface GroupToggles {
  readonly controller: GroupRowController;
  readonly failure: GroupsFailure | null;
}

/** One scope's value, so a stale scope's state is never read as the current one. */
interface Scoped<T> {
  readonly scope: string;
  readonly value: T;
}

const NO_PENDING: ReadonlySet<string> = new Set<string>();

/**
 * What each toggle says: at rest, while its write is in flight (R-L9's label
 * change), and what the operation is called once it lands (R-T1's one toast).
 * The words are per direction, because "Assigned" and "Not assigned" are the two
 * states of one control and the operator reads the state, not the verb.
 */
const TOGGLE_COPY = {
  assigned: {
    on: { label: "Assigned", pending: "Assigning…", done: "Group assigned" },
    off: { label: "Not assigned", pending: "Unassigning…", done: "Group unassigned" },
  },
  whitelisted: {
    on: { label: "Whitelisted", pending: "Whitelisting…", done: "Group whitelisted" },
    off: { label: "Not whitelisted", pending: "Removing…", done: "Group removed from the whitelist" },
  },
} as const;

/** The two config fields this workspace toggles, and the action each announces itself as. */
const TOGGLE_ACTIONS = { assigned: "assign-group", whitelisted: "whitelist-group" } as const;

/** The failure a toast may not carry gets its own surface, with the call that made it (R-X2, R-X4). */
function failureOrNull(error: MappedError | undefined, retry: () => void): GroupsFailure | null {
  return error && error.toast !== "owns" ? { error, retry } : null;
}

/**
 * `Sync now`, as one operation (R-L5, R-L9). It runs the view's own declared
 * action through the one toast emitter, so the counts on screen are the ones the
 * worker returned rather than the ones the operator hoped for. It exists at an
 * instance scope only: a sync is one instance's, and the global address does not
 * name one.
 */
function useGroupsSync(scope: Scope): GroupsSync | null {
  const action = useAction();
  const scopeKey = scopeSegment(scope);
  const idle = useMemo<SyncState>(() => ({ pending: false, summary: null, failure: null }), []);
  const [state, setState] = useState<Scoped<SyncState>>({ scope: scopeKey, value: idle });

  // A scope change is another instance: the previous scope's outcome is not this
  // scope's state, and showing it here would report a sync that never ran.
  const current = state.scope === scopeKey ? state.value : idle;

  const run = useCallback(() => {
    if (scope.kind !== "instance" || current.pending) return;
    const instanceId = scope.instanceId;
    setState({ scope: scopeKey, value: { ...current, pending: true } });

    void action
      .run<GroupSyncSummary>({
        action: syncGroupsAction.id,
        targetId: instanceId,
        label: "Groups synced",
        pendingLabel: "Syncing groups…",
        detail: "The list and the names come from WhatsApp.",
        promise: () => syncGroupsAction.run({ scope, params: {}, action: syncGroupsAction.id }),
      })
      .then((outcome) => {
        setState({
          scope: scopeKey,
          value: {
            pending: false,
            summary: outcome.ok ? (outcome.data ?? current.summary) : current.summary,
            failure: outcome.ok ? null : failureOrNull(outcome.error, run),
          },
        });
        // A sync also moves names nothing has renamed since, so the read is
        // refetched silently (R-V3) and a fallback name resolves against what the
        // sync actually stored.
        if (outcome.ok) invalidateGroupsReads();
      });
  }, [action, current, scope, scopeKey]);

  if (scope.kind !== "instance") return null;
  return { ...current, run };
}

/**
 * The two row controls. Each write names the instance the row belongs to, and
 * the row becomes the row the server returned — never the value that was asked
 * for, because a config write is the server's to confirm (§2.2 invariant 6). A
 * failure leaves the row exactly as it was.
 */
function useGroupToggles(scope: Scope): GroupToggles {
  const action = useAction();
  const scopeKey = scopeSegment(scope);
  const [pending, setPending] = useState<Scoped<ReadonlySet<string>>>(() => ({ scope: scopeKey, value: NO_PENDING }));
  const [failure, setFailure] = useState<Scoped<GroupsFailure | null>>(() => ({ scope: scopeKey, value: null }));

  const pendingKeys = pending.scope === scopeKey ? pending.value : NO_PENDING;

  const markPending = useCallback(
    (key: string, value: boolean) => {
      setPending((current) => {
        const keys = new Set(current.scope === scopeKey ? current.value : NO_PENDING);
        if (value) keys.add(key);
        else keys.delete(key);
        return { scope: scopeKey, value: keys };
      });
    },
    [scopeKey],
  );

  const run = useCallback(
    (row: GroupRow, field: "assigned" | "whitelisted") => {
      const instanceId = row.instanceId ?? (scope.kind === "instance" ? scope.instanceId : undefined);
      const value = !row[field];
      const key = `${rowKey(row)}:${field}`;
      const copy = TOGGLE_COPY[field][value ? "on" : "off"];
      markPending(key, true);

      void action
        .run<GroupRow>({
          action: TOGGLE_ACTIONS[field],
          targetId: row.groupJid,
          label: copy.done,
          pendingLabel: copy.pending,
          detail: row.name,
          promise: () => setGroupConfig({ groupJid: row.groupJid, instanceId, patch: { [field]: value } }),
        })
        .then((outcome) => {
          markPending(key, false);
          if (!outcome.ok) {
            setFailure({ scope: scopeKey, value: failureOrNull(outcome.error, () => run(row, field)) });
            return;
          }
          setFailure({ scope: scopeKey, value: null });
          if (outcome.data) applyGroupRow(scope, outcome.data, instanceId);
        });
    },
    [action, markPending, scope, scopeKey],
  );

  const toggleFor = useCallback(
    (field: "assigned" | "whitelisted", row: GroupRow): GroupToggle => {
      const value = row[field];
      const copy = TOGGLE_COPY[field][value ? "on" : "off"];
      return {
        value,
        pending: pendingKeys.has(`${rowKey(row)}:${field}`),
        label: copy.label,
        pendingLabel: copy.pending,
        run: () => run(row, field),
      };
    },
    [pendingKeys, run],
  );

  const controller = useMemo<GroupRowController>(
    () => ({
      assigned: (row) => toggleFor("assigned", row),
      whitelisted: (row) => toggleFor("whitelisted", row),
    }),
    [toggleFor],
  );

  return { controller, failure: failure.scope === scopeKey ? failure.value : null };
}

/**
 * The same read, with its `no-data` way out bound to this scope's own sync
 * (R-E1: the empty state offers the action that creates data). Only `empty`
 * differs — the id, the key, the fetch, the live binding and the skeleton stay
 * the descriptor's, so this mount and its cache entry are still the read the
 * descriptor declared.
 */
function withSyncWayOut(
  resource: ResourceDescriptor<GroupsData, undefined>,
  sync: GroupsSync | null,
): ResourceDescriptor<GroupsData, undefined> {
  if (!sync) return resource;
  return {
    ...resource,
    empty: {
      ...resource.empty,
      "no-data": { ...resource.empty["no-data"], action: { label: "Sync now", run: sync.run } },
    },
  };
}

export function GroupsPanel({ scope }: PanelProps) {
  const resource = scope.kind === "instance" ? instanceGroupsResource : allGroupsResource;
  const sync = useGroupsSync(scope);
  const toggles = useGroupToggles(scope);
  const scopeKey = scopeSegment(scope);
  const headingId = useId();
  const [renamed, setRenamed] = useState<Scoped<GroupRename | null>>(() => ({ scope: scopeKey, value: null }));

  // R-V4: one frame, one pass. The row moves through the cache the gate renders
  // from, the group's own scope label moves with it, and this workspace's line
  // states what happened. Nothing here focuses, scrolls, or toasts (R-V1, R-V2).
  const apply = useCallback(
    (data: unknown, frame: StreamFrame) => {
      const update = groupUpdate(data as GroupsData, frame, scope);
      if (update.renamed) {
        scopeLabels.write(update.renamed.scope, update.renamed.name);
        setRenamed({ scope: scopeKey, value: update.renamed });
      }
      return update.data;
    },
    [scope, scopeKey],
  );

  const bindings = useMemo<readonly StreamBinding[]>(
    () => (resource.sse ? [{ binding: resource.sse, key: resource.key(scope, undefined), apply }] : []),
    [resource, scope, apply],
  );
  const transport = useStreamScope(scope, bindings);
  const bound = useMemo(() => withSyncWayOut(resource, sync), [resource, sync]);

  return (
    <section className="groups-workspace" aria-labelledby={headingId}>
      <ResourceGate resource={bound} scope={scope} emptyReason="no-data" label="Groups">
        {(view) =>
          view.data === undefined ? null : (
            <GroupsWorkspace
              headingId={headingId}
              scope={scope}
              data={view.data}
              transport={transport}
              sync={sync}
              failure={toggles.failure}
              controller={toggles.controller}
              renameNote={renamed.scope === scopeKey ? renamed.value : null}
            />
          )
        }
      </ResourceGate>
    </section>
  );
}

interface GroupsWorkspaceProps {
  headingId: string;
  scope: Scope;
  data: GroupsData;
  transport: StreamTransport;
  sync: GroupsSync | null;
  failure: GroupsFailure | null;
  controller: GroupRowController;
  renameNote: GroupRename | null;
}

/** The loaded workspace: what is in scope, what condition it is in, and the rows. */
function GroupsWorkspace({
  headingId,
  scope,
  data,
  transport,
  sync,
  failure,
  controller,
  renameNote,
}: GroupsWorkspaceProps) {
  const syncFailure = sync?.failure ?? null;
  const manual = sync?.summary ?? null;
  // Freshness is an instance's own fact: the cross-instance read answers with the
  // rows and no stamp, so the global address says nothing rather than claiming
  // the whole estate has never synced. A rename is stated wherever it happened,
  // because it is data that moved and not a notification (R-V2).
  const at = scope.kind === "instance" ? utcStamp(data.syncedAt) : null;
  const summary: ReactNode[] = [];
  if (scope.kind === "instance") {
    summary.push(
      <p key="sync-state" className="groups-sync-state">
        <span>{at === null ? "Never synced" : `Last sync ${at}`}</span>
        {manual === null ? null : (
          <span className="groups-sync-state__summary">
            {`Manual sync: ${syncSummaryLine(manual)} in ${manual.durationMs} ms`}
          </span>
        )}
      </p>,
    );
  }
  if (renameNote !== null) summary.push(<RenameLine key="rename" renamed={renameNote} />);

  return (
    <>
      <WorkspaceHeader
        headingId={headingId}
        heading="Groups"
        scope={scopeLine(scope, data)}
        live={<LiveIndicator transport={transport} />}
        summary={summary.length === 0 ? undefined : summary}
        actions={sync === null ? undefined : <SyncButton sync={sync} />}
      />
      {failure === null ? null : <ErrorState error={failure.error} onRetry={failure.retry} />}
      {syncFailure === null ? null : <ErrorState error={syncFailure.error} onRetry={syncFailure.retry} />}
      <GroupsRows scope={scope} data={data} controller={controller} />
    </>
  );
}

/** What the workspace is showing, in the terms the operator counts in. */
function scopeLine(scope: Scope, data: GroupsData): string {
  const count = data.groups.length;
  const groups = `${count} ${count === 1 ? "group" : "groups"}`;
  if (scope.kind !== "global") return `${groups} in this instance`;
  const instances = new Set(data.groups.map((row) => row.instanceId ?? row.groupJid));
  return `${groups} across ${instances.size} ${instances.size === 1 ? "instance" : "instances"}`;
}

/** A rename, as the workspace states it: in place, with no toast (R-T2, R-V4). */
function RenameLine({ renamed }: { renamed: GroupRename }) {
  const at = utcStamp(renamed.occurredAt);
  const sentence = renamed.previousName
    ? `Renamed: ${renamed.previousName} is now ${renamed.name}`
    : `Renamed to ${renamed.name}`;
  return (
    <p className="groups-rename-note">
      {`${sentence} · ${renamed.groupJid}${at === null ? "" : `, ${at}`}`}
    </p>
  );
}

function SyncButton({ sync }: { sync: GroupsSync }) {
  return (
    <button
      type="button"
      className="groups-sync"
      aria-busy={sync.pending ? true : undefined}
      disabled={sync.pending}
      onClick={sync.run}
    >
      <span className="groups-sync__glyph" aria-hidden="true">
        <svg
          viewBox="0 0 16 16"
          width="1em"
          height="1em"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M13.5 8a5.5 5.5 0 1 1-1.7-3.97" />
          <path d="M13.5 2.75V10h-1.4" />
        </svg>
      </span>
      <span>{sync.pending ? "Syncing…" : "Sync now"}</span>
    </button>
  );
}

/**
 * The rows, in the presentation this width calls for (R-M1). One of the two is
 * mounted, never both, so a row's controls exist once in the accessibility tree
 * however the viewport is measured.
 */
function GroupsRows({ scope, data, controller }: { scope: Scope; data: GroupsData; controller: GroupRowController }) {
  const compact = useMediaQuery(COMPACT_QUERY);
  const columns = useMemo(() => groupsColumns(scope), [scope]);
  const caption = scope.kind === "global" ? "Groups across every instance" : "Groups in this instance";

  return compact ? (
    <GroupsCards rows={data.groups} columns={columns} caption={caption} controller={controller} />
  ) : (
    <GroupsTable rows={data.groups} columns={columns} caption={caption} controller={controller} />
  );
}
