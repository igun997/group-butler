import { createServer, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import { closeHealthClient, probeMongo, probeWorker } from "./health";

/** A real HTTP endpoint answering one canned response, plus the path asked for. */
async function stub(reply: (res: ServerResponse) => void) {
  const paths: string[] = [];
  const server: Server = createServer((req, res) => {
    paths.push(req.url ?? "");
    reply(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("stub server has no port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    paths,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function json(status: number, body: unknown): (res: ServerResponse) => void {
  return (res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
}

const configuredUri = process.env.MONGODB_URI;

afterEach(async () => {
  await closeHealthClient();
  if (configuredUri === undefined) delete process.env.MONGODB_URI;
  else process.env.MONGODB_URI = configuredUri;
});

describe("worker probe", () => {
  test("accepts the worker's own /health answer as healthy", async () => {
    const worker = await stub(json(200, { ok: true, mongo: "ok" }));
    try {
      expect(await probeWorker(worker.url)).toEqual({ reachable: true, ok: true });
      expect(worker.paths).toEqual(["/health"]);
    } finally {
      await worker.close();
    }
  });

  test("fails when the worker answers that it is not ok", async () => {
    const worker = await stub(json(503, { ok: false, mongo: "error" }));
    try {
      expect(await probeWorker(worker.url)).toEqual({
        reachable: true,
        ok: false,
        error: "worker reported not ok (503)",
      });
    } finally {
      await worker.close();
    }
  });

  test("does not accept an answer that is not a health payload", async () => {
    const worker = await stub((res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>some other service</html>");
    });
    try {
      expect(await probeWorker(worker.url)).toEqual({
        reachable: true,
        ok: false,
        error: "worker answer was not a health payload",
      });
    } finally {
      await worker.close();
    }
  });

  test("reports an unreachable worker instead of throwing", async () => {
    expect(await probeWorker("http://127.0.0.1:1")).toEqual({
      reachable: false,
      ok: false,
      error: "worker did not answer",
    });
  });

  test("reports missing or unusable configuration as unreachable", async () => {
    expect(await probeWorker(undefined)).toEqual({
      reachable: false,
      ok: false,
      error: "WORKER_URL is not set",
    });
    expect(await probeWorker("localhost:4000")).toEqual({
      reachable: false,
      ok: false,
      error: "WORKER_URL is not a URL",
    });
  });
});

describe("mongo probe", () => {
  test("reports an unset or unreachable database as an error, never as ok", async () => {
    delete process.env.MONGODB_URI;
    expect(await probeMongo()).toBe("error");

    process.env.MONGODB_URI = "mongodb://127.0.0.1:1";
    await closeHealthClient();
    expect(await probeMongo()).toBe("error");
  });
});
