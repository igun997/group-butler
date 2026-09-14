// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { EmptyPlan, ResourceDescriptor, Scope } from "../registry";
import { resourceCache, resourceKey } from "./cache";
import { ResourceGate } from "./resource-gate";
import { useResource } from "./use-resource";
import {
  STREAM_PATH,
  STREAM_POLL_MS,
  type EventSourceLike,
  type StreamFrame,
  streamCoordinator,
  useStreamScope,
} from "./use-stream-scope";

/**
 * The one EventSource, its resume behaviour, and its poll fallback
 * (docs/ui-decision.md §3.3 item 5, §4.2 R-V3).
 *
 * The coordinator is driven through a real (fake) `EventSource` rather than a
 * test hook, so the fan-out, the reconnect ladder, the resume URL, and the
 * degrade path are all the production code paths.
 */

const GLOBAL: Scope = { kind: "global" };

const EMPTY: EmptyPlan = {
  "no-data": { title: "Nothing yet", body: "Nothing has been recorded for this scope yet." },
  filtered: { title: "No matches", body: "No rows match the filters." },
  unconfigured: { title: "Not set up", body: "This instance has not been configured." },
  unavailable: { title: "Unavailable", body: "This cannot be read right now." },
  "not-permitted": { title: "Not permitted", body: "This is outside the allowed scope." },
};

type FrameListener = (event: { data: string; lastEventId: string }) => void;

class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  static last(): FakeEventSource {
    const instance = FakeEventSource.instances.at(-1);
    if (!instance) throw new Error("no EventSource was opened");
    return instance;
  }

  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  readonly url: string;
  private readonly listeners = new Map<string, FrameListener[]>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: FrameListener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.();
  }

  fail(): void {
    this.onerror?.();
  }

  emit(type: string, data: unknown, id = ""): void {
    this.rawEmit(type, JSON.stringify(data), id);
  }

  rawEmit(type: string, data: string, id = ""): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data, lastEventId: id });
    }
  }
}

function installFakeStream() {
  const factory = vi.fn((url: string) => new FakeEventSource(url));
  streamCoordinator.__setEventSourceFactory(factory);
  return factory;
}

beforeEach(() => {
  FakeEventSource.instances = [];
  resourceCache.clear();
  streamCoordinator.__reset();
  installFakeStream();
});

afterEach(() => {
  cleanup();
  streamCoordinator.__reset();
  streamCoordinator.__setEventSourceFactory(null);
  vi.useRealTimers();
});

/**
 * Fake only the timers the stream owns. `setImmediate` stays real because
 * React's `act` awaits through it.
 */
function useStreamTimers(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
}

describe("the tab's single EventSource", () => {
  test("opens one stream for every mounted binding, and closes it with the last", () => {
    const factory = installFakeStream();
    const stopA = streamCoordinator.subscribe({ scope: GLOBAL, event: "group.updated", onFrame: vi.fn() });
    const stopB = streamCoordinator.subscribe({ scope: GLOBAL, event: "send.updated", onFrame: vi.fn() });

    expect(factory).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances).toHaveLength(1);

    stopA();
    expect(FakeEventSource.last().closed).toBe(false);
    stopB();
    expect(FakeEventSource.last().closed).toBe(true);
  });

  test("fans a frame out only to the matching event and scope (R-V1, R-V5)", () => {
    const frames: StreamFrame[] = [];
    streamCoordinator.subscribe({
      scope: { kind: "instance", instanceId: "inst_1" },
      event: "group.updated",
      onFrame: (frame) => frames.push(frame),
    });
    const source = FakeEventSource.last();
    source.open();

    source.emit("group.updated", { instanceId: "inst_2", groupJid: "1203@g.us" }, "tok-1");
    expect(frames).toHaveLength(0);

    source.emit("send.updated", { instanceId: "inst_1" }, "tok-2");
    expect(frames).toHaveLength(0);

    source.emit("group.updated", { instanceId: "inst_1", groupJid: "1203@g.us" }, "tok-3");
    expect(frames).toHaveLength(1);
    expect(frames[0]?.type).toBe("group.updated");
    expect(frames[0]?.id).toBe("tok-3");
  });

  test("an instance.updated row, which names its instance as `id`, only reaches that instance", () => {
    const frames: StreamFrame[] = [];
    streamCoordinator.subscribe({
      scope: { kind: "instance", instanceId: "inst_1" },
      event: "instance.updated",
      onFrame: (frame) => frames.push(frame),
    });
    const source = FakeEventSource.last();
    source.open();

    source.emit("instance.updated", { id: "inst_2", label: "Other", status: "connected" }, "tok-1");
    expect(frames).toHaveLength(0);

    source.emit("instance.updated", { id: "inst_1", label: "Mine", status: "connected" }, "tok-2");
    expect(frames).toHaveLength(1);
    expect(frames[0]?.id).toBe("tok-2");
  });

  test("a group scope takes only its own group, and a global scope takes everything", () => {
    const mine: StreamFrame[] = [];
    const every: StreamFrame[] = [];
    streamCoordinator.subscribe({
      scope: { kind: "group", instanceId: "inst_1", groupJid: "1203@g.us" },
      event: "group.updated",
      onFrame: (frame) => mine.push(frame),
    });
    streamCoordinator.subscribe({ scope: GLOBAL, event: "group.updated", onFrame: (frame) => every.push(frame) });
    const source = FakeEventSource.last();
    source.open();

    source.emit("group.updated", { instanceId: "inst_1", groupJid: "9999@g.us", name: "Another group" }, "tok-1");
    source.emit("group.updated", { instanceId: "inst_2", groupJid: "1203@g.us", name: "Another instance" }, "tok-2");
    expect(mine).toHaveLength(0);
    expect(every).toHaveLength(2);

    source.emit("group.updated", { instanceId: "inst_1", groupJid: "1203@g.us", name: "Mine" }, "tok-3");
    expect(mine).toHaveLength(1);
    expect(every).toHaveLength(3);
  });

  test("a frame that names no scope reaches no scoped subscription", () => {
    const mine: StreamFrame[] = [];
    streamCoordinator.subscribe({
      scope: { kind: "group", instanceId: "inst_1", groupJid: "1203@g.us" },
      event: "group.updated",
      onFrame: (frame) => mine.push(frame),
    });
    const source = FakeEventSource.last();
    source.open();

    // An instance-level frame is not about any group, and an unidentifiable
    // payload is not about any instance: neither may patch a scoped read.
    source.emit("group.updated", { instanceId: "inst_1", name: "No group named" }, "tok-1");
    source.emit("group.updated", { name: "No instance named" }, "tok-2");
    expect(mine).toHaveLength(0);

    source.emit("group.updated", { instanceId: "inst_1", groupJid: "1203@g.us", name: "Mine" }, "tok-3");
    expect(mine).toHaveLength(1);
  });

  test("a malformed frame is dropped rather than thrown", () => {
    const onFrame = vi.fn();
    streamCoordinator.subscribe({ scope: GLOBAL, event: "group.updated", onFrame });
    const source = FakeEventSource.last();
    source.open();

    source.rawEmit("group.updated", "not json at all", "tok-1");
    expect(onFrame).not.toHaveBeenCalled();

    source.emit("group.updated", { instanceId: "inst_1" }, "tok-2");
    expect(onFrame).toHaveBeenCalledTimes(1);
  });
});

describe("stream failure and the poll fallback (R-V3)", () => {
  test("a stream that never opens degrades to polling after the retry ladder", () => {
    useStreamTimers();
    const factory = installFakeStream();
    const onPoll = vi.fn();
    streamCoordinator.subscribe({ scope: GLOBAL, pollMs: STREAM_POLL_MS, onPoll });
    expect(streamCoordinator.transport).toBe("sse");

    FakeEventSource.last().fail();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(streamCoordinator.transport).toBe("sse");

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(factory).toHaveBeenCalledTimes(2);
    FakeEventSource.last().fail();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(factory).toHaveBeenCalledTimes(3);

    FakeEventSource.last().fail();
    expect(streamCoordinator.transport).toBe("poll");
    expect(onPoll).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(STREAM_POLL_MS);
    });
    expect(onPoll).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(STREAM_POLL_MS);
    });
    expect(onPoll).toHaveBeenCalledTimes(2);
  });

  test("a reconnect after a live frame asks the server to resume from its token", () => {
    useStreamTimers();
    installFakeStream();
    streamCoordinator.subscribe({ scope: GLOBAL, event: "group.updated", onFrame: vi.fn() });

    const first = FakeEventSource.last();
    first.open();
    first.emit("group.updated", { instanceId: "inst_1" }, "resume-token-1");
    first.fail();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(FakeEventSource.last().url).toBe(`${STREAM_PATH}?resume=resume-token-1`);
  });

  test("a stream that recovers keeps the transport on sse", () => {
    useStreamTimers();
    installFakeStream();
    streamCoordinator.subscribe({ scope: GLOBAL, event: "group.updated", onFrame: vi.fn() });

    FakeEventSource.last().fail();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    FakeEventSource.last().open();
    expect(streamCoordinator.transport).toBe("sse");

    // A later drop starts the ladder over rather than degrading immediately.
    FakeEventSource.last().fail();
    FakeEventSource.last().fail();
    expect(streamCoordinator.transport).toBe("sse");
  });
});

describe("SSE to poll parity (R-V3)", () => {
  const fetchRows = vi.fn();

  function makeResource(): ResourceDescriptor<string[], undefined> {
    return {
      id: "rows",
      key: (scope, params) => resourceKey("rows", scope, params ?? undefined),
      fetch: fetchRows,
      sse: { event: "group.updated", patch: ["name"] },
      poll: { intervalMs: STREAM_POLL_MS },
      skeleton: () => null,
      empty: EMPTY,
      errorMap: (error) => ({
        code: "unknown",
        title: `Failed: ${String(error)}`,
        surface: "inline",
        retryable: true,
      }),
    };
  }

  function Screen({ resource }: { resource: ResourceDescriptor<string[], undefined> }) {
    useStreamScope(GLOBAL, [
      {
        binding: resource.sse!,
        key: resource.key(GLOBAL, undefined),
        apply: (data, frame) => {
          const rows = (data ?? []) as string[];
          const name = (frame.data as { name?: string }).name;
          return name === undefined || rows.includes(name) ? rows : [...rows, name];
        },
      },
    ]);
    return (
      <ResourceGate resource={resource} scope={GLOBAL} emptyReason="no-data">
        {(view) => <ul data-testid="rows">{(view.data ?? []).map((row) => <li key={row}>{row}</li>)}</ul>}
      </ResourceGate>
    );
  }

  test("a degraded transport changes no DOM and a poll tick swaps data silently", async () => {
    useStreamTimers();
    fetchRows.mockReset();
    fetchRows.mockResolvedValue(["Ops Team"]);
    const resource = makeResource();

    render(<Screen resource={resource} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("rows").textContent).toBe("Ops Team");
    expect(fetchRows).toHaveBeenCalledTimes(1);

    const settled = document.body.innerHTML;
    expect(settled).toContain('data-state="ready"');

    FakeEventSource.last().fail();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    FakeEventSource.last().fail();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    FakeEventSource.last().fail();

    expect(streamCoordinator.transport).toBe("poll");
    expect(document.body.innerHTML).toBe(settled);

    // The poll tick re-reads and patches under the same DOM (R-V3).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STREAM_POLL_MS);
    });
    expect(fetchRows).toHaveBeenCalledTimes(2);
    expect(document.body.innerHTML).toBe(settled);
  });

  test("an SSE patch lands in the cache without a refetch (R-V4)", async () => {
    fetchRows.mockReset();
    fetchRows.mockResolvedValue(["Ops Team"]);
    const resource = makeResource();

    render(<Screen resource={resource} />);
    await waitFor(() => expect(screen.getByTestId("rows").textContent).toBe("Ops Team"));

    const source = FakeEventSource.last();
    source.open();
    await act(async () => {
      source.emit("group.updated", { instanceId: "inst_1", name: "Ops Crew" }, "tok-1");
    });
    await waitFor(() => expect(screen.getByTestId("rows").textContent).toBe("Ops TeamOps Crew"));
    expect(fetchRows).toHaveBeenCalledTimes(1);
  });
});
