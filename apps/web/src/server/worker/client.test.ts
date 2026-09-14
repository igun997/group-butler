import { afterEach, describe, expect, test, vi } from "vitest";
import { InstanceSnapshotSchema, type InstanceSnapshot } from "@butler/shared";
import {
  WORKER_BODY_MAX_BYTES,
  callWorker,
  createWorkerInstance,
  getWorkerInstance,
  listWorkerInstances,
  requestWorkerGroupSync,
  requestWorkerPairingCode,
  workerFailureResponse,
} from "./client";
import { jsonAnswer as answer, truncatedAnswer, withStubWorker as withWorker } from "./test-helpers";

const instance: InstanceSnapshot = {
  id: "V1StGXR8_Z5jdHi6B-myT",
  label: "Ops bot",
  mode: "qr",
  status: "connected",
  phoneNumber: "628990000002",
  botJid: "628990000002@s.whatsapp.net",
  connectedAt: "2026-09-12T09:30:00Z",
  lastSeenAt: "2026-09-14T01:05:00Z",
  createdAt: "2026-09-01T08:00:00Z",
};

const summary = {
  ok: true,
  instanceId: instance.id,
  durationMs: 480,
  source: "manual" as const,
  total: 12,
  added: 2,
  subjectUpdated: 1,
  metadataUpdated: 3,
  markedLeft: 1,
  subjectRejected: 0,
  unchanged: 8,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("worker client transport", () => {
  test("sends the worker's bearer token to the documented route", async () => {
    await withWorker(answer(200, { instances: [instance] }), async (worker) => {
      const result = await listWorkerInstances();

      expect(result).toEqual({ ok: true, data: { instances: [instance] } });
      expect(worker.requests).toHaveLength(1);
      expect(worker.requests[0]).toMatchObject({
        method: "GET",
        url: "/instances",
        authorization: "Bearer worker-secret",
      });
    });
  });

  test("percent-encodes every path segment, so an id cannot escape its route", async () => {
    await withWorker(answer(404, { code: "not_found", error: "no" }), async (worker) => {
      await getWorkerInstance("../../health");

      expect(worker.requests[0]!.url).toBe("/instances/..%2F..%2Fhealth");
    });
  });

  test("gives up at the deadline and reports the worker unreachable", async () => {
    // The deadline is `AbortSignal.timeout` against a real socket, so the clock
    // has to be the platform's: fake timers do not drive the transport's abort.
    await withWorker(answer(200, instance, 1_000), async () => {
      const result = await callWorker({
        segments: ["instances", instance.id],
        schema: InstanceSnapshotSchema,
        timeoutMs: 60,
      });

      expect(result).toEqual({
        ok: false,
        failure: { status: 502, code: "worker_unreachable", message: expect.any(String) },
      });
    });
  });

  test("refuses an answer larger than the body cap instead of buffering it", async () => {
    const oversized = { ...instance, label: "x".repeat(WORKER_BODY_MAX_BYTES) };
    await withWorker(answer(200, oversized), async () => {
      const result = await getWorkerInstance(instance.id);

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.failure.code).toBe("internal");
    });
  });

  test("reports a missing or unparseable worker address as unreachable", async () => {
    vi.stubEnv("WORKER_URL", "");
    expect(await listWorkerInstances()).toMatchObject({ ok: false, failure: { status: 502, code: "worker_unreachable" } });

    vi.stubEnv("WORKER_URL", "not a url");
    expect(await listWorkerInstances()).toMatchObject({ ok: false, failure: { status: 502, code: "worker_unreachable" } });
  });

  test("reports a connection nobody answers as unreachable", async () => {
    vi.stubEnv("WORKER_URL", "http://127.0.0.1:1");
    vi.stubEnv("WORKER_SECRET", "worker-secret");

    expect(await listWorkerInstances()).toMatchObject({ ok: false, failure: { status: 502, code: "worker_unreachable" } });
  });

  test("reports an answer it cannot read as an upstream failure", async () => {
    await withWorker(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("<html>not json</html>");
      },
      async () => {
        expect(await listWorkerInstances()).toMatchObject({ ok: false, failure: { status: 502, code: "internal" } });
      },
    );
  });

  test("refuses an answer the worker contract does not accept", async () => {
    await withWorker(answer(200, { instances: [{ ...instance, status: "syncing" }] }), async () => {
      expect(await listWorkerInstances()).toMatchObject({ ok: false, failure: { status: 502, code: "internal" } });
    });
  });

  test("does not follow a redirect away from the worker", async () => {
    await withWorker(
      (_req, res) => {
        res.writeHead(301, { location: "http://127.0.0.1:1/instances" });
        res.end();
      },
      async (worker) => {
        const result = await listWorkerInstances();

        expect(result).toMatchObject({ ok: false, failure: { status: 502, code: "worker_unreachable" } });
        expect(worker.requests).toHaveLength(1);
      },
    );
  });

  test("reports a body that dies mid-read instead of throwing out of the client", async () => {
    await withWorker(truncatedAnswer(), async () => {
      const result = await listWorkerInstances();

      expect(result).toMatchObject({
        ok: false,
        failure: { status: 502, code: "worker_unreachable", message: expect.any(String) },
      });
    });
  });

  test("reports a mid-read failure with one of its own phrases, never the transport's", async () => {
    await withWorker(truncatedAnswer(), async () => {
      const result = await listWorkerInstances();

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.message).not.toMatch(/terminated|aborted|socket|ECONN|fetch failed/i);
    });
  });
});

describe("worker error mapping", () => {
  test("passes a documented code through at the status the browser acts on", async () => {
    await withWorker(answer(404, { code: "not_found", error: "instance not found" }), async () => {
      expect(await getWorkerInstance("gone")).toEqual({
        ok: false,
        failure: { status: 404, code: "not_found", message: expect.any(String) },
      });
    });
  });

  test("never echoes the worker's own error text", async () => {
    await withWorker(
      answer(500, { code: "internal", error: "mongo write failed for org_secret_42 at 10.0.0.7" }),
      async () => {
        const result = await getWorkerInstance("inst_1");

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.failure.code).toBe("internal");
        expect(result.failure.status).toBe(502);
        expect(result.failure.message).not.toContain("org_secret_42");
        expect(result.failure.message).not.toContain("10.0.0.7");
      },
    );
  });

  test("maps a refused credential to the code the dashboard explains", async () => {
    await withWorker(
      answer(401, { code: "unauthorized", error: "missing or invalid bearer token" }),
      async () => {
        expect(await listWorkerInstances()).toEqual({
          ok: false,
          failure: { status: 502, code: "unauthorized", message: expect.any(String) },
        });
      },
    );
  });

  test("maps a code this dashboard does not know to an upstream failure", async () => {
    await withWorker(answer(418, { code: "teapot", error: "brewing" }), async () => {
      const result = await listWorkerInstances();

      expect(result).toEqual({
        ok: false,
        failure: { status: 502, code: "internal", message: expect.any(String) },
      });
    });
  });

  test("maps an error body it cannot read to an upstream failure", async () => {
    await withWorker(
      (_req, res) => {
        res.writeHead(409);
        res.end("conflict");
      },
      async () => {
        expect(await listWorkerInstances()).toMatchObject({ ok: false, failure: { status: 502, code: "internal" } });
      },
    );
  });
});

describe("workerFailureResponse", () => {
  test("answers with the mapped code and refuses to be cached", async () => {
    const response = workerFailureResponse({ status: 409, code: "instance_offline", message: "offline" });

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ code: "instance_offline", error: "offline" });
  });
});

describe("typed worker endpoints", () => {
  test("creates an instance with a JSON body and reads the pairing snapshot back", async () => {
    await withWorker(answer(201, { ...instance, status: "pairing", qr: "data:image/png;base64,AAAA" }), async (worker) => {
      const result = await createWorkerInstance({ label: "Ops bot", mode: "qr" });

      expect(result).toMatchObject({ ok: true, data: { status: "pairing", qr: "data:image/png;base64,AAAA" } });
      expect(worker.requests[0]).toMatchObject({ method: "POST", url: "/instances" });
      expect(worker.requests[0]!.contentType).toBe("application/json");
      expect(JSON.parse(worker.requests[0]!.body)).toEqual({ label: "Ops bot", mode: "qr" });
    });
  });

  test("requests a pairing code on the worker's pairing route", async () => {
    await withWorker(answer(200, { ...instance, status: "pairing", pairingCode: "1234-5678" }), async (worker) => {
      const result = await requestWorkerPairingCode(instance.id);

      expect(result).toMatchObject({ ok: true, data: { pairingCode: "1234-5678" } });
      expect(worker.requests[0]).toMatchObject({ method: "POST", url: `/instances/${instance.id}/pairing-code` });
    });
  });

  test("returns the sync summary the worker reported", async () => {
    await withWorker(answer(200, summary), async (worker) => {
      const result = await requestWorkerGroupSync(instance.id);

      expect(result).toEqual({ ok: true, data: summary });
      expect(worker.requests[0]).toMatchObject({ method: "POST", url: `/instances/${instance.id}/groups/sync` });
    });
  });

  test("reports a failed sync as a failure rather than a success", async () => {
    await withWorker(
      answer(502, { code: "group_sync_failed", error: "GetJoinedGroups: iq timeout" }),
      async () => {
        expect(await requestWorkerGroupSync(instance.id)).toEqual({
          ok: false,
          failure: { status: 502, code: "group_sync_failed", message: expect.any(String) },
        });
      },
    );
  });

  test("refuses to report a sync the worker did not mark ok", async () => {
    await withWorker(answer(200, { ...summary, ok: false }), async () => {
      expect(await requestWorkerGroupSync(instance.id)).toEqual({
        ok: false,
        failure: { status: 502, code: "group_sync_failed", message: expect.any(String) },
      });
    });
  });
});
