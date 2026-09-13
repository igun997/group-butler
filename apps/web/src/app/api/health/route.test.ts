import { createServer, type Server, type ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { closeHealthClient } from "../../../server/health";
import { GET } from "./route";

/** The worker's §6.5 payload, served for real: the route fetches it over HTTP. */
function healthyWorker() {
  const server: Server = createServer((_req, res: ServerResponse) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, mongo: "ok" }));
  });
  return server;
}

let mongo: MongoMemoryServer;
let worker: Server;
let workerUrl: string;

const configured = {
  MONGODB_URI: process.env.MONGODB_URI,
  WORKER_URL: process.env.WORKER_URL,
};

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  worker = healthyWorker();
  await new Promise<void>((resolve) => worker.listen(0, "127.0.0.1", resolve));
  const address = worker.address();
  if (address === null || typeof address === "string") throw new Error("worker stub has no port");
  workerUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => worker.close(() => resolve()));
  await mongo.stop();
});

// The probe connection is per process, so each case drops it before repointing
// MONGODB_URI, and the environment is restored for the next case.
afterEach(async () => {
  await closeHealthClient();
  for (const [name, value] of Object.entries(configured)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("GET /api/health", () => {
  test("answers 200 for a reachable database and a healthy worker", async () => {
    process.env.MONGODB_URI = mongo.getUri();
    process.env.WORKER_URL = workerUrl;

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ok: true,
      mongo: "ok",
      worker: { reachable: true, ok: true },
    });
  });

  test("answers 503 naming the database while the worker stays reachable", async () => {
    process.env.MONGODB_URI = "mongodb://127.0.0.1:1";
    process.env.WORKER_URL = workerUrl;

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      mongo: "error",
      worker: { reachable: true, ok: true },
    });
  });

  test("answers 503 naming the worker while the database stays reachable", async () => {
    process.env.MONGODB_URI = mongo.getUri();
    process.env.WORKER_URL = "http://127.0.0.1:1";

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      mongo: "ok",
      worker: { reachable: false, ok: false, error: "worker did not answer" },
    });
  });
});
