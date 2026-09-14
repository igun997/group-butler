// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * jsdom ships the `dialog` element without its methods. They are defined with the
 * spec's observable effect — the `open` state and the `close` event — so the
 * confirmation and the pairing surface's own paths run here; what `Esc` and the
 * focus trap do in a browser is verified in the browser.
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

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: navigation.push }) }));

import { ConfirmationHost } from "../../../../components/confirm-dialog";
import { toastQueue } from "../../../feedback";
import { resourceCache, streamCoordinator, type EventSourceLike } from "../../../resource";
import type { Scope } from "../../types";
import { InstanceConfigPanel, InstanceGroupsPanel, InstancePanel } from "./panel";

/**
 * The instance page as the operator meets it (docs/ui-decision.md §5 P6, R-L5,
 * R-X2, R-X3, §7.2).
 *
 * This suite drives the real panels: the real resource hook, the real stream
 * coordinator, the real action layer, the real toast queue and the real
 * confirmation store, with only the three edges a browser owns — `fetch`,
 * `EventSource` and the router — replaced. What is asserted is therefore what a
 * person perceives: the state the surface is in and the step it states, the fact
 * that a state change patches in place and never re-enters first paint, the
 * banner an instance in `logged_out` raises while its groups stay on screen, the
 * whitelist an empty configuration produces and the edit that fixes it, and the
 * confirmation a deletion must pass through.
 */

const INSTANCE: Scope = { kind: "instance", instanceId: "inst_1" };

const JID = "120363043123456789@g.us";
const OTHER_JID = "120363043999999999@g.us";
/** Any data URL: the surface renders whatever the worker published, byte for byte. */
const QR = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

const BASE = {
  id: "inst_1",
  label: "Support bot",
  mode: "qr",
  createdAt: "2026-09-14T08:00:00Z",
};

const DISCONNECTED = { ...BASE, status: "disconnected" };
const PAIRING = { ...BASE, status: "pairing", qr: QR };
const CONNECTED = {
  ...BASE,
  status: "connected",
  phoneNumber: "628990000001",
  botJid: "628990000001@s.whatsapp.net",
  connectedAt: "2026-09-14T08:10:00Z",
  lastSeenAt: "2026-09-14T09:00:00Z",
};
const LOGGED_OUT = { ...BASE, status: "logged_out" };
const CODE_MODE = { ...BASE, mode: "code", status: "pairing", phoneNumber: "628990000001" };
const CODE_ISSUED = { ...CODE_MODE, pairingCode: "1234-5678" };

const GROUP = {
  groupJid: JID,
  name: "Ops Team",
  nameSource: "sync",
  nameSetAt: "2026-09-13T08:12:00Z",
  nameSetBy: "4915112345678",
  participantCount: 12,
  state: "active",
  assigned: true,
  whitelisted: false,
  lastActivityAt: "2026-09-14T07:00:00Z",
  messageCount: 340,
  subjectHistory: [],
};

const OTHER_GROUP = { ...GROUP, groupJid: OTHER_JID, name: "Support", assigned: false, participantCount: 4 };

interface Call {
  url: string;
  method: string;
  body: unknown;
}

type Answer = { status?: number; body: unknown };
type Route = (call: Call) => Answer | undefined;

let calls: Call[] = [];
let routes: Route[] = [];

function answer(call: Call): Answer {
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

/** A session read answering `snapshot` in order, so a re-read can answer the next one. */
function snapshotRoute(...snapshots: unknown[]): Route {
  return (call) => (call.url === "/api/instances/inst_1" && call.method === "GET" ? { body: snapshots.shift() } : undefined);
}

/** The BFF-owned configuration, stored in this deployment's own database. */
function configRoute(groupJidWhitelist: readonly string[]): Route {
  return (call) =>
    call.url === "/api/instances/inst_1/config" && call.method === "GET"
      ? { body: { config: { instanceId: "inst_1", groupJidWhitelist } } }
      : undefined;
}

/** This instance's groups, which the table and the whitelist picker share. */
function groupsRoute(...pages: unknown[][]): Route {
  return (call) =>
    call.url === "/api/instances/inst_1/groups"
      ? { body: { instanceId: "inst_1", syncedAt: null, groups: pages.shift() ?? [] } }
      : undefined;
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

beforeEach(() => {
  calls = [];
  routes = [];
  navigation.push.mockClear();
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

/** Wait for a read's own surface, so an assertion is never made against a skeleton. */
async function settled(text: string | RegExp): Promise<void> {
  await waitFor(() => expect(screen.getByText(text)).toBeTruthy());
}

describe("pairing is a state, never a load (R-L5)", () => {
  test("disconnected → pairing traverses in place: the QR arrives without a skeleton", async () => {
    routes.push(snapshotRoute(DISCONNECTED, PAIRING));
    const stream = installStream();

    render(<InstancePanel scope={INSTANCE} params={{}} />);
    await settled("No live session. The instance is stored, but nothing is connected to WhatsApp.");
    await settled("Started 2026-09-14 08:00 UTC");
    // R-L5's elapsed time is its own line, and it is the worker's own stamp.
    expect(document.querySelector(".pairing-surface__elapsed")?.textContent).toContain("2026-09-14 08:00 UTC");
    expect(document.querySelector(".resource-skeleton")).toBeNull();

    // The worker persists `pairing`; the frame is how that lands here.
    act(() => stream.emit("instance.updated", { id: "inst_1", label: "Support bot", status: "pairing" }));

    await settled("Waiting for the code to be scanned.");
    expect(screen.getByRole("img", { name: /Pairing QR code/ }).getAttribute("src")).toBe(QR);
    // The surface was patched, not re-entered: no skeleton at any point.
    expect(document.querySelector(".resource-skeleton")).toBeNull();
    expect(document.querySelector(".resource-gate__bar")).toBeNull();
    expect(toastQueue.records()).toEqual([]);
  });

  test("pairing → connected traverses in place, and the identity the frame cannot carry is read once", async () => {
    routes.push(snapshotRoute(PAIRING, CONNECTED));
    const stream = installStream();

    render(<InstancePanel scope={INSTANCE} params={{}} />);
    await settled("Waiting for the code to be scanned.");

    act(() => stream.emit("instance.updated", { id: "inst_1", label: "Support bot", status: "connected" }));

    await waitFor(() =>
      expect(screen.getByText("Connected", { selector: ".state-badge" })).toBeTruthy(),
    );
    await settled("628990000001");
    expect(screen.getByText("628990000001@s.whatsapp.net")).toBeTruthy();
    expect(screen.getByText("2026-09-14 08:10 UTC")).toBeTruthy();
    // One re-read: the frame moved the state, the read carried the identity.
    expect(calls.filter((call) => call.url === "/api/instances/inst_1" && call.method === "GET")).toHaveLength(2);
    expect(document.querySelector(".resource-skeleton")).toBeNull();
    expect(toastQueue.records()).toEqual([]);
  });

  test("a frame that moves nothing is a no-op: no re-read, no render", async () => {
    routes.push(snapshotRoute(PAIRING));
    const stream = installStream();

    render(<InstancePanel scope={INSTANCE} params={{}} />);
    await settled("Waiting for the code to be scanned.");

    act(() => stream.emit("instance.updated", { id: "inst_1", label: "Support bot", status: "pairing" }));

    expect(calls.filter((call) => call.url === "/api/instances/inst_1" && call.method === "GET")).toHaveLength(1);
    expect(document.querySelector(".resource-skeleton")).toBeNull();
  });

  test("an error state is paired with the worker's own reason, and a way to leave", async () => {
    routes.push(snapshotRoute({ ...BASE, status: "error", pairingError: "the login websocket did not become ready" }));

    render(<InstancePanel scope={INSTANCE} params={{}} />);

    await settled("Pairing stopped");
    expect(screen.getByText("Pairing stopped before the account linked.")).toBeTruthy();
    expect(screen.getByText("the login websocket did not become ready")).toBeTruthy();
    // R-L5's leave affordance: a long-running state must not be a trap.
    expect(screen.getByRole("link", { name: "Back to instances" }).getAttribute("href")).toBe("/instances");
  });

  test("a code-mode instance asks the worker for a code and shows the code it issued", async () => {
    routes.push(snapshotRoute(CODE_MODE));
    routes.push((call) =>
      call.url === "/api/instances/inst_1/pairing-code" && call.method === "POST" ? { body: CODE_ISSUED } : undefined,
    );
    installStream();

    render(<InstancePanel scope={INSTANCE} params={{}} />);
    await settled("Waiting for the code to be entered on the phone.");

    fireEvent.click(screen.getByRole("button", { name: "Request a code" }));

    await settled("1234-5678");
    expect(calls.filter((call) => call.method === "POST")[0]?.url).toBe("/api/instances/inst_1/pairing-code");
    expect(toastQueue.records().map((record) => record.title)).toEqual(["Pairing code requested"]);
    // The surface renders the code the worker answered with, not a prediction.
    expect(screen.getByRole("button", { name: "Request a new code" })).toBeTruthy();
  });
});

describe("the logged-out instance (R-X3)", () => {
  test("the re-pair banner is raised while the instance's groups stay readable", async () => {
    routes.push(snapshotRoute(LOGGED_OUT));
    routes.push(groupsRoute([GROUP, OTHER_GROUP]));
    installStream();

    // The instance page: the session panel and the group table, at one address.
    render(
      <>
        <InstancePanel scope={INSTANCE} params={{}} />
        <InstanceGroupsPanel scope={INSTANCE} params={{}} />
      </>,
    );

    await settled("The instance is logged out of WhatsApp");
    // The banner's own copy, anchored so the surface's step line cannot answer it.
    expect(screen.getByText(/^Stored groups and messages stay readable/)).toBeTruthy();
    await settled("Ops Team");
    // Both statements are on screen at once: the failure, and the data that
    // does not need the session (§7.5).
    expect(screen.getByText(JID)).toBeTruthy();
    expect(document.querySelector(".resource-skeleton")).toBeNull();
    expect(toastQueue.records()).toEqual([]);
  });

  test("a session the worker cannot answer does not blank the configuration beside it (R-X2)", async () => {
    routes.push((call) =>
      call.url === "/api/instances/inst_1" && call.method === "GET"
        ? { status: 502, body: { code: "worker_unreachable", error: "connect ECONNREFUSED" } }
        : undefined,
    );
    routes.push(configRoute([JID]));
    routes.push(groupsRoute([GROUP, OTHER_GROUP]));
    installStream();

    render(
      <>
        <InstancePanel scope={INSTANCE} params={{}} />
        <InstanceConfigPanel scope={INSTANCE} params={{}} />
      </>,
    );

    await settled("The WhatsApp service is unreachable");
    // The other panel's reads are stored here, so they are still on screen.
    await settled("1 of 2 groups readable by the assistant");
    expect(screen.getByRole("checkbox", { name: /Ops Team/ }).hasAttribute("checked")).toBe(true);
    expect(toastQueue.records()).toEqual([]);
  });
});

describe("the whitelist editor (§7.2)", () => {
  test("an empty whitelist is the unconfigured state, and saving a choice leaves it (R-E1)", async () => {
    routes.push(configRoute([]));
    routes.push(groupsRoute([GROUP, OTHER_GROUP], [GROUP, OTHER_GROUP]));
    routes.push((call) =>
      call.url === "/api/instances/inst_1" && call.method === "PATCH"
        ? { body: { config: { instanceId: "inst_1", groupJidWhitelist: [JID] } } }
        : undefined,
    );
    installStream();

    render(<InstanceConfigPanel scope={INSTANCE} params={{}} />);

    await settled("Not set up yet");
    expect(screen.getByText("This instance cannot use the assistant until a group whitelist is set up.")).toBeTruthy();
    expect(screen.getByText("0 of 2 groups readable by the assistant")).toBeTruthy();

    // R-L8: a control disabled by resolved state says why (nothing to save yet).
    const save = screen.getByRole("button", { name: "Save whitelist" });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("checkbox", { name: /Ops Team/ }));
    expect((save as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(save);

    await settled("1 of 2 groups readable by the assistant");
    expect(await screen.findByRole("button", { name: "Save whitelist" })).toBeTruthy();
    expect(screen.queryByText("Not set up yet")).toBeNull();
    expect(screen.queryByText("0 of 2 groups readable by the assistant")).toBeNull();

    const patch = calls.find((call) => call.method === "PATCH");
    expect(patch?.url).toBe("/api/instances/inst_1");
    expect(patch?.body).toEqual({ groupJidWhitelist: [JID] });
    expect(toastQueue.records().map((record) => record.title)).toEqual(["Whitelist saved"]);
    // The write mirrors onto the rows (§5.1), so the table's own read re-reads
    // the flags it shows — silently (R-V3).
    await waitFor(() =>
      expect(calls.filter((call) => call.url === "/api/instances/inst_1/groups")).toHaveLength(2),
    );
    expect(document.querySelector(".resource-skeleton")).toBeNull();
  });

  test("a save the service refuses keeps the stored list on screen and is rendered in the panel", async () => {
    routes.push(configRoute([JID]));
    routes.push(groupsRoute([GROUP, OTHER_GROUP]));
    routes.push((call) =>
      call.url === "/api/instances/inst_1" && call.method === "PATCH"
        ? { status: 502, body: { code: "worker_unreachable", error: "connect ECONNREFUSED" } }
        : undefined,
    );
    installStream();

    render(<InstanceConfigPanel scope={INSTANCE} params={{}} />);
    await settled("1 of 2 groups readable by the assistant");

    fireEvent.click(screen.getByRole("checkbox", { name: /Support/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save whitelist" }));

    await settled("The WhatsApp service is unreachable");
    // Nothing was predicted: the stored list is still what the boxes say.
    expect(screen.getByRole("checkbox", { name: /Ops Team/ }).hasAttribute("checked")).toBe(true);
    expect(screen.getByRole("checkbox", { name: /Support/ }).hasAttribute("checked")).toBe(false);
    expect(toastQueue.records()).toEqual([]);
  });
});

describe("deleting an instance (R-A8)", () => {
  test("the deletion passes through the confirmation, and only then calls the worker", async () => {
    routes.push(snapshotRoute(LOGGED_OUT));
    routes.push((call) =>
      call.url === "/api/instances/inst_1" && call.method === "DELETE" ? { body: { ok: true } } : undefined,
    );
    installStream();

    render(
      <>
        <InstancePanel scope={INSTANCE} params={{}} />
        <ConfirmationHost />
      </>,
    );
    await settled("The instance is logged out of WhatsApp");

    fireEvent.click(screen.getByRole("button", { name: "Log out and delete" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Log out and delete this instance?")).toBeTruthy();
    expect(within(dialog).getByText(/logged out/i)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Log out and delete" }));

    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith("/instances"));
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.url)).toEqual([
      "/api/instances/inst_1",
    ]);
  });

  test("a decline runs nothing at all", async () => {
    routes.push(snapshotRoute(CONNECTED));
    installStream();

    render(
      <>
        <InstancePanel scope={INSTANCE} params={{}} />
        <ConfirmationHost />
      </>,
    );
    await waitFor(() =>
      expect(screen.getByText("Connected", { selector: ".state-badge" })).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Log out and delete" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
    expect(navigation.push).not.toHaveBeenCalled();
  });
});
