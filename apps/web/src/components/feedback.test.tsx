// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { confirmationStore, emptyPlan, mapError, signalOf, toastQueue, TOAST_DURATION, type MappedError } from "../ui/feedback";
import { resourceCache, ResourceGate } from "../ui/resource";
import type { EmptyPlan, ResourceDescriptor, Scope, UIError } from "../ui/registry";
import { AppShell } from "./app-shell";
import { ConfirmationHost } from "./confirm-dialog";
import { EmptyState } from "./empty-state";
import { ErrorState } from "./error-state";
import { Toaster } from "./toaster";

/**
 * The feedback layer as the operator meets it: the empty and error surfaces,
 * and the one notification region (docs/ui-decision.md §4.3–§4.5).
 *
 * `@testing-library/react` runs the real components, so this suite renders in
 * jsdom. What is asserted is what a person perceives — the heading, the one
 * control, the announced text — never the class names that produce it.
 */

const GLOBAL: Scope = { kind: "global" };

const EMPTY: EmptyPlan = emptyPlan({ subject: "this instance", noun: "rows" });

function makeResource<D>(
  id: string,
  fetch: (ctx: { scope: Scope; params: unknown }) => Promise<D>,
  extra: Partial<ResourceDescriptor<D, unknown>> = {},
): ResourceDescriptor<D, unknown> {
  return {
    id,
    key: () => id,
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

/**
 * jsdom ships the `dialog` element without its methods, which is why the shell's
 * own suites render it to static markup and leave the modal behaviour to a
 * browser. These tests drive the interaction, so the two methods are defined
 * with the spec's observable effect — the `open` state and the `close` event —
 * and nothing else. The elements they stand in for (the focus trap, `Esc`, the
 * browser's own focus restoration) are verified in a real browser.
 */
function installDialogMethods(): void {
  const prototype = window.HTMLDialogElement.prototype;
  if (prototype.showModal !== undefined) return;
  prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  prototype.show = function show(this: HTMLDialogElement) {
    this.open = true;
  };
  prototype.close = function close(this: HTMLDialogElement) {
    if (!this.open) return;
    this.open = false;
    this.dispatchEvent(new Event("close"));
  };
}

beforeEach(() => {
  installDialogMethods();
  resourceCache.clear();
  toastQueue.__reset();
  confirmationStore.__reset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("EmptyState (R-E1, R-E2, R-E5)", () => {
  test("renders the declared reason's copy under the region's own heading", () => {
    const run = vi.fn();
    render(
      <EmptyState
        reason="no-data"
        copy={{ title: "No groups yet", body: "This instance has no groups synced yet.", action: { label: "Sync now", run } }}
      />,
    );

    expect(screen.getByRole("heading", { level: 2, name: "No groups yet" })).toBeDefined();
    expect(screen.getByText("This instance has no groups synced yet.")).toBeDefined();

    // The way out is the region's only control, and it is a real operation.
    const action = screen.getByRole("button", { name: "Sync now" });
    action.click();
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("a reason with no way out renders no control and names the prerequisite (R-E5)", () => {
    render(
      <EmptyState
        reason="unconfigured"
        copy={{ title: "Not configured", body: "Choose a group whitelist before the assistant can answer." }}
      />,
    );

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/group whitelist/)).toBeDefined();
  });

  test("a link action keeps its destination", () => {
    render(<EmptyState reason="not-permitted" copy={{ title: "Not permitted", body: "Go back.", action: { label: "Return to groups", href: "/groups" } }} />);

    expect(screen.getByRole("link", { name: "Return to groups" }).getAttribute("href")).toBe("/groups");
  });
});

describe("ErrorState (R-X1, R-X2, R-X4)", () => {
  test("a retryable failure offers exactly the call that failed", () => {
    const retry = vi.fn();
    render(<ErrorState error={mapError({ code: "group_sync_failed" })} onRetry={retry} />);

    expect(screen.getByText(/group sync failed/i)).toBeDefined();
    screen.getByRole("button", { name: "Try again" }).click();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test("a failure with no recovery path states the resulting state and offers nothing (R-X4)", () => {
    render(<ErrorState error={mapError({ errorClass: "ambiguous" })} onRetry={vi.fn()} />);

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/will not be retried/i)).toBeDefined();
  });

  test("an unknown code is shown as a copyable monospace chip, never as prose (R-X1)", () => {
    const { container } = render(<ErrorState error={mapError({ code: "some_future_code" })} onRetry={vi.fn()} />);

    expect(container.querySelector("code")?.textContent).toBe("some_future_code");
    expect(screen.getByText(/unexpected/i)).toBeDefined();
    // Nobody knows what this failure means, so no retry is offered.
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("a navigation recovery is a link, not a dead button", () => {
    const error: UIError = {
      code: "ai_no_whitelist",
      title: "The assistant has no groups to read",
      body: "Nothing was sent to the model. Choose groups in the whitelist to enable answers.",
      action: { label: "Choose groups", kind: "navigate", href: "/instances/inst_1" },
      surface: "inline",
      retryable: false,
    };
    render(<ErrorState error={error} />);

    expect(screen.getByRole("link", { name: "Choose groups" }).getAttribute("href")).toBe("/instances/inst_1");
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("a stack or a driver message never reaches the DOM (R-X1)", () => {
    const mapped = mapError(
      signalOf(new Error("MongoServerError: connect ECONNREFUSED 127.0.0.1:27017\n    at Connection.onError")),
    );
    const { container } = render(<ErrorState error={mapped} onRetry={vi.fn()} />);

    expect(container.textContent).not.toContain("ECONNREFUSED");
    expect(container.textContent).not.toContain("Connection.onError");
    expect(container.textContent).toMatch(/unexpected/i);
  });

  test("the gate renders the mapped surface inline without blanking the workspace (R-X2)", async () => {
    const resource = makeResource<string[]>("gate-unknown", () => Promise.reject({ code: "some_future_code" }), {
      errorMap: (error) => mapError(signalOf(error)),
    });
    render(
      <ResourceGate resource={resource} scope={GLOBAL} label="Rows">
        {(view) => <p>{(view.data ?? []).join(",")}</p>}
      </ResourceGate>,
    );

    await screen.findByText(/unexpected/i);
    expect(screen.getByText("some_future_code")).toBeDefined();
  });

  test("a failed load renders inline and never reaches the notification stack (R-T5, R-X2)", async () => {
    const resource = makeResource<string[]>("gate-no-toast", () => Promise.reject({ code: "store_error" }), {
      errorMap: (error) => mapError(signalOf(error)),
    });
    render(
      <>
        <Toaster />
        <ResourceGate resource={resource} scope={GLOBAL} label="Rows">
          {(view) => <p>{(view.data ?? []).join(",")}</p>}
        </ResourceGate>
      </>,
    );

    await screen.findByText(/could not read its own state/i);
    expect(toastQueue.records()).toEqual([]);
    expect(screen.getByTestId("live-assertive").textContent).toBe("");
  });

  test("the gate renders the declared empty reason through EmptyState (R-E1)", async () => {
    const resource = makeResource<string[]>("gate-empty", () => Promise.resolve([]), {
      empty: { ...EMPTY, filtered: { title: "No rows match", body: "This instance has rows, but none match the current filters." } },
    });
    render(
      <ResourceGate resource={resource} scope={GLOBAL} label="Rows" emptyReason="filtered">
        {() => <p>rows</p>}
      </ResourceGate>,
    );

    expect(await screen.findByRole("heading", { level: 2, name: "No rows match" })).toBeDefined();
    expect(screen.queryByText("rows")).toBeNull();
  });
});

describe("Toaster (R-T1..R-T4)", () => {
  test("keeps one polite and one assertive shell region, and announces through them", () => {
    render(<Toaster />);

    expect(document.querySelectorAll('[data-testid^="live-"]')).toHaveLength(2);

    act(() => {
      toastQueue.push({ dedupeKey: "copy:jid", class: "info", role: "status", duration: TOAST_DURATION.info, title: "Group ID copied" });
    });
    expect(screen.getByRole("region", { name: "Notifications" })).toBeDefined();
    expect(screen.getByTestId("live-polite").textContent).toContain("Group ID copied");
    expect(screen.getByTestId("live-assertive").textContent).toBe("");
  });

  test("a warning or an error is announced assertively (R-T4)", () => {
    render(<Toaster />);
    act(() => {
      toastQueue.push({ dedupeKey: "sync:inst_1", class: "errorRecoverable", role: "alert", duration: TOAST_DURATION.errorRecoverable, title: "Groups sync failed" });
    });

    expect(screen.getByTestId("live-assertive").textContent).toContain("Groups sync failed");
    expect(screen.getByTestId("live-polite").textContent).toBe("");
  });

  test("a toast holds at most one control, and a holding pointer pauses its dismissal (R-T2, R-T4)", () => {
    vi.useFakeTimers();
    render(<Toaster />);
    const retry = vi.fn();
    act(() => {
      toastQueue.push({
        dedupeKey: "sync:inst_1",
        class: "errorRecoverable",
        role: "alert",
        duration: TOAST_DURATION.errorRecoverable,
        title: "Groups sync failed",
        action: { label: "Try again", kind: "retry", run: retry },
      });
    });

    expect(screen.getAllByRole("button")).toHaveLength(1);
    const card = screen.getByTestId("toast");
    fireEvent.mouseEnter(card);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByTestId("toast")).toBeDefined();

    fireEvent.mouseLeave(card);
    act(() => {
      vi.advanceTimersByTime(TOAST_DURATION.errorRecoverable);
    });
    expect(screen.queryByTestId("toast")).toBeNull();
  });

  test("showing and dismissing a toast never moves focus (R-T4)", () => {
    render(
      <>
        <button type="button">Invoking control</button>
        <Toaster />
      </>,
    );
    const invoking = screen.getByRole("button", { name: "Invoking control" });
    invoking.focus();

    act(() => {
      toastQueue.push({ dedupeKey: "sync:inst_1", class: "success", role: "status", duration: TOAST_DURATION.success, title: "Groups synced" });
    });
    expect(document.activeElement).toBe(invoking);

    act(() => {
      toastQueue.dismiss(toastQueue.records()[0]!.id);
    });
    expect(document.activeElement).toBe(invoking);
  });

  test("an operation in flight is shown as pending and announced only when it lands (R-T2, R-A7)", async () => {
    render(<Toaster />);
    act(() => {
      toastQueue.push({
        dedupeKey: "sync:inst_1",
        class: "success",
        role: "status",
        duration: TOAST_DURATION.success,
        title: "Groups synced",
        pendingLabel: "Syncing groups",
        promise: Promise.resolve(),
      });
    });

    // Still pending in this task: the card says what is happening, and the
    // live region stays silent because R-A7 announces outcomes, not intentions.
    expect(screen.getByTestId("toast").textContent).toContain("Syncing groups");
    expect(screen.getByTestId("live-polite").textContent).toBe("");

    await act(async () => {});
    expect(screen.getByTestId("toast").textContent).toContain("Groups synced");
    expect(screen.getByTestId("live-polite").textContent).toContain("Groups synced");
  });

  test("an unrecognised failure carries its raw code as the copyable chip (R-X1)", () => {
    render(<Toaster />);
    act(() => {
      toastQueue.push({
        dedupeKey: "run:inst_1",
        class: "errorBlocking",
        role: "alert",
        duration: null,
        title: "Something unexpected happened",
        body: "The dashboard does not recognise this failure.",
        copyableCode: "some_future_code",
      });
    });

    expect(screen.getByTestId("toast").querySelector("code")?.textContent).toBe("some_future_code");
  });

  test("a blocking error keeps a manual dismiss as its one control (R-T1, R-T4)", () => {
    render(<Toaster />);
    act(() => {
      toastQueue.push({ dedupeKey: "instance.delete:inst_1", class: "errorBlocking", role: "alert", duration: null, title: "Instance delete failed" });
    });

    act(() => {
      screen.getByRole("button", { name: "Dismiss" }).click();
    });
    expect(screen.queryByTestId("toast")).toBeNull();
  });
});

/**
 * The confirmation interaction (docs/ui-decision.md §4.6 R-A8, §4.5 R-X2, §4.1
 * R-L9). These are behaviour tests, not markup tests: what matters is that the
 * operation cannot run without the operator's agreement, that the dialog owns
 * the pending state while it does, and that a failure stays on screen.
 */
describe("the confirmation dialog (R-A8, R-X2, R-L9)", () => {
  const PLAN = { title: "Delete this instance?", body: "Its stored groups and messages stay.", confirmLabel: "Delete" };

  test("puts the plan to the operator and runs nothing until they agree", async () => {
    const run = vi.fn(async () => undefined);
    render(<ConfirmationHost />);

    let answered: Promise<boolean> | undefined;
    act(() => {
      answered = confirmationStore.ask(PLAN, run);
    });

    expect(screen.getByRole("dialog")).toBeDefined();
    expect(screen.getByText("Delete this instance?")).toBeDefined();
    expect(screen.getByText("Its stored groups and messages stay.")).toBeDefined();
    expect(run).not.toHaveBeenCalled();
    // The least destructive control takes focus, so a stray Enter cannot
    // destroy anything.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));

    await act(async () => {
      screen.getByRole("button", { name: "Delete" }).click();
    });

    expect(run).toHaveBeenCalledTimes(1);
    await expect(answered).resolves.toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("a cancelled confirmation runs nothing and answers false", async () => {
    const run = vi.fn(async () => undefined);
    render(<ConfirmationHost />);

    let answered: Promise<boolean> | undefined;
    act(() => {
      answered = confirmationStore.ask(PLAN, run);
    });
    await act(async () => {
      screen.getByRole("button", { name: "Cancel" }).click();
    });

    expect(run).not.toHaveBeenCalled();
    await expect(answered).resolves.toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("holds the confirm control in pending while the operation runs (R-L9)", async () => {
    const settle: { finish: () => void } = { finish: () => {} };
    const run = vi.fn(
      () =>
        new Promise<undefined>((resolve) => {
          settle.finish = () => resolve(undefined);
        }),
    );
    render(<ConfirmationHost />);

    act(() => {
      void confirmationStore.ask(PLAN, run);
    });
    act(() => {
      screen.getByRole("button", { name: "Delete" }).click();
    });

    const confirm = screen.getByRole("button", { name: /delete/i });
    expect(confirm.getAttribute("aria-busy")).toBe("true");
    expect(confirm.textContent).toContain("…");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", true);

    await act(async () => {
      settle.finish();
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("keeps a failed operation on screen with the mapped failure, and restores focus (R-X2, R-X4, R-A1)", async () => {
    const failure = mapError({ code: "instance_cleanup_failed" }, "action");
    render(
      <>
        <button type="button">Delete instance</button>
        <ConfirmationHost />
      </>,
    );
    const invoker = screen.getByRole("button", { name: "Delete instance" });
    invoker.focus();

    let answered: Promise<boolean> | undefined;
    act(() => {
      answered = confirmationStore.ask(PLAN, async () => failure);
    });
    await act(async () => {
      screen.getByRole("button", { name: "Delete" }).click();
    });

    // R-X2: the dialog MUST NOT dismiss on failure — the evidence stays here.
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(screen.getByText(/could not be removed/i)).toBeDefined();
    // R-X4: for a transition the recovery is the confirmation itself, so the
    // failure offers no retry of its own.
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
    // The failed attempt left the confirm control usable again, and the
    // operator's focus is back on the control it started on.
    expect(screen.getByRole("button", { name: "Delete" })).toHaveProperty("disabled", false);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));

    await act(async () => {
      screen.getByRole("button", { name: "Cancel" }).click();
    });
    await expect(answered).resolves.toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(invoker);
  });

  test("a rapid second activation cannot run the destructive operation twice (R-A8)", async () => {
    const settle: { finish: (failure?: MappedError) => void } = { finish: () => {} };
    const run = vi.fn(
      () =>
        new Promise<MappedError | undefined>((resolve) => {
          settle.finish = (failure) => resolve(failure);
        }),
    );
    render(<ConfirmationHost />);

    let answered: Promise<boolean> | undefined;
    act(() => {
      answered = confirmationStore.ask(PLAN, run);
    });

    // Two activations in one task, before React commits the pending state — the
    // window a double click or a held Enter opens.
    const confirm = screen.getByRole("button", { name: "Delete" });
    act(() => {
      confirm.click();
      confirm.click();
    });
    expect(run).toHaveBeenCalledTimes(1);

    // The attempt's failure ends it, and one later retry is allowed — once.
    await act(async () => {
      settle.finish(mapError({ code: "instance_cleanup_failed" }, "action"));
    });
    expect(screen.getByText(/could not be removed/i)).toBeDefined();

    act(() => {
      screen.getByRole("button", { name: "Delete" }).click();
      screen.getByRole("button", { name: "Delete" }).click();
    });
    expect(run).toHaveBeenCalledTimes(2);

    await act(async () => {
      settle.finish(undefined);
    });
    await expect(answered).resolves.toBe(true);
    expect(screen.queryByText("Delete this instance?")).toBeNull();
  });

  test("queues a second question behind the first, one modal at a time", async () => {
    render(<ConfirmationHost />);
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);

    act(() => {
      void confirmationStore.ask(PLAN, first);
      void confirmationStore.ask({ ...PLAN, title: "Delete this group?" }, second);
    });

    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByText("Delete this instance?")).toBeDefined();

    await act(async () => {
      screen.getByRole("button", { name: "Delete" }).click();
    });
    expect(second).not.toHaveBeenCalled();
    expect(screen.getByText("Delete this group?")).toBeDefined();
  });
});

/**
 * R-M5 through the shell: the small-viewport navigation sheet is a real owner of
 * the bottom edge, and the notification stack moves to the top while it is open.
 */
describe("R-M5 ownership in the shell", () => {
  test("an open navigation sheet moves the stack to the top edge", async () => {
    render(
      <AppShell title="Overview" scopeLabel="All instances">
        <p>panel</p>
      </AppShell>,
    );

    expect(document.querySelector(".toast-region")?.getAttribute("data-edge")).toBe("bottom-right");

    await act(async () => {
      screen.getByRole("button", { name: "Navigation" }).click();
    });
    expect(document.querySelector(".toast-region")?.getAttribute("data-edge")).toBe("top");

    await act(async () => {
      screen.getByRole("button", { name: "Close navigation" }).click();
    });
    expect(document.querySelector(".toast-region")?.getAttribute("data-edge")).toBe("bottom-right");
    expect(toastQueue.overlayOpen()).toBe(false);
  });

  test("mounts the one confirmation host with the shell", async () => {
    render(
      <AppShell title="Overview" scopeLabel="All instances">
        <p>panel</p>
      </AppShell>,
    );

    expect(screen.queryByText("Delete this instance?")).toBeNull();
    act(() => {
      void confirmationStore.ask({ title: "Delete this instance?", body: "Its stored groups stay.", confirmLabel: "Delete" }, async () => undefined);
    });
    expect(screen.getByText("Delete this instance?")).toBeDefined();
  });
});
