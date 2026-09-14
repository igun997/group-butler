"use client";

import { useSyncExternalStore } from "react";
import type { Scope } from "../registry";
import { scopeSegment } from "./cache";

/**
 * What a scope is called right now (docs/ui-decision.md §4.2 R-V4, §4.7 R-M2).
 *
 * A scope is an address, and an address is not a name: `/instances/abc123/groups`
 * says which instance, not what it is called. Two rules need the name anyway.
 * The header must state the scope without the operator opening anything (R-M2),
 * and a rename that arrives as a live patch must move the scope's label in the
 * same pass as the row it belongs to (R-V4: "the group row, the group header,
 * the scope switcher label"). Both need one place holding "what this scope is
 * called", written by the reads and the patches that learn it, read by whoever
 * renders an address as a name.
 *
 * It is deliberately not a cache. Nothing here is fetched, nothing expires, and
 * a missing label is not a failure: an untaught scope keeps the caller's own
 * fallback, which is the estate for a global scope, the id for an instance and
 * the JID for a group — never an empty string, and never a name nobody observed.
 */

export interface ScopeLabelStore {
  /** What this scope is called, or `undefined` when nothing has taught it yet. */
  read(scope: Scope): string | undefined;
  /** Teach the store what this scope is called. A blank label is refused. */
  write(scope: Scope, label: string): void;
  subscribe(listener: () => void): () => void;
  /** Test seam only: the product never unlearns a label. */
  clear(): void;
}

export function createScopeLabelStore(): ScopeLabelStore {
  const labels = new Map<string, string>();
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  return {
    read(scope) {
      return labels.get(scopeSegment(scope));
    },

    write(scope, label) {
      const name = label.trim();
      // A blank label teaches nothing: the address's own fallback is a better
      // answer than an empty string, and a frame that carries no name is not a
      // rename (the worker never stores one either).
      if (name === "") return;
      const key = scopeSegment(scope);
      if (labels.get(key) === name) return;
      labels.set(key, name);
      notify();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    clear() {
      if (labels.size === 0) return;
      labels.clear();
      notify();
    },
  };
}

/** The tab's one label store. */
export const scopeLabels = createScopeLabelStore();

/**
 * What a scope is called when nothing has taught this tab its name. It is the
 * address itself, said the way the address can say it — the id, the JID, or the
 * whole estate — so the header is never blank and never guesses (§4.6 R-A3).
 */
export function fallbackScopeLabel(scope: Scope): string {
  switch (scope.kind) {
    case "global":
      return "All instances";
    case "instance":
      return scope.instanceId;
    case "group":
      return scope.groupJid;
  }
}

/**
 * The label of the scope in force, for the shell's header. The server has not
 * learned any label (they arrive from reads the browser makes), so the SSR
 * snapshot is the fallback and the first client paint agrees with it.
 */
export function useScopeLabel(scope: Scope): string {
  const fallback = fallbackScopeLabel(scope);
  return useSyncExternalStore(
    scopeLabels.subscribe,
    () => scopeLabels.read(scope) ?? fallback,
    () => fallback,
  );
}
