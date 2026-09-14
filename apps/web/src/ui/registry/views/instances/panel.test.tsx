// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * jsdom ships the `dialog` element without its methods, defined here with the
 * spec's observable effect — the `open` state and the `close` event — so the
 * form dialog's own open and close paths run. What `Esc` and the focus trap do in
 * a browser is verified in the browser.
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

import { toastQueue } from "../../../feedback";
import { resourceCache, streamCoordinator, type EventSourceLike } from "../../../resource";
import type { Scope } from "../../types";
import { InstancesPanel } from "./panel";

/**
 * The instances workspace as the operator meets it (docs/ui-decision.md §5 P6:
 * the estate's list, the create, the live status patch, and the two surfaces a
 * read can fall back to).
 *
 * This suite drives the real panel: the real resource hook, the real stream
 * coordinator, the real action layer, and the real toast queue, with only the
 * three edges a browser owns — `fetch`, `EventSource`, and the router — replaced.
 * What is asserted is therefore what a person perceives: which instances are on
 * screen, that the address is copyable under its own name, what a create sends,
 * and that a status change moves a row without a toast and without losing it.
 */

const GLOBAL: Scope = { kind: "global" };

const SUPPORT = {
  id: "inst_1",
  label: "Support bot",
  mode: "qr",
  status: "connected",
  phoneNumber: "628990000001",
  botJid: "628990000001@s.whatsapp.net",
  connectedAt: "2026-09-01T08:05:00Z",
  lastSeenAt: "2026-09-14T07:00:00Z",
  createdAt: "2026-09-01T08:00:00Z",
};

const OPS = {
  id: "inst_2",
  label: "Ops bot",
  mode: "code",
  status: "pairing",
  phoneNumber: "628990000002",
  pairingCode: "1234-5678",
  createdAt: "2026-09-02T08:00:00Z",
};

interface Call {
  url: string;
  method: string;
  body: unknown;
}

let calls: Call[] = [];
let routes: { status?: number; body: unknown }[] = [];

function installFetch(): void {
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    calls.push({
      url: String(input),
      method: init.method ?? "GET",
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const answer = routes.shift() ?? { body: {} };
    return new Response(JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
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

/** Wait for the list to have rendered its rows. */
async function rows(): Promise<HTMLTableRowElement[]> {
  return await waitFor(() => {
    const found = document.querySelectorAll<HTMLTableRowElement>(".instances-table tbody tr");
    expect(found.length).toBeGreaterThan(0);
    return [...found];
  });
}

describe("the estate's list (P6)", () => {
  test("every row shows its label as a link, its full ID, its state, and the stamps it has", async () => {
    routes.push({ body: { instances: [SUPPORT, OPS] } });
    installStream();

    render(<InstancesPanel scope={GLOBAL} params={{}} />);
    const found = await rows();

    expect(found).toHaveLength(2);
    const first = within(found[0]!);
    expect(first.getByRole("link", { name: "Support bot" }).getAttribute("href")).toBe("/instances/inst_1");
    expect(first.getByText("inst_1")).toBeTruthy();
    expect(first.getByText("Connected")).toBeTruthy();
    expect(first.getByText("628990000001")).toBeTruthy();
    expect(first.getByText("2026-09-14 07:00 UTC")).toBeTruthy();
    expect(first.getByText("2026-09-01 08:00 UTC")).toBeTruthy();

    const second = within(found[1]!);
    expect(second.getByText("Pairing")).toBeTruthy();
    // The estate counts itself: two instances, one of them connected.
    expect(screen.getByText("2 instances, 1 connected")).toBeTruthy();
  });

  test("the copy control is named for the value it copies (R-A6)", async () => {
    routes.push({ body: { instances: [SUPPORT] } });
    installStream();

    render(<InstancesPanel scope={GLOBAL} params={{}} />);
    await rows();

    expect(screen.getByRole("button", { name: "Copy instance ID inst_1" })).toBeTruthy();
  });

  test("below md the same rows are label/value cards, never a table that scrolls", async () => {
    setViewport(true);
    routes.push({ body: { instances: [SUPPORT] } });
    installStream();

    render(<InstancesPanel scope={GLOBAL} params={{}} />);
    await waitFor(() => expect(document.querySelectorAll(".instances-cards__item").length).toBe(1));

    expect(document.querySelector(".instances-table")).toBeNull();
    expect(screen.getByText("Instance ID")).toBeTruthy();
    expect(screen.getByText("inst_1")).toBeTruthy();
  });

  test("an estate with nothing in it offers the action that creates one (R-E1)", async () => {
    routes.push({ body: { instances: [] } });
    installStream();

    render(<InstancesPanel scope={GLOBAL} params={{}} />);

    await waitFor(() => expect(screen.getByText("No instances yet")).toBeTruthy());
    expect(screen.getByText("This dashboard has no instances recorded yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create instance" }));

    expect(document.querySelector("dialog")?.open).toBe(true);
  });

  test("a failed read is inline in its panel and is never a toast (R-X2, R-T5)", async () => {
    routes.push({ status: 502, body: { code: "worker_unreachable", error: "connect ECONNREFUSED" } });
    installStream();

    render(<InstancesPanel scope={GLOBAL} params={{}} />);

    await waitFor(() => expect(screen.getByText("The WhatsApp service is unreachable")).toBeTruthy());
    expect(toastQueue.records()).toEqual([]);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  test("one instance.updated frame moves that row's state in place, with no toast (R-V1, R-V2)", async () => {
    routes.push({ body: { instances: [SUPPORT, OPS] } });
    const stream = installStream();

    render(<InstancesPanel scope={GLOBAL} params={{}} />);
    await rows();

    act(() => stream.emit("instance.updated", { id: "inst_1", label: "Support bot", status: "logged_out" }));

    const found = await rows();
    expect(within(found[0]!).getByText("Logged out")).toBeTruthy();
    // The row it did not name is untouched, and the rows keep their order.
    expect(within(found[1]!).getByText("Pairing")).toBeTruthy();
    expect(toastQueue.records()).toEqual([]);
  });
});

describe("creating an instance (P6)", () => {
  test("the dialog validates before it sends anything (R-T5)", async () => {
    routes.push({ body: { instances: [SUPPORT] } });
    installStream();

    render(<InstancesPanel scope={GLOBAL} params={{}} />);
    await rows();
    fireEvent.click(screen.getByRole("button", { name: "Create instance" }));
    fireEvent.click(screen.getByRole("button", { name: "Create and pair" }));

    expect(await screen.findByText(/Give the instance a label/)).toBeTruthy();
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  test("code pairing asks for the number, and a create sends the worker's own body", async () => {
    routes.push({ body: { instances: [] } });
    routes.push({ status: 201, body: { ...OPS } });
    installStream();

    render(<InstancesPanel scope={GLOBAL} params={{}} />);
    await waitFor(() => expect(screen.getByText("No instances yet")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Create instance" }));

    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "Ops bot" } });
    fireEvent.click(screen.getByRole("radio", { name: /Phone code/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create and pair" }));

    expect(await screen.findByText(/Code pairing needs the number/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "628990000002" } });
    fireEvent.click(screen.getByRole("button", { name: "Create and pair" }));

    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith("/instances/inst_2"));
    expect(calls.filter((call) => call.method === "POST")[0]).toEqual({
      url: "/api/instances",
      method: "POST",
      body: { label: "Ops bot", mode: "code", phoneNumber: "628990000002" },
    });
    expect(toastQueue.records().map((record) => record.title)).toEqual(["Instance created"]);
  });

  test("a create the worker refuses keeps the dialog open with the failure (R-X2)", async () => {
    routes.push({ body: { instances: [] } });
    routes.push({ status: 409, body: { code: "label_conflict", error: "an instance with that label already exists" } });
    installStream();

    render(<InstancesPanel scope={GLOBAL} params={{}} />);
    await waitFor(() => expect(screen.getByText("No instances yet")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Create instance" }));
    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "Support bot" } });
    fireEvent.click(screen.getByRole("button", { name: "Create and pair" }));

    // The dialog stays, and this failure's home is the toast (R-T5 does not
    // forbid announcing an operator's own refused action).
    await waitFor(() =>
      expect(toastQueue.records().map((record) => record.title)).toEqual([
        "An instance with that label already exists",
      ]),
    );
    expect(document.querySelector("dialog")?.open).toBe(true);
    expect(navigation.push).not.toHaveBeenCalled();
  });

  test("a failure the toast refuses to carry is rendered in the dialog", async () => {
    routes.push({ body: { instances: [] } });
    routes.push({ status: 502, body: { code: "worker_unreachable", error: "connect ECONNREFUSED" } });
    installStream();

    render(<InstancesPanel scope={GLOBAL} params={{}} />);
    await waitFor(() => expect(screen.getByText("No instances yet")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Create instance" }));
    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "Support bot" } });
    fireEvent.click(screen.getByRole("button", { name: "Create and pair" }));

    await waitFor(() => expect(screen.getByText("The WhatsApp service is unreachable")).toBeTruthy());
    expect(toastQueue.records()).toEqual([]);
    expect(document.querySelector("dialog")?.open).toBe(true);
  });
});
