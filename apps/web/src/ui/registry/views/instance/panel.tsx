"use client";

import type { InstanceSnapshot } from "@butler/shared";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ErrorBanner } from "../../../../components/error-banner";
import { LiveIndicator } from "../../../../components/live-indicator";
import { InstanceStateBadge } from "../../../../components/state-badges";
import { utcStamp } from "../../../../components/utc-stamp";
import { WorkspaceHeader } from "../../../../components/workspace-header";
import { mapError, needsOwnSurface, useAction, type MappedError } from "../../../feedback";
import {
  ResourceGate,
  resourceCache,
  STREAM_POLL_MS,
  useStreamScope,
  type StreamBinding,
  type StreamFrame,
  type StreamTransport,
} from "../../../resource";
import type { PanelProps } from "../../types";
import { invalidateGroupsReads } from "../groups/model";
import { GroupsPanel } from "../groups/panel";
import { instanceGroupsResource } from "../groups/resources";
import { INSTANCES_ALL } from "../instances/model";
import { deleteInstanceAction, requestPairingCodeAction } from "./actions";
import {
  applySnapshotFrame,
  configKey,
  deleteInstance,
  requestPairingCode,
  snapshotKey,
  writeWhitelist,
  type InstanceConfig,
} from "./model";
import { PairingSurface } from "./pairing";
import { instanceConfigResource, instanceSnapshotResource } from "./resources";
import { WhitelistEditor } from "./whitelist";

/**
 * The instance workspace (docs/ui-decision.md §2.3, §4.1 R-L5, §4.4, §5 P6;
 * draft §6.5, §7.2, §7.3).
 *
 * Three panels, each with its own read, and the split is the specification's: the
 * **session** (`GET /api/instances/[id]`) is the worker's live state and carries
 * pairing; the **configuration** (`GET /api/instances/[id]/config`) is the
 * dashboard's stored data and carries the assistant's scope; and the **groups**
 * of this instance are the groups workspace at this scope, table, sync and
 * toggles included. A failure in one never blanks the others (R-X2), which is
 * what makes the page usable while an instance is offline.
 *
 * Three rules run through the whole page. Long-running states are surfaces, not
 * loads (R-L5): pairing shows its step, its elapsed time and a way to leave, and
 * the traversal from disconnected to connected patches this panel in place — the
 * snapshot read is never re-keyed, so no skeleton is ever re-entered. Server
 * truth is rendered, never predicted (§2.2 invariant 6): every write answers
 * with what the server holds, and the deletion leaves the address rather than
 * describing an instance that is gone. And the status is always words plus a
 * glyph plus a tone, so removing colour removes nothing (R-A3).
 */

/** The failure a toast may not carry gets its own surface, with the call that made it (R-X2, R-X4). */
function failureOrNull(error: MappedError | undefined): MappedError | null {
  return error && needsOwnSurface(error) ? error : null;
}

export function InstancePanel({ scope }: PanelProps) {
  const headingId = useId();
  const router = useRouter();
  const action = useAction();
  const [requestingCode, setRequestingCode] = useState(false);
  const [codeFailure, setCodeFailure] = useState<MappedError | null>(null);

  const remove = useCallback(() => {
    if (scope.kind !== "instance") return;
    void action
      .run({
        action: deleteInstanceAction.id,
        targetId: scope.instanceId,
        label: "Instance removed",
        pendingLabel: "Logging out…",
        detail: "The session was logged out and the device deleted.",
        confirm: deleteInstanceAction.confirm,
        promise: () => deleteInstance(scope),
      })
      .then((outcome) => {
        // The confirmation dialog owns a failure (R-X2), and a decline left
        // nothing behind; either way the page stays where it is.
        if (!outcome.ok) return;
        resourceCache.invalidate([INSTANCES_ALL]);
        router.push("/instances");
      });
  }, [action, router, scope]);

  const requestCode = useCallback(() => {
    if (scope.kind !== "instance" || requestingCode) return;
    setRequestingCode(true);
    setCodeFailure(null);
    void action
      .run<InstanceSnapshot>({
        action: requestPairingCodeAction.id,
        targetId: scope.instanceId,
        label: "Pairing code requested",
        pendingLabel: "Requesting a code…",
        promise: () => requestPairingCode(scope),
      })
      .then((outcome) => {
        setRequestingCode(false);
        if (!outcome.ok) {
          setCodeFailure(failureOrNull(outcome.error));
          return;
        }
        // The code the worker issued is the state of this surface, so it is
        // patched rather than re-read (server truth, one round trip).
        if (outcome.data) {
          resourceCache.patch<InstanceSnapshot>(snapshotKey(scope), () => outcome.data as InstanceSnapshot);
        }
      });
  }, [action, requestingCode, scope]);

  // R-V4: one frame, one pass. The frame moves the status and the label of this
  // instance; nothing here focuses, scrolls, or toasts (R-V1, R-V2).
  const apply = useCallback(
    (data: unknown, frame: StreamFrame) => applySnapshotFrame(data as InstanceSnapshot, frame),
    [],
  );
  const bindings = useMemo<readonly StreamBinding[]>(
    () =>
      instanceSnapshotResource.sse
        ? [{ binding: instanceSnapshotResource.sse, key: instanceSnapshotResource.key(scope, undefined), apply }]
        : [],
    [scope, apply],
  );
  const transport = useStreamScope(scope, bindings);

  return (
    <section className="instance-workspace" aria-labelledby={headingId}>
      <ResourceGate resource={instanceSnapshotResource} scope={scope} label="Instance">
        {(view) =>
          view.data === undefined ? null : (
            <InstanceSession
              headingId={headingId}
              snapshot={view.data}
              transport={transport}
              revalidate={view.revalidate}
              requestingCode={requestingCode}
              codeFailure={codeFailure}
              onRequestCode={requestCode}
              onDelete={remove}
            />
          )
        }
      </ResourceGate>
    </section>
  );
}

interface InstanceSessionProps {
  headingId: string;
  snapshot: InstanceSnapshot;
  transport: StreamTransport;
  revalidate(): void;
  requestingCode: boolean;
  codeFailure: MappedError | null;
  onRequestCode(): void;
  onDelete(): void;
}

/**
 * The loaded session panel: what the instance is, what it is doing, and the one
 * destructive control that unlinks it.
 */
function InstanceSession({
  headingId,
  snapshot,
  transport,
  revalidate,
  requestingCode,
  codeFailure,
  onRequestCode,
  onDelete,
}: InstanceSessionProps) {
  usePairingWatch(snapshot.status, revalidate);

  const started = utcStamp(snapshot.createdAt);
  const alert =
    snapshot.status === "logged_out"
      ? mapError({ runtimeStatus: "logged_out" })
      : snapshot.status === "error"
        ? mapError({ runtimeStatus: "error" })
        : null;

  return (
    <>
      <WorkspaceHeader
        headingId={headingId}
        heading="Instance"
        scope={snapshot.label === "" ? snapshot.id : snapshot.label}
        summary={<p className="instance-workspace__started">{`Started ${started ?? "at an unrecorded time"}`}</p>}
        live={<LiveIndicator transport={transport} />}
        actions={
          <button type="button" className="instance-delete" onClick={onDelete}>
            {deleteInstanceAction.label}
          </button>
        }
      />
      <p className="instance-workspace__state">
        <InstanceStateBadge status={snapshot.status} />
      </p>
      {/* R-X3: a logged-out session and a stopped pairing are durable operating
          conditions, so they are banners above the panel's own content — read
          while the groups below stay readable — and not a toast. */}
      {alert === null ? null : <ErrorBanner error={alert} />}
      {codeFailure === null ? null : <ErrorBanner error={codeFailure} onRetry={onRequestCode} />}
      <PairingSurface snapshot={snapshot} requesting={requestingCode} onRequestCode={onRequestCode} />
    </>
  );
}

/**
 * R-L5's two watches, both belonging to a long-running state rather than to a
 * load. While the instance is pairing, the material rotates — WhatsApp replaces
 * the code — so the surface re-reads on the descriptor's interval until the
 * state moves on; and when a frame moves the state, the identity the new state
 * carries (the number, the device, the connected stamp) arrives with one read.
 * Neither changes the tier: a revalidation is the poll path, so the panel is
 * patched in place and never re-enters first paint (R-V3).
 */
function usePairingWatch(status: string, revalidate: () => void): void {
  const previous = useRef(status);

  useEffect(() => {
    if (previous.current === status) return;
    previous.current = status;
    revalidate();
  }, [status, revalidate]);

  useEffect(() => {
    if (status !== "pairing") return;
    const timer = setInterval(revalidate, STREAM_POLL_MS);
    return () => clearInterval(timer);
  }, [status, revalidate]);
}

/**
 * The configuration panel: the assistant's scope, which is the one
 * `instances.config` field with a reader (§7.2). It reads the stored list from
 * the BFF and the instance's groups from the same read the table below uses, so
 * the two can never offer different groups.
 */
export function InstanceConfigPanel({ scope }: PanelProps) {
  const headingId = useId();
  const action = useAction();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<MappedError | null>(null);
  // R-X4: the retry re-runs exactly the call that failed, so the list the
  // operator asked for is kept beside its failure.
  const attempted = useRef<readonly string[]>([]);

  const save = useCallback(
    (groupJidWhitelist: readonly string[]) => {
      if (scope.kind !== "instance") return;
      attempted.current = groupJidWhitelist;
      setPending(true);
      setFailure(null);
      const count = `${groupJidWhitelist.length} ${groupJidWhitelist.length === 1 ? "group" : "groups"} readable by the assistant.`;
      void action
        .run<InstanceConfig>({
          action: "save-whitelist",
          targetId: scope.instanceId,
          label: "Whitelist saved",
          pendingLabel: "Saving the whitelist…",
          detail: count,
          promise: () => writeWhitelist(scope, groupJidWhitelist),
        })
        .then((outcome) => {
          setPending(false);
          if (!outcome.ok) {
            setFailure(failureOrNull(outcome.error));
            return;
          }
          if (outcome.data) resourceCache.patch<InstanceConfig>(configKey(scope), () => outcome.data as InstanceConfig);
          // The write mirrors onto the group rows (§5.1), so the table's own
          // flags are stale by exactly this edit and re-read silently (R-V3).
          invalidateGroupsReads();
        });
    },
    [action, scope],
  );

  const retry = useCallback(() => save(attempted.current), [save]);

  return (
    <section className="instance-workspace" aria-labelledby={headingId}>
      <WorkspaceHeader
        headingId={headingId}
        heading="Configuration"
        scope="The groups the assistant may read for this instance"
      />
      <ResourceGate resource={instanceConfigResource} scope={scope} label="Configuration">
        {(configView) => {
          const stored = configView.data;
          if (stored === undefined) return null;
          return (
            <ResourceGate
              resource={instanceGroupsResource}
              scope={scope}
              emptyReason="no-data"
              label="Groups for the whitelist"
            >
              {(groupsView) =>
                groupsView.data === undefined ? null : (
                  <WhitelistEditor
                    config={stored}
                    groups={groupsView.data.groups}
                    pending={pending}
                    failure={failure}
                    onSave={save}
                    onRetry={retry}
                  />
                )
              }
            </ResourceGate>
          );
        }}
      </ResourceGate>
    </section>
  );
}

/**
 * This instance's groups, which is the groups workspace at an instance scope —
 * the same table, the same sync, the same per-row config, reached from the
 * instance's own address as well as from `/instances/<id>/groups` (§2.3:
 * "aliases are the same view"). It is composed rather than reimplemented, so the
 * two addresses cannot drift.
 */
export function InstanceGroupsPanel({ scope }: PanelProps) {
  return <GroupsPanel scope={scope} params={{}} />;
}
