"use client";

import type { InstanceSnapshot } from "@butler/shared";
import { useRouter } from "next/navigation";
import { useCallback, useId, useMemo, useState } from "react";
import { LiveIndicator } from "../../../../components/live-indicator";
import { COMPACT_QUERY, useMediaQuery } from "../../../../components/media-query";
import { WorkspaceHeader } from "../../../../components/workspace-header";
import { needsOwnSurface, useAction, type MappedError } from "../../../feedback";
import {
  ResourceGate,
  resourceCache,
  useStreamScope,
  type StreamBinding,
  type StreamFrame,
  type StreamTransport,
} from "../../../resource";
import type { PanelProps, ResourceDescriptor } from "../../types";
import { InstancesCards, InstancesTable, instanceColumns } from "./columns";
import { CreateInstanceDialog } from "./create-instance";
import {
  applyCreatedInstance,
  applyInstanceFrame,
  createInstance,
  INSTANCES_ALL,
  instancesKey,
  type CreateInstanceInput,
} from "./model";
import { instancesResource } from "./resources";

/**
 * The instances workspace (docs/ui-decision.md §2.3, §5 P6; draft §6.5, §7.3).
 *
 * This is the estate's own surface: every instance this dashboard knows, the
 * state its session is in, and the one control that adds another. It reads
 * `GET /api/instances` — the worker's live snapshots, through the BFF — so what
 * is on screen is the session as the worker holds it, not a cached opinion of it.
 *
 * The layering is the same as every workspace's: the rows come through
 * `ResourceGate`, so the loading tier, the empty copy and the failure surface are
 * the read's own; the create goes through `useAction`, so its outcome is reported
 * by the toast policy and a failure the policy refuses to carry is rendered where
 * the operator can act on it; and one `instance.updated` frame patches the row it
 * names (R-V1, R-V4) without reordering the list or moving focus.
 *
 * Controls appear with the data (R-L8): the create control is rendered with the
 * loaded workspace, and the empty state carries its own way to create one — a
 * control that cannot yet mean anything is not rendered disabled.
 */

/** What a failed create left behind when the toast could not carry it (R-X2). */
interface CreateFailure {
  readonly error: MappedError;
}

interface CreateState {
  readonly open: boolean;
  readonly pending: boolean;
  readonly failure: CreateFailure | null;
}

const IDLE_CREATE: CreateState = { open: false, pending: false, failure: null };

interface CreateControl {
  readonly state: CreateState;
  open(): void;
  close(): void;
  submit(input: CreateInstanceInput): void;
}

/**
 * The create operation, as one hook (R-L9, R-T2). It runs the write through the
 * one toast emitter, so the row that appears is the snapshot the worker
 * answered with — an instance that is already pairing — and never a row this
 * build predicted. On success the list is patched in place and marked stale, so
 * the row is there at once and the server's own ordering lands behind it without
 * a skeleton (R-V3).
 */
function useCreateInstance(onCreated: (created: InstanceSnapshot) => void): CreateControl {
  const action = useAction();
  const [state, setState] = useState<CreateState>(IDLE_CREATE);

  const open = useCallback(() => setState((current) => ({ ...current, open: true })), []);
  const close = useCallback(() => setState(IDLE_CREATE), []);

  const submit = useCallback(
    (input: CreateInstanceInput) => {
      setState({ open: true, pending: true, failure: null });
      void action
        .run<InstanceSnapshot>({
          action: "create-instance",
          targetId: input.label,
          label: "Instance created",
          pendingLabel: "Creating an instance…",
          detail: "Pairing has started.",
          promise: () => createInstance(input),
        })
        .then((outcome) => {
          if (!outcome.ok) {
            setState({
              open: true,
              pending: false,
              failure: outcome.error && needsOwnSurface(outcome.error) ? { error: outcome.error } : null,
            });
            return;
          }
          setState(IDLE_CREATE);
          if (outcome.data) onCreated(outcome.data);
        });
    },
    [action, onCreated],
  );

  return { state, open, close, submit };
}

/**
 * The same read, with its `no-data` way out bound to this workspace's create
 * control (R-E1: the empty state offers the action that creates data). Only
 * `empty` differs — the id, the key, the fetch, the live binding and the
 * skeleton stay the descriptor's, so this mount and its cache entry are still
 * the read the descriptor declared.
 */
function withCreateWayOut(
  resource: ResourceDescriptor<readonly InstanceSnapshot[], undefined>,
  open: () => void,
): ResourceDescriptor<readonly InstanceSnapshot[], undefined> {
  return {
    ...resource,
    empty: {
      ...resource.empty,
      "no-data": { ...resource.empty["no-data"], action: { label: "Create instance", run: open } },
    },
  };
}

export function InstancesPanel({ scope }: PanelProps) {
  const headingId = useId();
  const router = useRouter();

  const created = useCallback(
    (instance: InstanceSnapshot) => {
      resourceCache.patch<readonly InstanceSnapshot[]>(instancesKey(scope), (data) =>
        applyCreatedInstance(data, instance),
      );
      // The created row is what the worker answered; the list behind it is
      // refreshed silently so the server's ordering wins (R-V3).
      resourceCache.invalidate([INSTANCES_ALL]);
      router.push(`/instances/${encodeURIComponent(instance.id)}`);
    },
    [router, scope],
  );

  const create = useCreateInstance(created);

  // R-V4: one frame, one pass. The row the frame names moves in place; nothing
  // here focuses, scrolls, or toasts (R-V1, R-V2).
  const apply = useCallback(
    (data: unknown, frame: StreamFrame) => applyInstanceFrame(data as readonly InstanceSnapshot[], frame),
    [],
  );
  const bindings = useMemo<readonly StreamBinding[]>(
    () =>
      instancesResource.sse
        ? [{ binding: instancesResource.sse, key: instancesResource.key(scope, undefined), apply }]
        : [],
    [scope, apply],
  );
  const transport = useStreamScope(scope, bindings);
  const bound = useMemo(() => withCreateWayOut(instancesResource, create.open), [create.open]);

  return (
    <section className="instances-workspace" aria-labelledby={headingId}>
      <ResourceGate resource={bound} scope={scope} emptyReason="no-data" label="Instances">
        {(view) =>
          view.data === undefined ? null : (
            <InstancesWorkspace
              headingId={headingId}
              data={view.data}
              transport={transport}
              onCreate={create.open}
            />
          )
        }
      </ResourceGate>
      <CreateInstanceDialog
        open={create.state.open}
        pending={create.state.pending}
        failure={create.state.failure?.error ?? null}
        onSubmit={create.submit}
        onClose={create.close}
      />
    </section>
  );
}

interface InstancesWorkspaceProps {
  headingId: string;
  data: readonly InstanceSnapshot[];
  transport: StreamTransport;
  onCreate(): void;
}

/** The loaded workspace: what this deployment holds, and the control that adds to it. */
function InstancesWorkspace({ headingId, data, transport, onCreate }: InstancesWorkspaceProps) {
  return (
    <>
      <WorkspaceHeader
        headingId={headingId}
        heading="Instances"
        scope={scopeLine(data)}
        live={<LiveIndicator transport={transport} />}
        actions={<CreateButton onCreate={onCreate} />}
      />
      <InstancesRows data={data} />
    </>
  );
}

/** What the list holds, in the terms the operator counts in — the data's own numbers. */
function scopeLine(data: readonly InstanceSnapshot[]): string {
  const connected = data.filter((row) => row.status === "connected").length;
  const instances = `${data.length} ${data.length === 1 ? "instance" : "instances"}`;
  return `${instances}, ${connected} connected`;
}

function CreateButton({ onCreate }: { onCreate(): void }) {
  return (
    <button type="button" className="instances-create" onClick={onCreate}>
      <span className="instances-create__glyph" aria-hidden="true">
        <svg
          viewBox="0 0 16 16"
          width="1em"
          height="1em"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
        >
          <path d="M8 3.25v9.5" />
          <path d="M3.25 8h9.5" />
        </svg>
      </span>
      <span>Create instance</span>
    </button>
  );
}

/**
 * The rows, in the presentation this width calls for (R-M1). One of the two is
 * mounted, never both, so a row's address and its copy control exist once in the
 * accessibility tree however the viewport is measured.
 */
function InstancesRows({ data }: { data: readonly InstanceSnapshot[] }) {
  const compact = useMediaQuery(COMPACT_QUERY);
  const columns = useMemo(() => instanceColumns(), []);
  const caption = "Instances in this deployment";

  return compact ? (
    <InstancesCards rows={data} columns={columns} caption={caption} />
  ) : (
    <InstancesTable rows={data} columns={columns} caption={caption} />
  );
}
