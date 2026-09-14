import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { vi } from "vitest";

/**
 * A stubbed worker control plane (§6.5) for the BFF tests. It is a real HTTP
 * server on loopback rather than a mocked `fetch`, so what a route sends — the
 * bearer header, the built URL, the JSON body — and what it does with a real
 * answer are both observed through the transport the deployment uses.
 */

/** One request the stub received, in the terms a test asserts on. */
export interface WorkerRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: string;
}

export interface StubWorker {
  base: string;
  requests: WorkerRequest[];
  close: () => Promise<void>;
}

export type WorkerResponder = (req: IncomingMessage, res: ServerResponse, body: string) => void;

export async function stubWorker(respond: WorkerResponder): Promise<StubWorker> {
  const requests: WorkerRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        authorization: req.headers.authorization,
        contentType: req.headers["content-type"],
        body,
      });
      respond(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** `delayMs` is for the one deadline test, where the wait *is* the subject. */
export function jsonAnswer(status: number, payload: unknown, delayMs = 0): WorkerResponder {
  return (_req, res) => {
    const send = () => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (delayMs > 0) setTimeout(send, delayMs);
    else send();
  };
}

/**
 * Points `WORKER_URL`/`WORKER_SECRET` at a stubbed worker for the duration of
 * `run`, then closes it. The stub's address is loopback-only, so a test that
 * forgets to stub the environment fails loudly instead of reaching anything.
 */
export async function withStubWorker(
  respond: WorkerResponder,
  run: (worker: StubWorker) => Promise<void>,
): Promise<void> {
  const worker = await stubWorker(respond);
  vi.stubEnv("WORKER_URL", worker.base);
  vi.stubEnv("WORKER_SECRET", "worker-secret");
  try {
    await run(worker);
  } finally {
    await worker.close();
  }
}
