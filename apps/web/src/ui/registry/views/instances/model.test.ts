import type { InstanceSnapshot } from "@butler/shared";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { scopeLabels, type StreamFrame } from "../../../resource";
import { applyCreatedInstance, applyInstanceFrame, createInstance, readInstances } from "./model";

/**
 * The instances read model (docs/ui-decision.md §4.2 R-V1/V4, §4.5 R-X1; draft
 * §6.5).
 *
 * What is asserted is the wire contract and the one live patch: the exact body a
 * create sends, the exact shape a read accepts, and the four rules a frame is
 * held to — it moves only the row it names, it never reorders, a frame about
 * another instance is not this one's, and a frame whose status vocabulary has
 * drifted is dropped rather than rendered.
 */

const SNAPSHOT: InstanceSnapshot = {
  id: "inst_1",
  label: "Support bot",
  mode: "qr",
  status: "connected",
  createdAt: "2026-09-01T08:00:00Z",
};

const OTHER: InstanceSnapshot = {
  id: "inst_2",
  label: "Ops bot",
  mode: "code",
  status: "pairing",
  phoneNumber: "628990000001",
  pairingCode: "1234-5678",
  createdAt: "2026-09-02T08:00:00Z",
};

interface Call {
  url: string;
  method: string;
  body: unknown;
}

let calls: Call[] = [];
let answers: { status?: number; body: unknown }[] = [];

beforeEach(() => {
  calls = [];
  answers = [];
  scopeLabels.clear();
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    calls.push({
      url: String(input),
      method: init.method ?? "GET",
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const answer = answers.shift() ?? { body: {} };
    return new Response(JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
});

function frame(data: unknown): StreamFrame {
  return { id: "1", type: "instance.updated", data };
}

describe("reading the worker's instance list (§6.5)", () => {
  test("the rows are the wire's own, and each one teaches the scope its name", async () => {
    answers.push({ body: { instances: [SNAPSHOT, OTHER] } });

    const instances = await readInstances();

    expect(calls[0]).toEqual({ url: "/api/instances", method: "GET", body: undefined });
    expect(instances).toHaveLength(2);
    expect(scopeLabels.read({ kind: "instance", instanceId: "inst_2" })).toBe("Ops bot");
  });

  test("a page this build cannot read is a declared decode error, not undefined fields", async () => {
    answers.push({ body: { instances: [{ id: "inst_1", label: "Support bot" }] } });

    await expect(readInstances()).rejects.toMatchObject({ code: "decode_error" });
  });

  test("the server's own code is kept, and nothing else from its answer", async () => {
    answers.push({ status: 502, body: { code: "worker_unreachable", error: "connect ECONNREFUSED 10.0.0.7" } });

    await expect(readInstances()).rejects.toMatchObject({ code: "worker_unreachable" });
  });
});

describe("creating an instance (§6.5 POST /instances)", () => {
  test("an address that is not JSON names the status it was refused with", async () => {
    answers.push({ status: 401, body: "not json" });

    await expect(readInstances()).rejects.toMatchObject({ code: "unauthorized" });
  });

  test("the create sends the worker's own body and answers the pairing snapshot", async () => {
    answers.push({ status: 201, body: { ...OTHER } });

    const created = await createInstance({ label: "  Ops bot  ", mode: "code", phoneNumber: "628990000001" });

    expect(calls[0]).toEqual({
      url: "/api/instances",
      method: "POST",
      body: { label: "Ops bot", mode: "code", phoneNumber: "628990000001" },
    });
    expect(created.status).toBe("pairing");
    expect(scopeLabels.read({ kind: "instance", instanceId: "inst_2" })).toBe("Ops bot");
  });

  test("a QR create carries no number, because the worker's field is empty for it", async () => {
    answers.push({ status: 201, body: { ...SNAPSHOT, status: "pairing" } });

    await createInstance({ label: "Support bot", mode: "qr", phoneNumber: "628990000001" });

    expect(calls[0]!.body).toEqual({ label: "Support bot", mode: "qr" });
  });

  test("a snapshot this build cannot read is a declared decode error", async () => {
    answers.push({ status: 201, body: { id: "inst_1" } });

    await expect(createInstance({ label: "Support bot", mode: "qr" })).rejects.toMatchObject({ code: "decode_error" });
  });
});

describe("one instance.updated frame", () => {
  test("it moves the row it names, in place, and never reorders the list", () => {
    const rows = [SNAPSHOT, OTHER];

    const moved = applyInstanceFrame(rows, frame({ id: "inst_1", label: "Support bot", status: "logged_out" }));

    expect(moved.map((row) => row.id)).toEqual(["inst_1", "inst_2"]);
    expect(moved[0]).toMatchObject({ status: "logged_out", mode: "qr", createdAt: SNAPSHOT.createdAt });
    // The other row is the same object: a frame is a patch, not a rebuild.
    expect(moved[1]).toBe(OTHER);
  });

  test("a frame about an instance this list does not hold changes nothing", () => {
    const rows = [SNAPSHOT];

    expect(applyInstanceFrame(rows, frame({ id: "inst_404", label: "Gone", status: "error" }))).toBe(rows);
  });

  test("a status this build does not know drops the frame instead of the vocabulary", () => {
    const rows = [SNAPSHOT];

    expect(applyInstanceFrame(rows, frame({ id: "inst_1", label: "Support bot", status: "quantum" }))).toBe(rows);
  });

  test("a frame that carries no label is not a rename", () => {
    const rows = [SNAPSHOT];

    const moved = applyInstanceFrame(rows, frame({ id: "inst_1", label: "", status: "pairing" }));

    expect(moved[0]).toMatchObject({ label: "Support bot", status: "pairing" });
  });

  test("an unchanged row is the same value, so a repeat of the last frame costs no render", () => {
    const rows = [SNAPSHOT];

    expect(applyInstanceFrame(rows, frame({ id: "inst_1", label: "Support bot", status: "connected" }))).toBe(rows);
  });

  test("a created instance is appended once, and the row is the worker's own answer", () => {
    const rows = [SNAPSHOT];

    const once = applyCreatedInstance(rows, OTHER);
    expect(once.map((row) => row.id)).toEqual(["inst_1", "inst_2"]);
    expect(applyCreatedInstance(once, OTHER)).toBe(once);
  });
});
