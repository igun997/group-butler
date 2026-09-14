// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { emptyPlan, mapError, signalOf, toastQueue, TOAST_DURATION } from "../ui/feedback";
import { resourceCache, ResourceGate } from "../ui/resource";
import type { EmptyPlan, ResourceDescriptor, Scope, UIError } from "../ui/registry";
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

beforeEach(() => {
  resourceCache.clear();
  toastQueue.__reset();
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
