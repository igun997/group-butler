import type { InstanceSnapshot } from "@butler/shared";
import { describe, expect, test } from "vitest";
import { createInstanceFailure, pairingStage, pollsWhile } from "./instances";

const snapshot = (over: Partial<InstanceSnapshot> = {}): InstanceSnapshot => ({
  id: "inst_1",
  label: "Support bot",
  mode: "qr",
  status: "pairing",
  createdAt: "2026-09-14T09:00:00.000Z",
  ...over,
});

/**
 * What the pairing panel shows, given one worker snapshot. The worker owns this
 * lifecycle, so the console's only job is to read it correctly: show the payload
 * it was handed, keep asking while pairing, and say plainly why it stopped.
 */
describe("pairingStage", () => {
  test("while pairing, a QR payload is what the screen shows", () => {
    const stage = pairingStage(snapshot({ qr: "data:image/png;base64,AAAA" }));

    expect(stage).toEqual({ kind: "scan", qr: "data:image/png;base64,AAAA" });
  });

  test("a code-mode instance shows the code the worker produced", () => {
    const stage = pairingStage(snapshot({ mode: "code", pairingCode: "ABCD-1234" }));

    expect(stage).toEqual({ kind: "code", code: "ABCD-1234" });
  });

  test("pairing with neither payload yet is a wait, not an error", () => {
    expect(pairingStage(snapshot())).toEqual({ kind: "waiting" });
  });

  test("a connected instance reports the identity the worker knows", () => {
    const stage = pairingStage(
      snapshot({
        status: "connected",
        phoneNumber: "628990000001",
        botJid: "628990000001@s.whatsapp.net",
        botLid: "1234567890@lid",
        connectedAt: "2026-09-14T09:05:00.000Z",
        lastSeenAt: "2026-09-14T09:20:00.000Z",
      }),
    );

    expect(stage).toEqual({
      kind: "connected",
      identity: {
        phoneNumber: "628990000001",
        botJid: "628990000001@s.whatsapp.net",
        botLid: "1234567890@lid",
        connectedAt: "2026-09-14T09:05:00.000Z",
        lastSeenAt: "2026-09-14T09:20:00.000Z",
      },
    });
  });

  test("a device unlinked from the phone ends the flow and says so", () => {
    const stage = pairingStage(snapshot({ status: "logged_out" }));

    expect(stage.kind).toBe("stopped");
    if (stage.kind !== "stopped") throw new Error("expected the flow to stop");
    expect(stage.tone).toBe("failure");
    expect(stage.reason).toMatch(/unlinked/i);
  });

  test("the worker's own error text is used when it gave one", () => {
    const stage = pairingStage(snapshot({ status: "error", pairingError: "Pairing was refused by WhatsApp" }));

    expect(stage).toMatchObject({ kind: "stopped", tone: "failure", reason: "Pairing was refused by WhatsApp" });
  });

  test("an instance that is not linked and not pairing offers the next step", () => {
    const stage = pairingStage(snapshot({ status: "disconnected" }));

    expect(stage).toMatchObject({ kind: "stopped", tone: "idle" });
  });
});

describe("pollsWhile", () => {
  test("only pairing keeps the poll running", () => {
    expect(pollsWhile("pairing")).toBe(true);
    for (const status of ["connected", "logged_out", "error", "disconnected"] as const) {
      expect([status, pollsWhile(status)]).toEqual([status, false]);
    }
  });
});

/**
 * A refused create, turned into what the form shows. Branching is on the route's
 * `code`, never on its message text, and the route's own phrase is what the
 * operator reads when it gave one.
 */
describe("createInstanceFailure", () => {
  test("a label clash belongs on the label field", () => {
    const failure = createInstanceFailure(409, {
      code: "label_conflict",
      error: "an instance with that label already exists",
    });

    expect(failure).toEqual({
      field: "label",
      message: "an instance with that label already exists",
      retry: false,
    });
  });

  test("a rejected body is a form-level problem, and retrying is pointless", () => {
    const failure = createInstanceFailure(400, { code: "invalid_request", error: "label: Too small: expected string to have >=1 characters" });

    expect(failure.field).toBe("form");
    expect(failure.retry).toBe(false);
    expect(failure.message).toContain("label");
  });

  test("an unreachable worker is worth retrying", () => {
    const failure = createInstanceFailure(502, { code: "worker_unreachable", error: "the worker could not be reached" });

    expect(failure).toEqual({ field: "form", message: "the worker could not be reached", retry: true });
  });

  test("an answer nobody documented still says what happened", () => {
    const failure = createInstanceFailure(500, {});

    expect(failure.retry).toBe(true);
    expect(failure.field).toBe("form");
    expect(failure.message).toMatch(/500/);
  });
});
