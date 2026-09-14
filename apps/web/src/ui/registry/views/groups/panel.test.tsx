// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * jsdom ships the `dialog` element without its methods. They are defined with the
 * spec's observable effect — the `open` state and the `close` event — so the
 * sheet's own close path runs here; what `Esc` and the focus trap do in a browser
 * is verified in the browser.
 */
function installDialogMethods(): void {
  const prototype = window.HTMLDialogElement.prototype;
  if (prototype.showModal !== undefined) return;
  prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  prototype.close = function close(this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  };
}

installDialogMethods();
import { toastQueue } from "../../../feedback";
import { resourceCache, streamCoordinator, type EventSourceLike } from "../../../resource";
import type { Scope } from "../../types";
import { GroupsPanel } from "./panel";

/**
 * The groups workspace as the operator meets it (docs/ui-decision.md §5 P5:
 * R11's acceptance, the config toggles, `Sync now`, and the live rename patch).
 *
 * This suite drives the real panel: the real resource hook, the real stream
 * coordinator, the real action layer, and the real toast queue, with only the
 * two edges a browser owns — `fetch` and `EventSource` — replaced. What is
 * asserted is therefore what a person perceives: the ID that is on screen and
 * copyable, the name that is not blank, the row a write turns into, the counts a
 * sync reports, and the fact that a rename moves the row without a toast and
 * without taking focus.
 */

const INSTANCE: Scope = { kind: "instance", instanceId: "inst_1" };
const GLOBAL: Scope = { kind: "global" };

const JID = "120363043123456789@g.us";

const ROW = {
  groupJid: JID,
  name: "Ops Team",
  nameSource: "sync",
  nameSetAt: "2026-09-13T08:12:00Z",
  nameSetBy: "4915112345678",
  participantCount: 12,
  state: "active",
  assigned: false,
  whitelisted: false,
  lastActivityAt: "2026-09-14T07:00:00Z",
  messageCount: 340,
  subjectHistory: [
    { name: "Ops", at: "2026-09-01T08:00:00Z", by: "4915112345678" },
    { name: "Team", at: null, by: null },
  ],
};

const FALLBACK = {
  ...ROW,
  groupJid: "120363043999999999@g.us",
  name: "(unnamed group) 120363043999999999",
  nameSource: "fallback",
  nameSetAt: null,
  nameSetBy: null,
  subjectHistory: [],
};

const SUMMARY = {
  ok: true,
  instanceId: "inst_1",
  durationMs: 412,
  source: "manual",
  total: 12,
  added: 1,
  subjectUpdated: 2,
  metadataUpdated: 0,
  markedLeft: 0,
  subjectRejected: 0,
  unchanged: 9,
};

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** The stub's answer for one address and method, in the order the calls arrive. */
type Route = (call: Call) => { status?: number; body: unknown } | undefined;

let calls: Call[] = [];
let routes: Route[] = [];

function answer(call: Call): { status?: number; body: unknown } {
  for (const route of routes) {
    const found = route(call);
    if (found) return found;
  }
  throw new Error(`the test did not route ${call.method} ${call.url}`);
}

function installFetch(): void {
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const call: Call = {
      url: String(input),
      method: init.method ?? "GET",
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    calls.push(call);
    const found = answer(call);
    return new Response(JSON.stringify(found.body), {
      status: found.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
}

/** The page a read answers with: rows, and the instance's sync stamp. */
function groupsPage(groups: readonly unknown[], syncedAt: string | null = null) {
  return { instanceId: "inst_1", syncedAt, groups };
}

/** The one `EventSource` of the tab, driven by the test (the real coordinator owns it). */
interface FakeStream {
  emit(type: string, data: unknown): void;
}

function installStream(): FakeStream {
  const listeners = new Map<string, ((event: { data: string; lastEventId: string }) => void)[]>();
  const source: EventSourceLike = {
    onopen: null,
    onerror: null,
    addEventListener(type, listener) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    close() {},
  };
  streamCoordinator.__setEventSourceFactory(() => source);

  return {
    emit(type, data) {
      for (const listener of listeners.get(type) ?? []) {
        listener({ data: JSON.stringify(data), lastEventId: "1" });
      }
    },
  };
}

/** jsdom has no media query engine; the breakpoint is the test's to set. */
function setViewport(compact: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: compact,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const RENAME = {
  type: "group.updated",
  instanceId: "inst_1",
  groupJid: JID,
  changes: ["subject"],
  name: "Ops Team 2",
  previousName: "Ops Team",
  nameSetAt: "2026-09-14T09:00:00Z",
  state: "active",
  occurredAt: "2026-09-14T09:00:01Z",
};

beforeEach(() => {
  calls = [];
  routes = [];
  resourceCache.clear();
  streamCoordinator.__reset();
  toastQueue.__reset();
  setViewport(false);
  installFetch();
});

afterEach(() => {
  cleanup();
  streamCoordinator.__setEventSourceFactory(null);
  streamCoordinator.__reset();
  toastQueue.__reset();
  resourceCache.clear();
  vi.unstubAllGlobals();
});

/** Wait for the panel to have rendered its rows. */
async function rows(): Promise<HTMLTableRowElement[]> {
  return await waitFor(() => {
    const found = document.querySelectorAll<HTMLTableRowElement>(".groups-table tbody tr");
    expect(found.length).toBeGreaterThan(0);
    return [...found];
  });
}

describe("the groups table (R11)", () => {
  test("every row shows the whole ID, a non-empty name, its state and its config", async () => {
    routes.push(() => ({ body: groupsPage([ROW, FALLBACK], "2026-09-14T07:00:00Z") }));
    installStream();

    render(<GroupsPanel scope={INSTANCE} params={{}} />);
    const found = await rows();

    expect(found).toHaveLength(2);
    const first = within(found[0]!);
    expect(first.getByText(JID)).toBeTruthy();
    expect(first.getByText("Ops Team")).toBeTruthy();
    expect(first.getByRole("button", { name: /renamed 2×/ })).toBeTruthy();
    expect(first.getByText("set by 4915112345678 on 2026-09-13 08:12 UTC")).toBeTruthy();
    expect(first.getByText("Active")).toBeTruthy();
    expect(first.getByRole("button", { name: "Not assigned" }).getAttribute("aria-pressed")).toBe("false");

    // The never-blank rule: a group nothing has synced yet still reads as a group.
    const second = within(found[1]!);
    expect(second.getByText("(unnamed group) 120363043999999999")).toBeTruthy();
    expect(second.getByText("Name not synced yet")).toBeTruthy();
  });

  test("the copy control is named by the full ID it copies (R-A6)", async () => {
    routes.push(() => ({ body: groupsPage([ROW]) }));
    installStream();

    render(<GroupsPanel scope={INSTANCE} params={{}} />);
    await rows();

    expect(screen.getByRole("button", { name: `Copy group ID ${JID}` })).toBeTruthy();
  });

  test("the global address names each row's instance and offers no instance-scoped sync", async () => {
    routes.push(() => ({
      body: { groups: [{ ...ROW, instanceId: "inst_1", instanceLabel: "Ops Team bot" }] },
    }));
    installStream();

    render(<GroupsPanel scope={GLOBAL} params={{}} />);
    await rows();

    expect(screen.getByText("Ops Team bot")).toBeTruthy();
    expect(screen.getByText("1 group across 1 instance")).toBeTruthy();
    // A sync is one instance's, and this address names none.
    expect(screen.queryByRole("button", { name: "Sync now" })).toBeNull();
  });

  test("an instance that has never synced says so, and one that has says when", async () => {
    routes.push(() => ({ body: groupsPage([ROW], "2026-09-14T08:00:00Z") }));
    installStream();

    const first = render(<GroupsPanel scope={INSTANCE} params={{}} />);
    await waitFor(() => expect(screen.getByText("Last sync 2026-09-14 08:00 UTC")).toBeTruthy());
    first.unmount();

    routes = [() => ({ body: groupsPage([ROW], null) })];
    resourceCache.clear();
    render(<GroupsPanel scope={INSTANCE} params={{}} />);
    await waitFor(() => expect(screen.getByText("Never synced")).toBeTruthy());
  });

  test("the global address claims no freshness it cannot know (the cross-instance read has no stamp)", async () => {
    routes.push(() => ({
      body: { groups: [{ ...ROW, instanceId: "inst_1", instanceLabel: "Ops Team bot" }] },
    }));
    installStream();

    render(<GroupsPanel scope={GLOBAL} params={{}} />);
    await rows();

    expect(screen.queryByText(/Never synced/)).toBeNull();
    expect(screen.queryByText(/Last sync/)).toBeNull();
  });

  test("below md the same rows are label/value cards, never a table that scrolls", async () => {
    setViewport(true);
    routes.push(() => ({ body: groupsPage([ROW]) }));
    installStream();

    render(<GroupsPanel scope={INSTANCE} params={{}} />);
    await waitFor(() => expect(document.querySelectorAll(".groups-cards__item").length).toBe(1));

    expect(document.querySelector(".groups-table")).toBeNull();
    expect(screen.getByText("Group ID")).toBeTruthy();
    expect(screen.getByText(JID)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Not assigned" })).toBeTruthy();
  });
});

describe("assign and whitelist (P5, R-L9)", () => {
  test("a toggle writes one field, names the instance, and renders the row the server returned", async () => {
    let patched: unknown = undefined;
    routes.push((call) => {
      if (call.method === "PATCH") {
        patched = call.body;
        return { body: { group: { ...ROW, assigned: true } } };
      }
      return { body: groupsPage([ROW]) };
    });
    installStream();

    render(<GroupsPanel scope={INSTANCE} params={{}} />);
    const [row] = await rows();
    fireEvent.click(within(row!).getByRole("button", { name: "Not assigned" }));

    await waitFor(() =>
      expect(within(row!).getByRole("button", { name: "Assigned" }).getAttribute("aria-pressed")).toBe("true"),
    );
    expect(patched).toEqual({ assigned: true, instanceId: "inst_1" });
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(1);
    // The operator's own action is the one thing a toast may report (R-T2).
    expect(toastQueue.records().map((record) => record.title)).toEqual(["Group assigned"]);
  });

  test("a refused write keeps the row as it was and renders the failure where the toast refused it", async () => {
    routes.push((call) => {
      if (call.method === "PATCH") return { status: 502, body: { error: "no worker", code: "worker_unreachable" } };
      return { body: groupsPage([ROW]) };
    });
    installStream();

    render(<GroupsPanel scope={INSTANCE} params={{}} />);
    const [row] = await rows();
    fireEvent.click(within(row!).getByRole("button", { name: "Not whitelisted" }));

    await waitFor(() => expect(screen.getByText("The WhatsApp service is unreachable")).toBeTruthy());
    // Nothing was predicted: the row still says what the server last said.
    expect(within(row!).getByRole("button", { name: "Not whitelisted" }).getAttribute("aria-pressed")).toBe("false");
    // R-T5: a durable operational failure is not carried by a toast alone.
    expect(toastQueue.records()).toEqual([]);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

describe("Sync now (P5, R-L5)", () => {
  test("the counts on screen are the worker's, and the read is refreshed silently", async () => {
    let reads = 0;
    routes.push((call) => {
      if (call.method === "POST") return { body: SUMMARY };
      reads += 1;
      // The first read has nothing named yet; the sync is what resolves it.
      return reads === 1
        ? { body: groupsPage([FALLBACK], null) }
        : { body: groupsPage([{ ...FALLBACK, name: "Ops Team", nameSource: "sync" }], "2026-09-14T09:00:02Z") };
    });
    installStream();

    render(<GroupsPanel scope={INSTANCE} params={{}} />);
    await rows();
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));

    await waitFor(() =>
      expect(screen.getByText("Manual sync: 12 groups read, 1 added, 2 renamed, 0 left in 412 ms")).toBeTruthy(),
    );
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "POST")[0]!.url).toBe("/api/instances/inst_1/groups/sync");
    expect(toastQueue.records().map((record) => record.title)).toEqual(["Groups synced"]);
    // The fallback name resolved against what the sync stored (P5's acceptance).
    await waitFor(() => expect(screen.getByText("Ops Team")).toBeTruthy());
    expect(screen.queryByText("Name not synced yet")).toBeNull();
  });

  test("a failed sync states the failure and never a count", async () => {
    routes.push((call) => {
      if (call.method === "POST") return { status: 409, body: { error: "offline", code: "instance_offline" } };
      return { body: groupsPage([ROW], null) };
    });
    installStream();

    render(<GroupsPanel scope={INSTANCE} params={{}} />);
    await rows();
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));

    await waitFor(() => expect(screen.getByText("This instance has no live WhatsApp session")).toBeTruthy());
    expect(screen.queryByText(/Manual sync:/)).toBeNull();
    expect(toastQueue.records()).toEqual([]);
  });

  test("the empty address offers the action that creates data (R-E1)", async () => {
    let reads = 0;
    routes.push((call) => {
      if (call.method === "POST") return { body: SUMMARY };
      reads += 1;
      return { body: reads === 1 ? groupsPage([], null) : groupsPage([ROW], "2026-09-14T09:00:02Z") };
    });
    installStream();

    render(<GroupsPanel scope={INSTANCE} params={{}} />);
    await waitFor(() => expect(screen.getByText("No groups yet")).toBeTruthy());
    expect(screen.getByText("This instance has no groups recorded yet.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(screen.getByText("Ops Team")).toBeTruthy());
  });
});

describe("a rename that arrives live (R-V1, R-V2, R-V4)", () => {
  test("the row, the header, and the scope's label move in one pass, with no toast and no focus theft", async () => {
    routes.push(() => ({ body: groupsPage([ROW, FALLBACK]) }));
    const stream = installStream();

    render(<GroupsPanel scope={INSTANCE} params={{}} />);
    const [row] = await rows();
    const copy = within(row!).getByRole("button", { name: `Copy group ID ${JID}` });
    copy.focus();
    expect(document.activeElement).toBe(copy);

    act(() => stream.emit("group.updated", RENAME));

    // The row: the name and its provenance moved, and identity did not.
    await waitFor(() => expect(within(row!).getByText("Ops Team 2")).toBeTruthy());
    expect(within(row!).getByRole("button", { name: /renamed 3×/ })).toBeTruthy();
    expect(within(row!).queryByText("set by 4915112345678 on 2026-09-13 08:12 UTC")).toBeNull();
    expect(focusLabel()).toBe(`Copy group ID ${JID}`);

    // The header: the workspace states what happened.
    expect(screen.getByText(`Renamed: Ops Team is now Ops Team 2 · ${JID}, 2026-09-14 09:00 UTC`)).toBeTruthy();

    // R-T2/R-V2: data is not a notification.
    expect(toastQueue.records()).toEqual([]);
  });

  test("a frame that carries no name leaves the fallback in place until one is named", async () => {
    routes.push(() => ({ body: groupsPage([FALLBACK]) }));
    const stream = installStream();

    render(<GroupsPanel scope={INSTANCE} params={{}} />);
    await rows();

    act(() => stream.emit("group.updated", { ...RENAME, groupJid: FALLBACK.groupJid, name: "", previousName: null }));
    expect(screen.getByText(FALLBACK.name)).toBeTruthy();
    expect(screen.getByText("Name not synced yet")).toBeTruthy();

    act(() =>
      stream.emit("group.updated", {
        ...RENAME,
        groupJid: FALLBACK.groupJid,
        name: "Finance",
        previousName: null,
      }),
    );
    await waitFor(() => expect(screen.getByText("Finance")).toBeTruthy());
    expect(screen.queryByText("Name not synced yet")).toBeNull();
    expect(screen.getByText(`Renamed to Finance · ${FALLBACK.groupJid}, 2026-09-14 09:00 UTC`)).toBeTruthy();
  });

  test("a frame for another instance changes nothing here", async () => {
    routes.push(() => ({ body: groupsPage([ROW]) }));
    const stream = installStream();

    render(<GroupsPanel scope={INSTANCE} params={{}} />);
    await rows();

    act(() => stream.emit("group.updated", { ...RENAME, instanceId: "inst_2" }));

    expect(screen.getByText("Ops Team")).toBeTruthy();
    expect(screen.queryByText(/Renamed:/)).toBeNull();
  });
});

describe("the rename history (R-V4, R-A1)", () => {
  test("the chip opens the names the group used to have, newest first", async () => {
    routes.push(() => ({ body: groupsPage([ROW, FALLBACK]) }));
    installStream();

    render(<GroupsPanel scope={INSTANCE} params={{}} />);
    const [row] = await rows();
    fireEvent.click(within(row!).getByRole("button", { name: /renamed 2×/ }));

    const sheet = await waitFor(() => {
      const found = document.querySelector("dialog.history-sheet");
      expect(found).toBeTruthy();
      return found!;
    });
    expect(within(sheet as HTMLElement).getByText("Ops Team")).toBeTruthy();
    expect(within(sheet as HTMLElement).getByText(JID)).toBeTruthy();
    const entries = [...sheet.querySelectorAll(".history-sheet__entry")];
    expect(entries.map((entry) => entry.textContent)).toEqual([
      "Opsset by 4915112345678 on 2026-09-01 08:00 UTC",
      "Team",
    ]);
  });

  test("a group that has never been renamed has nothing to open", async () => {
    routes.push(() => ({ body: groupsPage([FALLBACK]) }));
    installStream();

    render(<GroupsPanel scope={INSTANCE} params={{}} />);
    await rows();

    expect(screen.queryByRole("button", { name: /renamed/ })).toBeNull();
  });

  test("closing the sheet puts focus back on the chip that opened it (R-A1)", async () => {
    routes.push(() => ({ body: groupsPage([ROW]) }));
    installStream();

    render(<GroupsPanel scope={INSTANCE} params={{}} />);
    const [row] = await rows();
    const chip = within(row!).getByRole("button", { name: /renamed 2×/ });
    fireEvent.click(chip);

    const sheet = document.querySelector("dialog.history-sheet")!;
    // The browser closes the dialog on `Esc` and fires `close`; the workspace owns
    // what happens next, and what happens next is where the operator was.
    act(() => sheet.dispatchEvent(new Event("close")));

    await waitFor(() => expect(document.querySelector("dialog.history-sheet")).toBeNull());
    expect(document.activeElement).toBe(chip);
  });

  test("a rename that lands while the sheet is open is a new entry in it", async () => {
    routes.push(() => ({ body: groupsPage([ROW]) }));
    const stream = installStream();

    render(<GroupsPanel scope={INSTANCE} params={{}} />);
    const [row] = await rows();
    fireEvent.click(within(row!).getByRole("button", { name: /renamed 2×/ }));
    await waitFor(() => expect(document.querySelector("dialog.history-sheet")).toBeTruthy());

    act(() => stream.emit("group.updated", RENAME));

    await waitFor(() => {
      const entries = [...document.querySelectorAll(".history-sheet__entry")];
      expect(entries.map((entry) => entry.textContent)).toEqual([
        "Ops Teamset by 4915112345678 on 2026-09-13 08:12 UTC",
        "Opsset by 4915112345678 on 2026-09-01 08:00 UTC",
        "Team",
      ]);
    });
    // And the sheet still names the group by what it is called now.
    expect(within(document.querySelector("dialog.history-sheet") as HTMLElement).getByText("Ops Team 2")).toBeTruthy();
  });
});

/** The accessible name of whatever currently has focus. */
function focusLabel(): string | null {
  const active = document.activeElement;
  if (active === null) return null;
  const label = active.getAttribute("aria-label");
  return label ?? active.textContent;
}
