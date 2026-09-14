// @vitest-environment jsdom
import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { EmptyAction, EmptyPlan, ResourceDescriptor, Scope } from "../registry";
import { resourceCache, resourceKey } from "./cache";
import { ResourceGate } from "./resource-gate";
import { SKELETON_DELAY_MS, SKELETON_MIN_VISIBLE_MS, useResource } from "./use-resource";
import { streamCoordinator } from "./use-stream-scope";

/**
 * R-L1–R-L3, R-L9 and R-V5, exercised as state transitions rather than as
 * source text: the tier a cause produces, the two R-L2 timers, and the cache
 * identity that keeps two scopes from ever sharing a frame.
 *
 * `@testing-library/react` is the only way to run the real hook lifecycle, so
 * this suite renders in jsdom; every other suite in the app stays on node.
 */

const GLOBAL: Scope = { kind: "global" };

const EMPTY: EmptyPlan = {
  "no-data": { title: "Nothing yet", body: "Nothing has been recorded for this scope yet." },
  filtered: { title: "No matches", body: "No rows match the filters." },
  unconfigured: { title: "Not set up", body: "This instance has not been configured." },
  unavailable: { title: "Unavailable", body: "This cannot be read right now." },
  "not-permitted": { title: "Not permitted", body: "This is outside the allowed scope." },
};

function makeResource<D>(
  id: string,
  fetch: (ctx: { scope: Scope; params: unknown }) => Promise<D>,
  extra: Partial<ResourceDescriptor<D, unknown>> = {},
): ResourceDescriptor<D, unknown> {
  return {
    id,
    key: (scope, params) => resourceKey(id, scope, params),
    fetch,
    skeleton: () => null,
    empty: EMPTY,
    errorMap: (error) => ({
      code: "unknown",
      title: `Failed: ${String(error)}`,
      surface: "inline",
      retryable: true,
    }),
    ...extra,
  };
}

beforeEach(() => {
  resourceCache.clear();
  streamCoordinator.__reset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/**
 * Fake only the timers the tiers own. `setImmediate` stays real because React's
 * `act` awaits through it, and faking it would deadlock every `await act(...)`
 * in this suite.
 */
function useTierTimers(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
}

describe("useResource loading tiers (R-L1..R-L3)", () => {
  test("cold: a load slower than 150 ms shows a skeleton, held for at least 400 ms", async () => {
    useTierTimers();
    const load = vi.fn(() => new Promise<string[]>((resolve) => setTimeout(() => resolve(["a"]), 500)));
    const resource = makeResource("cold", load);
    const { result } = renderHook(() => useResource(resource, { scope: GLOBAL }));

    expect(result.current.tier).toBe("cold");
    expect(result.current.showSkeleton).toBe(false); // R-L2: not before the delay

    act(() => {
      vi.advanceTimersByTime(SKELETON_DELAY_MS + 1);
    });
    expect(result.current.showSkeleton).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(result.current.data).toEqual(["a"]);
    // The skeleton must have been visible for the minimum, not one tick of it.
    expect(result.current.skeletonVisibleForMs).toBeGreaterThanOrEqual(SKELETON_MIN_VISIBLE_MS);
    expect(result.current.showSkeleton).toBe(false);
    expect(result.current.tier).toBe("live");
  });

  test("a load settling inside the delay never shows a skeleton at all", async () => {
    useTierTimers();
    const load = vi.fn(() => new Promise<string[]>((resolve) => setTimeout(() => resolve(["quick"]), 10)));
    const resource = makeResource("quick", load);
    const { result } = renderHook(() => useResource(resource, { scope: GLOBAL }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(11);
    });
    expect(result.current.data).toEqual(["quick"]);

    // The delay timer was cleared on settle, so no skeleton can appear late.
    act(() => {
      vi.advanceTimersByTime(SKELETON_DELAY_MS + 1);
    });
    expect(result.current.showSkeleton).toBe(false);
    expect(result.current.skeletonVisibleForMs).toBe(0);
  });

  test("warm beats cold: a refetch with data present never shows a skeleton (R-L3)", async () => {
    const load = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve(["first"]))
      .mockImplementationOnce(() => new Promise<string[]>((resolve) => setTimeout(() => resolve(["second"]), 60_000)));
    const resource = makeResource("warm", load);
    const { result } = renderHook(() => useResource(resource, { scope: GLOBAL }));
    await waitFor(() => expect(result.current.data).toEqual(["first"]));
    expect(result.current.tier).toBe("live");

    act(() => {
      result.current.refresh();
    });
    expect(result.current.tier).toBe("warm");
    expect(result.current.showSkeleton).toBe(false);
    expect(result.current.data).toEqual(["first"]);
    expect(result.current.showWarmBar).toBe(false); // R-L3: only after 300 ms
  });

  test("the warm bar appears only once a refresh passes 300 ms, and never a skeleton", async () => {
    useTierTimers();
    const load = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve(["first"]))
      .mockImplementationOnce(() => new Promise<string[]>((resolve) => setTimeout(() => resolve(["second"]), 60_000)));
    const resource = makeResource("warm-bar", load);
    const { result } = renderHook(() => useResource(resource, { scope: GLOBAL }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.data).toEqual(["first"]);

    act(() => {
      result.current.refresh();
    });
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(result.current.showWarmBar).toBe(false);
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(result.current.showWarmBar).toBe(true);
    expect(result.current.showSkeleton).toBe(false);
    expect(result.current.data).toEqual(["first"]);
  });

  test("a failed load settles on the error tier with the raw failure kept", async () => {
    const failure = new Error("mongo unreachable");
    const resource = makeResource("error", () => Promise.reject(failure));
    const { result } = renderHook(() => useResource(resource, { scope: GLOBAL }));

    await waitFor(() => expect(result.current.tier).toBe("error"));
    expect(result.current.error).toBe(failure);
    expect(result.current.showSkeleton).toBe(false);
  });

  test("a disabled read never fetches and stays idle", async () => {
    const load = vi.fn(() => Promise.resolve(["unused"]));
    const resource = makeResource("disabled", load);
    const { result } = renderHook(() => useResource(resource, { scope: GLOBAL, enabled: false }));

    expect(result.current.tier).toBe("idle");
    expect(result.current.data).toBeUndefined();
    expect(load).not.toHaveBeenCalled();
  });
});

describe("useResource scope identity (R-V5)", () => {
  test("a scope switch re-keys the cache atomically — two scopes never interleave", async () => {
    const load = vi.fn((scope: Scope) => Promise.resolve([(scope as { instanceId: string }).instanceId]));
    const resource = makeResource("groups", (ctx) => load(ctx.scope));
    const { result, rerender } = renderHook(
      ({ scope }: { scope: Scope }) => useResource(resource, { scope }),
      { initialProps: { scope: { kind: "instance", instanceId: "inst_1" } as Scope } },
    );
    await waitFor(() => expect(result.current.data).toEqual(["inst_1"]));

    rerender({ scope: { kind: "instance", instanceId: "inst_2" } as Scope });
    expect(result.current.data).toBeUndefined(); // never the other scope's rows

    await waitFor(() => expect(result.current.data).toEqual(["inst_2"]));
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("useResource refresh and revalidation (R-L9, R-V3)", () => {
  test("refresh runs a new read for the same key", async () => {
    const load = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve(["one"]))
      .mockImplementationOnce(() => Promise.resolve(["two"]));
    const resource = makeResource("refresh", load);
    const { result } = renderHook(() => useResource(resource, { scope: GLOBAL }));
    await waitFor(() => expect(result.current.data).toEqual(["one"]));

    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.data).toEqual(["two"]));
    expect(load).toHaveBeenCalledTimes(2);
  });

  test("revalidate updates the payload without ever leaving the settled tier", async () => {
    const load = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve(["one"]))
      .mockImplementationOnce(() => Promise.resolve(["two"]));
    const resource = makeResource("revalidate", load);
    const { result } = renderHook(() => useResource(resource, { scope: GLOBAL }));
    await waitFor(() => expect(result.current.data).toEqual(["one"]));

    await act(async () => {
      result.current.revalidate();
    });
    await waitFor(() => expect(result.current.data).toEqual(["two"]));
    expect(result.current.tier).toBe("live");
    expect(result.current.showSkeleton).toBe(false);
  });

  test("a failed revalidate keeps the last good payload on screen", async () => {
    const load = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve(["kept"]))
      .mockImplementationOnce(() => Promise.reject(new Error("transient")));
    const resource = makeResource("revalidate-fail", load);
    const { result } = renderHook(() => useResource(resource, { scope: GLOBAL }));
    await waitFor(() => expect(result.current.data).toEqual(["kept"]));

    await act(async () => {
      result.current.revalidate();
    });
    await waitFor(() => expect(result.current.tier).toBe("live"));
    expect(result.current.data).toEqual(["kept"]);
    expect(result.current.error).toBeUndefined();
  });
});

describe("ResourceGate surfaces (R-L1, R-E1, R-V3)", () => {
  test("a cold read shows neither an empty surface nor fake content", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const load = vi.fn(() => new Promise<string[]>((resolve) => setTimeout(() => resolve([]), 60_000)));
    const resource = makeResource("gate-cold", load);
    render(
      <ResourceGate resource={resource} scope={GLOBAL} emptyReason="no-data">
        {() => <p>loaded rows</p>}
      </ResourceGate>,
    );

    // Before the skeleton delay: no empty copy, no children, just an empty busy
    // region.
    const gate = document.querySelector(".resource-gate");
    expect(gate?.getAttribute("data-state")).toBe("cold");
    expect(gate?.getAttribute("aria-busy")).toBe("true");
    expect(document.body.textContent).not.toContain("Nothing yet");
    expect(document.body.textContent).not.toContain("loaded rows");

    act(() => {
      vi.advanceTimersByTime(SKELETON_DELAY_MS + 1);
    });
    expect(document.querySelector(".resource-skeleton")).not.toBeNull();
    expect(document.body.textContent).not.toContain("Nothing yet");
  });

  test("a cold read carries exactly one labelled status while the skeleton stays hidden", async () => {
    useTierTimers();
    const load = vi.fn(() => new Promise<string[]>((resolve) => setTimeout(() => resolve([]), 60_000)));
    const resource = makeResource("gate-status", load);
    render(
      <ResourceGate resource={resource} scope={GLOBAL} label="Groups" emptyReason="no-data">
        {() => <p>loaded rows</p>}
      </ResourceGate>,
    );

    const status = document.querySelectorAll('[role="status"]');
    expect(status).toHaveLength(1);
    expect(status[0]?.textContent).toBe("Loading Groups");
    // The status is present before the skeleton, and stays the only one once
    // the skeleton appears — the skeleton itself is announced to nobody.
    expect(document.querySelector(".resource-skeleton")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(SKELETON_DELAY_MS + 1);
    });
    const skeleton = document.querySelector(".resource-skeleton");
    expect(skeleton?.getAttribute("aria-hidden")).toBe("true");
    expect(document.querySelectorAll('[role="status"]')).toHaveLength(1);
  });

  test("a cold read with no label still carries one status, unnamed", async () => {
    useTierTimers();
    const load = vi.fn(() => new Promise<string[]>((resolve) => setTimeout(() => resolve([]), 60_000)));
    const resource = makeResource("gate-status-bare", load);
    render(
      <ResourceGate resource={resource} scope={GLOBAL}>
        {() => <p>loaded rows</p>}
      </ResourceGate>,
    );

    const status = document.querySelectorAll('[role="status"]');
    expect(status).toHaveLength(1);
    expect(status[0]?.textContent).toBe("Loading");
  });

  test("a settled read carries no loading status at all", async () => {
    const resource = makeResource("gate-no-status", () => Promise.resolve(["row"]));
    render(
      <ResourceGate resource={resource} scope={GLOBAL} label="Groups">
        {() => <p>loaded rows</p>}
      </ResourceGate>,
    );

    await waitFor(() => expect(document.body.textContent).toContain("loaded rows"));
    expect(document.querySelectorAll('[role="status"]')).toHaveLength(0);
  });

  test("an empty copy's action is a real operation, not a dead control", async () => {
    const run = vi.fn();
    const resource = makeResource<string[]>(
      "gate-empty-action",
      () => Promise.resolve([]),
      {
        empty: {
          ...EMPTY,
          filtered: { title: "No matches", body: "No rows match.", action: { label: "Clear filters", run } },
        },
      },
    );
    render(
      <ResourceGate resource={resource} scope={GLOBAL} emptyReason="filtered">
        {() => <p>loaded rows</p>}
      </ResourceGate>,
    );

    await waitFor(() => expect(document.body.textContent).toContain("No matches"));
    const button = document.querySelector<HTMLButtonElement>("button.resource-surface__action");
    expect(button?.textContent).toBe("Clear filters");
    act(() => {
      button?.click();
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("an empty copy's link action keeps its href", async () => {
    const resource = makeResource<string[]>("gate-empty-link", () => Promise.resolve([]), {
      empty: {
        ...EMPTY,
        unconfigured: {
          title: "Not set up",
          body: "This instance has not been configured.",
          action: { label: "Open settings", href: "/settings" },
        },
      },
    });
    render(
      <ResourceGate resource={resource} scope={GLOBAL} emptyReason="unconfigured">
        {() => <p>loaded rows</p>}
      </ResourceGate>,
    );

    await waitFor(() => expect(document.body.textContent).toContain("Not set up"));
    const link = document.querySelector<HTMLAnchorElement>("a.resource-surface__action");
    expect(link?.getAttribute("href")).toBe("/settings");
    expect(link?.textContent).toBe("Open settings");
  });

  test("an empty copy with no action renders no control at all", async () => {
    const resource = makeResource<string[]>("gate-empty-none", () => Promise.resolve([]));
    render(
      <ResourceGate resource={resource} scope={GLOBAL} emptyReason="no-data">
        {() => <p>loaded rows</p>}
      </ResourceGate>,
    );

    await waitFor(() => expect(document.body.textContent).toContain("Nothing yet"));
    expect(document.querySelector(".resource-surface__action")).toBeNull();
  });

  test("an action without an effect is a type error, not a dead control", () => {
    // @ts-expect-error — `EmptyAction` requires a link or an operation, so a
    // label with nothing behind it cannot be written down.
    const broken: EmptyAction = { label: "Does nothing" };
    expect(broken).toBeDefined();
  });

  test("a settled read with no rows shows the declared reason's copy, not a bare line", async () => {
    const resource = makeResource("gate-empty", () => Promise.resolve([]));
    render(
      <ResourceGate resource={resource} scope={GLOBAL} emptyReason="filtered">
        {() => <p>loaded rows</p>}
      </ResourceGate>,
    );

    await waitFor(() => expect(document.body.textContent).toContain("No matches"));
    expect(document.body.textContent).toContain("No rows match the filters.");
    expect(document.body.textContent).not.toContain("loaded rows");
  });

  test("a failed read shows the descriptor's mapped error and offers its retry", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("mongo unreachable")).mockResolvedValueOnce(["recovered"]);
    const resource = makeResource<string[]>("gate-error", load);
    render(
      <ResourceGate resource={resource} scope={GLOBAL}>
        {(view) => <p>{(view.data ?? []).join(",")}</p>}
      </ResourceGate>,
    );

    await waitFor(() => expect(document.body.textContent).toContain("Failed: Error: mongo unreachable"));
    const retry = document.querySelector<HTMLButtonElement>(".resource-surface__action");
    expect(retry?.textContent).toBe("Try again");
    await act(async () => {
      retry?.click();
    });
    await waitFor(() => expect(document.body.textContent).toContain("recovered"));
    expect(load).toHaveBeenCalledTimes(2);
  });

  test("a resource with no sse or poll still settles on live without touching the stream", async () => {
    const resource = makeResource("gate-static", () => Promise.resolve(["row"]));
    render(
      <ResourceGate resource={resource} scope={GLOBAL}>
        {(view) => <p>{`${view.tier}:${(view.data ?? []).join(",")}`}</p>}
      </ResourceGate>,
    );

    await waitFor(() => expect(document.body.textContent).toBe("live:row"));
  });
});

describe("resource cache identity and invalidation", () => {
  test("params that differ only in key order are one cache entry", () => {
    const resource = makeResource("params", () => Promise.resolve([]));
    expect(resource.key(GLOBAL, { a: 1, b: 2 })).toBe(resource.key(GLOBAL, { b: 2, a: 1 }));
  });

  test("invalidateOn marks a dependent read stale and the hook refetches silently", async () => {
    const load = vi.fn(() => Promise.resolve(["row"]));
    const resource = makeResource("dependent", load, { invalidateOn: ["groups.mutate"] });
    const { result } = renderHook(() => useResource(resource, { scope: GLOBAL }));
    await waitFor(() => expect(result.current.data).toEqual(["row"]));
    expect(load).toHaveBeenCalledTimes(1);

    await act(async () => {
      resourceCache.invalidate(["groups.mutate"]);
    });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    // The refetch is warm: the old rows stay on screen while it runs.
    expect(result.current.data).toEqual(["row"]);
    expect(result.current.showSkeleton).toBe(false);
  });

  test("a patch that returns the same reference costs no render and no copy", () => {
    resourceCache.resolve(resourceCache.begin("k", "r"), ["row"]);
    const before = resourceCache.read<string[]>("k");
    resourceCache.patch<string[]>("k", (data) => data);
    expect(resourceCache.read<string[]>("k")).toBe(before);

    resourceCache.patch<string[]>("k", (data) => [...data, "next"]);
    expect(resourceCache.read<string[]>("k")?.data).toEqual(["row", "next"]);
  });
});

describe("a fetch may only write the generation it started from (R-V4)", () => {
  test("a resolve that began before a live patch never overwrites it", () => {
    resourceCache.resolve(resourceCache.begin("gen", "r"), ["row"]);

    const inflight = resourceCache.begin("gen", "r");
    resourceCache.patch<string[]>("gen", (rows) => [...rows, "patched"]);

    expect(resourceCache.resolve(inflight, ["row"])).toBe(false);
    expect(resourceCache.read<string[]>("gen")?.data).toEqual(["row", "patched"]);
    // The superseded read is dropped, not applied: the entry is still the
    // in-flight one the patch moved, and it never became the stale snapshot.
    expect(resourceCache.read<string[]>("gen")?.status).toBe("loading");
  });

  test("a rejection from a superseded generation cannot blank a patched entry", () => {
    resourceCache.resolve(resourceCache.begin("gen-fail", "r"), ["row"]);

    const inflight = resourceCache.begin("gen-fail", "r");
    resourceCache.patch<string[]>("gen-fail", (rows) => [...rows, "patched"]);

    expect(resourceCache.reject(inflight, new Error("stale failure"))).toBe(false);
    expect(resourceCache.read<string[]>("gen-fail")?.data).toEqual(["row", "patched"]);
    expect(resourceCache.read<string[]>("gen-fail")?.error).toBeUndefined();
  });

  test("a newer load supersedes an older one for the same key", () => {
    const older = resourceCache.begin("gen-order", "r");
    const newer = resourceCache.begin("gen-order", "r");

    expect(resourceCache.resolve(older, ["old"])).toBe(false);
    expect(resourceCache.resolve(newer, ["new"])).toBe(true);
    expect(resourceCache.read<string[]>("gen-order")?.data).toEqual(["new"]);
  });

  test("a live patch landing mid-load is not undone by the older snapshot", async () => {
    const pending: Array<(rows: string[]) => void> = [];
    const load = vi.fn(() => new Promise<string[]>((resolve) => pending.push(resolve)));
    const resource = makeResource<string[]>("mid-load", load);
    const { result } = renderHook(() => useResource(resource, { scope: GLOBAL }));

    await act(async () => {
      pending[0]?.(["first"]);
    });
    await waitFor(() => expect(result.current.data).toEqual(["first"]));

    act(() => {
      result.current.refresh();
    });
    const key = resource.key(GLOBAL, undefined);
    act(() => {
      resourceCache.patch<string[]>(key, (rows) => [...rows, "live"]);
    });
    expect(result.current.data).toEqual(["first", "live"]);

    // The refetch resolves with the snapshot it started from; it must not win.
    await act(async () => {
      pending[1]?.(["first"]);
    });
    expect(result.current.data).toEqual(["first", "live"]);
    expect(result.current.tier).toBe("live");
    expect(result.current.showSkeleton).toBe(false);
  });
});
