import { describe, expect, test, vi } from "vitest";
import { EMPTY_REASONS } from "../registry";
import { emptyPlan } from "./empty-copy";
import { mapError, signalOf } from "./error-map";
import {
  FORBIDDEN_TOAST_KINDS,
  FORBIDDEN_TOAST_SURFACE,
  TOAST_DEDUPE_MS,
  TOAST_DURATION,
  TOAST_MAX_VISIBLE,
  createToastQueue,
  toastEdge,
  toastFor,
} from "./toast-policy";
import { useAction } from "./use-action";

/**
 * The feedback layer's contract (docs/ui-decision.md §4.3–§4.5, R-T1–R-T5,
 * R-E1–R-E5, R-X1–R-X4).
 *
 * The forbidden table is the important half: R-T5's situations are enumerated
 * here as data, so an implementation that lets one of them reach a toast fails
 * a named case rather than passing on the ones it happened to think of. The
 * same is true of the error map — every stable worker `code` of draft §6.5 is
 * a row, and an unrecognised one must fall back and keep its raw code.
 *
 * Everything here is policy: no rendering, so this suite stays on the node
 * environment and runs without a DOM.
 */

describe("toast policy (R-T1..R-T5)", () => {
  test("durations are chosen by outcome class", () => {
    expect(TOAST_DURATION).toEqual({
      success: 4000,
      info: 5000,
      warning: 8000,
      errorRecoverable: 8000,
      errorBlocking: null,
    });
  });

  test("stacking and dedupe constants match the spec", () => {
    expect(TOAST_MAX_VISIBLE).toBe(3);
    expect(TOAST_DEDUPE_MS).toBe(8000);
    expect(toastFor({ action: "sync", targetId: "inst_1" }).dedupeKey).toBe("sync:inst_1");
  });

  test("background and load events never toast (R-T5)", () => {
    const cases = [
      "sse-reconnect",
      "group-renamed",
      "message-created",
      "media-state-changed",
      "send-awaiting-approval",
      "panel-load-failed",
      "form-validation",
      "ai-no-whitelist",
      "token-budget",
      "ambiguous-send",
      "connection-lost",
      "logged-out",
      "mongo-unreachable",
      "worker-unreachable",
      "status-transition",
    ] as const;
    for (const kind of cases) {
      expect(toastFor({ kind }).forbidden, `${kind} must not be toast-only`).toBe(true);
      expect(toastFor({ kind }).allowed, `${kind} must not produce a toast`).toBe(false);
      expect(FORBIDDEN_TOAST_SURFACE[kind].length, `${kind} must name its real surface`).toBeGreaterThan(0);
    }
    expect(FORBIDDEN_TOAST_KINDS).toEqual(cases);
    // Transport degradation has no toast at all, not merely "not only".
    expect(toastFor({ kind: "sse-reconnect" }).allowed).toBe(false);
    expect(toastFor({ kind: "group-renamed" }).allowed).toBe(false);
    expect(toastFor({ kind: "message-created" }).allowed).toBe(false);
    expect(toastFor({ kind: "panel-load-failed" }).allowed).toBe(false);
    expect(toastFor({ kind: "status-transition" }).allowed).toBe(false);
  });

  test("toast roles follow severity (R-T4)", () => {
    expect(toastFor({ action: "sync" }).role).toBe("status");
    expect(toastFor({ action: "sync", variant: "info" }).role).toBe("status");
    expect(toastFor({ action: "sync", variant: "warning" }).role).toBe("alert");
    expect(toastFor({ action: "sync", variant: "error" }).role).toBe("alert");
  });

  test("a recoverable error is offered a recovery; a blocking one is not (R-T1)", () => {
    expect(toastFor({ action: "sync", variant: "error", retryable: true }).duration).toBe(TOAST_DURATION.errorRecoverable);
    expect(toastFor({ action: "sync", variant: "error" }).duration).toBeNull();
    expect(toastFor({ action: "sync", variant: "error" }).class).toBe("errorBlocking");
  });

  test("position is bottom-right, bottom-centre below 640, and the top edge over a composer (R-T3, R-M5)", () => {
    expect(toastEdge({ viewportWidth: 1280 })).toBe("bottom-right");
    expect(toastEdge({ viewportWidth: 640 })).toBe("bottom-right");
    expect(toastEdge({ viewportWidth: 639 })).toBe("bottom-center");
    expect(toastEdge({ viewportWidth: 1280, overlayOpen: true })).toBe("top");
    expect(toastEdge({ viewportWidth: 360, overlayOpen: true })).toBe("top");
  });
});

describe("the toast queue (R-T1..R-T4)", () => {
  test("keeps three on screen and queues the rest, newest first", () => {
    vi.useFakeTimers();
    try {
      const queue = createToastQueue();
      for (const n of [1, 2, 3, 4]) {
        queue.push({ dedupeKey: `k${n}`, class: "info", role: "status", duration: TOAST_DURATION.info, title: `Row ${n}` });
      }

      expect(queue.records().map((record) => record.title)).toEqual(["Row 4", "Row 3", "Row 2"]);
      expect(queue.waiting().map((record) => record.title)).toEqual(["Row 1"]);

      // A dismissed toast frees its slot for the queued one; nothing is lost.
      queue.dismiss(queue.records()[0]!.id);
      expect(queue.records().map((record) => record.title)).toEqual(["Row 3", "Row 2", "Row 1"]);
      expect(queue.waiting()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a repeated operation inside the dedupe window counts, it does not stack (R-T3)", () => {
    vi.useFakeTimers();
    try {
      const queue = createToastQueue();
      queue.push({ dedupeKey: "sync:inst_1", class: "success", role: "status", duration: null, title: "Groups synced" });
      vi.advanceTimersByTime(1000);
      queue.push({ dedupeKey: "sync:inst_1", class: "success", role: "status", duration: null, title: "Groups synced" });

      expect(queue.records()).toHaveLength(1);
      expect(queue.records()[0]!.count).toBe(2);

      // Outside the window it is a new operation, not a repeat.
      queue.dismiss(queue.records()[0]!.id);
      vi.advanceTimersByTime(TOAST_DEDUPE_MS + 1);
      queue.push({ dedupeKey: "sync:inst_1", class: "success", role: "status", duration: null, title: "Groups synced" });
      expect(queue.records()).toHaveLength(1);
      expect(queue.records()[0]!.count).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a waiting toast does not spend its time off screen (R-T3)", () => {
    vi.useFakeTimers();
    try {
      const queue = createToastQueue();
      for (const n of [1, 2, 3, 4]) {
        queue.push({ dedupeKey: `k${n}`, class: "info", role: "status", duration: TOAST_DURATION.info, title: `Row ${n}` });
      }
      expect(queue.waiting().map((record) => record.title)).toEqual(["Row 1"]);

      // The three on screen leave on their own clock; the waiting one is not
      // running down behind them, and gets its full time once it is visible.
      vi.advanceTimersByTime(TOAST_DURATION.info);
      expect(queue.records().map((record) => record.title)).toEqual(["Row 1"]);
      expect(queue.waiting()).toEqual([]);

      vi.advanceTimersByTime(TOAST_DURATION.info - 1);
      expect(queue.records()).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(queue.records()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a toast leaves on its class's duration, and a held toast stays (R-T1, R-T2)", () => {
    vi.useFakeTimers();
    try {
      const queue = createToastQueue();
      const id = queue.push({ dedupeKey: "copy", class: "info", role: "status", duration: TOAST_DURATION.info, title: "Group ID copied" });

      queue.pause(id);
      vi.advanceTimersByTime(60_000);
      expect(queue.records()).toHaveLength(1);
      expect(queue.records()[0]!.paused).toBe(true);

      queue.resume(id);
      vi.advanceTimersByTime(TOAST_DURATION.info);
      expect(queue.records()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a blocking error waits for the operator, and a pending toast waits for its promise (R-T1, R-T2)", async () => {
    vi.useFakeTimers();
    try {
      const queue = createToastQueue();
      queue.push({ dedupeKey: "delete", class: "errorBlocking", role: "alert", duration: null, title: "Delete failed" });
      vi.advanceTimersByTime(600_000);
      expect(queue.records()).toHaveLength(1);

      // The promise is already resolved, but its `.then` runs as a microtask:
      // the record is still pending in the same task, which is exactly the
      // window R-T2's single updating toast lives in.
      queue.push({
        dedupeKey: "sync:inst_1",
        class: "success",
        role: "status",
        duration: TOAST_DURATION.success,
        title: "Groups synced",
        pendingLabel: "Syncing groups",
        promise: Promise.resolve("done"),
      });
      expect(queue.records()[0]!.state).toBe("pending");
      expect(queue.records()[0]!.pendingLabel).toBe("Syncing groups");
      vi.advanceTimersByTime(60_000);
      expect(queue.records()).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(0);
      expect(queue.records()[0]!.state).toBe("settled");
      vi.advanceTimersByTime(TOAST_DURATION.success);
      expect(queue.records().map((record) => record.title)).toEqual(["Delete failed"]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a rejected operation settles into the mapped failure, not its success copy (R-X1, R-X2)", async () => {
    const queue = createToastQueue();
    queue.push({
      dedupeKey: "sync:inst_offline",
      class: "success",
      role: "status",
      duration: TOAST_DURATION.success,
      title: "Groups synced",
      promise: Promise.reject({ code: "instance_offline" }),
    });

    await vi.waitFor(() => expect(queue.records()[0]!.state).toBe("settled"));
    const record = queue.records()[0]!;
    expect(record.class).toBe("errorRecoverable");
    expect(record.role).toBe("alert");
    expect(record.title).not.toBe("Groups synced");
    expect(record.title).toMatch(/live WhatsApp session/i);
  });
});

describe("useAction — the only toast emitter (R-T2, R-T5, R-A8)", () => {
  test("an action uses one updating toast, not loading-then-result (R-T2)", async () => {
    const push = vi.fn();
    const action = useAction({ push });
    await action.run({
      action: "sync",
      targetId: "inst_1",
      label: "Groups synced",
      promise: Promise.resolve({ total: 12, markedLeft: 1 }),
    });

    expect(push).toHaveBeenCalledTimes(1);
    const toast = push.mock.calls[0]![0] as { dedupeKey: string; promise: Promise<unknown>; title: string };
    expect(toast.dedupeKey).toBe("sync:inst_1");
    expect(toast.title).toBe("Groups synced");
    // The record carries the operation itself, so the queue settles it in place.
    expect(typeof toast.promise?.then).toBe("function");
  });

  test("an action returns its value, and a failure is reported rather than thrown (R-X2)", async () => {
    const push = vi.fn();
    const action = useAction({ push });

    const ok = await action.run({ action: "sync", label: "Groups synced", promise: Promise.resolve(12) });
    expect(ok).toEqual({ ok: true, data: 12 });

    const failed = await action.run({
      action: "sync",
      label: "Groups synced",
      promise: Promise.reject({ code: "group_sync_failed" }),
    });
    expect(failed.ok).toBe(false);
    expect(push).toHaveBeenCalledTimes(2);
  });

  test("a background event never reaches the queue, whatever a caller passes (R-T5)", async () => {
    const push = vi.fn();
    const action = useAction({ push });

    const outcome = await action.run({
      kind: "sse-reconnect",
      action: "stream",
      label: "Reconnecting",
      promise: Promise.resolve("connected"),
    });

    expect(outcome.ok).toBe(false);
    expect(push).not.toHaveBeenCalled();
  });

  test("a destructive action emits nothing until its dialog has confirmed (R-A8)", async () => {
    const push = vi.fn();
    const operation = vi.fn(() => Promise.resolve("gone"));
    const action = useAction({ push });
    const confirm = { title: "Delete this instance?", body: "Its stored groups and messages stay.", confirmLabel: "Delete" };

    const refused = await action.run({ action: "instance.delete", targetId: "inst_1", label: "Instance deleted", confirm, promise: operation });
    expect(refused.ok).toBe(false);
    expect(operation).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();

    const confirmed = await action.run({ action: "instance.delete", targetId: "inst_1", label: "Instance deleted", confirm, confirmed: true, promise: operation });
    expect(confirmed).toEqual({ ok: true, data: "gone" });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledTimes(1);
  });
});

describe("the error map (R-X1, R-X3, R-X4)", () => {
  /** Every stable `code` of draft §6.5, plus the BFF's own client codes. */
  const knownCodes = [
    "unauthorized",
    "internal",
    "store_error",
    "encode_error",
    "decode_error",
    "invalid_request",
    "invalid_state",
    "invalid_transition",
    "not_found",
    "group_not_found",
    "group_not_assigned",
    "method_not_allowed",
    "label_conflict",
    "instance_offline",
    "instance_cleanup_failed",
    "group_sync_failed",
    "foreign_media",
    "ai_no_whitelist",
    "ai_token_budget_exceeded",
    "not_whitelisted",
    "network",
    "timeout",
    "offline",
    "mongo_unreachable",
    "worker_unreachable",
    "r2_unavailable",
    "rate_limited",
  ];

  test("every known code has copy, a surface, and states what still works", () => {
    for (const code of knownCodes) {
      const mapped = mapError({ code });
      expect(mapped.title.length, `${code} has no title`).toBeGreaterThan(0);
      expect(["inline", "banner", "toast"], `${code} has no surface`).toContain(mapped.surface);
      expect(mapped.body, `${code} must state what still works`).toBeTruthy();
      expect(mapped.copyableCode, `${code} is known and must not be presented as unknown`).toBeUndefined();
    }
  });

  test("an unknown code falls back and keeps the raw code copyable (R-X1)", () => {
    const mapped = mapError({ code: "some_future_code" });

    expect(mapped.title).toMatch(/unexpected/i);
    expect(mapped.surface).toBe("inline");
    expect(mapped.copyableCode).toBe("some_future_code");
    expect(mapped.body).toBeTruthy();
    // A failure nobody understands is never offered a retry (R-X4).
    expect(mapped.retryable).toBe(false);
  });

  test("a dispatch failure is mapped by its class (R-X3)", () => {
    const ambiguous = mapError({ errorClass: "ambiguous" });
    expect(ambiguous.title).toMatch(/delivery is unknown/i);
    expect(ambiguous.body).toMatch(/will not be retried/i);
    expect(ambiguous.retryable).toBe(false);

    const auth = mapError({ errorClass: "auth" });
    expect(auth.surface).toBe("banner");
    expect(auth.body).toMatch(/re-pair/i);

    expect(mapError({ errorClass: "transport" }).retryable).toBe(true);
    expect(mapError({ errorClass: "rejected" }).surface).toBe("inline");
  });

  test("a logged-out runtime is a banner whose reads stay readable (R-X3)", () => {
    const mapped = mapError({ runtimeStatus: "logged_out" });

    expect(mapped.surface).toBe("banner");
    expect(mapped.body).toMatch(/readable/i);
    expect(mapped.retryable).toBe(false);
  });

  test("a failure with no code at all is still named, without reading the thrown value (R-X1)", () => {
    const stack = signalOf(
      Object.assign(new Error("MongoServerError: connect ECONNREFUSED 127.0.0.1:27017\n    at Connection.onError"), {
        name: "MongoServerError",
      }),
    );
    const mapped = mapError(stack);

    expect(mapped.copyableCode).toBeUndefined();
    expect(mapped.title).toMatch(/unexpected/i);
    expect(JSON.stringify(mapped)).not.toContain("ECONNREFUSED");
  });

  test("a client-side abort and a network failure name themselves (R-X3)", () => {
    expect(signalOf(Object.assign(new Error("aborted"), { name: "AbortError" }))).toEqual({ code: "timeout" });
    expect(signalOf(new TypeError("Failed to fetch"))).toEqual({ code: "network" });
    expect(mapError(signalOf(new TypeError("Failed to fetch"))).title).toMatch(/reach/i);
    expect(mapError(signalOf(Object.assign(new Error("aborted"), { name: "AbortError" }))).title).toMatch(/took too long/i);
  });
});

describe("empty copy (R-E1, R-E2, R-E5)", () => {
  const plan = emptyPlan({
    subject: "this instance",
    noun: "groups",
    prerequisite: "a group whitelist",
    create: { label: "Sync now", run: () => {} },
    clear: { label: "Clear filters", run: () => {} },
  });

  test("declares one copy for each of the five reasons", () => {
    expect(Object.keys(plan).sort()).toEqual([...EMPTY_REASONS].sort());
    for (const reason of EMPTY_REASONS) {
      expect(plan[reason].title.length, reason).toBeGreaterThan(0);
      expect(plan[reason].body, reason).toContain("this instance");
    }
  });

  test("an empty scope and an over-filtered one never share copy (R-E2)", () => {
    expect(plan["no-data"].title).not.toBe(plan.filtered.title);
    expect(plan["no-data"].body).not.toBe(plan.filtered.body);
    expect(plan["no-data"].action).toEqual({ label: "Sync now", run: expect.any(Function) });
    expect(plan.filtered.action).toEqual({ label: "Clear filters", run: expect.any(Function) });
  });

  test("a reason with no way out carries no action and names the prerequisite instead (R-E5)", () => {
    expect(plan.unconfigured.action).toBeUndefined();
    expect(plan.unconfigured.body).toContain("a group whitelist");
    expect(plan.unavailable.action).toBeUndefined();
    expect(plan["not-permitted"].action).toBeUndefined();
  });
});
