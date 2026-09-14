"use client";

import type { ReactNode } from "react";
import type { EmptyReason, ResourceDescriptor, Scope } from "../registry";
import { useResource, type ResourceView } from "./use-resource";

/**
 * The only component that decides which resource surface is on screen
 * (docs/ui-decision.md §3.3 item 4, §4.1, §4.4, §4.5).
 *
 * Every panel reads through this gate, so the skeleton delay and minimum, the
 * warm treatment, the empty copy for a declared reason, and the mapped error
 * surface are implemented once. The gate renders the descriptor's own skeleton,
 * empty copy, and `errorMap` output — it invents no surface of its own.
 *
 * The rendered state is `data-state`, never the transport, because a degraded
 * transport MUST leave the DOM byte-identical (`R-V3`); only the header's live
 * indicator may say that the stream is polling.
 *
 * A cold read carries exactly one accessible status — a labelled `role="status"`
 * naming the region — while the skeleton it reserves space with stays
 * `aria-hidden`, so a screen reader is told *that* the panel is loading without
 * being read a shape (`R-L1`, `R-L4`). The status is the state, never the
 * transport, so it survives a degrade unchanged.
 */

export interface ResourceGateProps<D, P = unknown> {
  resource: ResourceDescriptor<D, P>;
  scope: Scope;
  params?: P;
  /** The reason to show when the read settled with nothing; omit if any value counts. */
  emptyReason?: EmptyReason;
  /** What this region is, for the one loading announcement (`R-L1`). */
  label?: string;
  children: (view: ResourceView<D>) => ReactNode;
}

/** What counts as "nothing" for a declared empty reason: absent, or an empty list. */
function hasNothing(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return Array.isArray(value) && value.length === 0;
}

export function ResourceGate<D, P = unknown>({
  resource,
  scope,
  params,
  emptyReason,
  label,
  children,
}: ResourceGateProps<D, P>) {
  const view = useResource(resource, { scope, params });
  const context = { scope, params: params as P };

  const state =
    view.tier === "idle"
      ? "idle"
      : view.tier === "cold"
        ? "cold"
        : view.tier === "warm"
          ? "warm"
          : view.tier === "error"
            ? "error"
            : "ready";

  let surface: ReactNode = null;
  if (view.tier === "error") {
    const error = resource.errorMap(view.error);
    surface = (
      <div className="resource-surface">
        <p className="resource-surface__title">{error.title}</p>
        {error.body ? <p className="resource-surface__body">{error.body}</p> : null}
        {error.action?.kind === "navigate" && error.action.href !== undefined ? (
          <a className="resource-surface__action" href={error.action.href}>
            {error.action.label}
          </a>
        ) : error.action?.kind === "retry" || error.retryable ? (
          <button type="button" className="resource-surface__action" onClick={view.refresh}>
            {error.action?.label ?? "Try again"}
          </button>
        ) : null}
      </div>
    );
  } else if (view.showSkeleton) {
    surface = (
      <div className="resource-skeleton" aria-hidden="true">
        {resource.skeleton(context)}
      </div>
    );
  } else if (emptyReason && (view.tier === "live" || view.tier === "poll") && hasNothing(view.data)) {
    // Only a *settled* read can be empty: during `cold` the rows simply have
    // not arrived, and showing "nothing here" then would be a lie (R-L1).
    const copy = resource.empty[emptyReason];
    surface = (
      <div className="resource-surface">
        <p className="resource-surface__title">{copy.title}</p>
        <p className="resource-surface__body">{copy.body}</p>
        {copy.action === undefined ? null : "href" in copy.action ? (
          <a className="resource-surface__action" href={copy.action.href}>
            {copy.action.label}
          </a>
        ) : (
          <button type="button" className="resource-surface__action" onClick={copy.action.run}>
            {copy.action.label}
          </button>
        )}
      </div>
    );
  } else if (view.data === undefined && view.tier !== "live" && view.tier !== "poll") {
    // Nothing to render and nothing to say: the panel's own `minHeight` reserves
    // the geometry (R-L4). Handing a view `undefined` rows would make it paint a
    // transient empty table, and an empty *message* here would be a lie — the
    // read has simply not settled.
    surface = null;
  } else {
    surface = children(view);
  }

  return (
    <div
      className="resource-gate"
      data-state={state}
      // Only a load the operator is waiting on is busy; the warm bar and the
      // skeleton both belong to it, and a poll refetch is invisible (R-L1).
      aria-busy={state === "cold" || state === "warm" ? true : undefined}
    >
      {view.showWarmBar ? <div className="resource-gate__bar" aria-hidden="true" /> : null}
      {state === "cold" ? (
        <p className="visually-hidden" role="status">
          {label === undefined ? "Loading" : `Loading ${label}`}
        </p>
      ) : null}
      {surface}
    </div>
  );
}
