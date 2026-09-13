import { MongoClient } from "mongodb";
import { mongoConfig } from "./mongo";

/**
 * The §7.3 health contract, shared by the route handler and its tests: the two
 * dependencies this process cannot serve the dashboard without, named
 * separately so an operator reads *which* one degraded, plus the aggregate the
 * load balancer and the container healthcheck act on.
 */
export interface HealthReport {
  ok: boolean;
  mongo: "ok" | "error";
  worker: {
    reachable: boolean;
    ok: boolean;
    /** Why the probe failed, in fixed phrases: never a raw error or the URL. */
    error?: string;
  };
}

/**
 * The worker's own probe budget (§6.5) applied to both checks here: a hung
 * dependency must fail the check, not hang the load balancer that asked.
 */
export const HEALTH_TIMEOUT_MS = 2_000;

let probeClient: MongoClient | null = null;

/**
 * Releases the probe connection. The app pool (`closeDb`) is a different client
 * and is not touched here.
 */
export async function closeHealthClient(): Promise<void> {
  const client = probeClient;
  probeClient = null;
  await client?.close();
}

/**
 * A ping, not a query: it proves the driver can reach the deployment, which is
 * what every BFF read depends on. A missing `MONGODB_URI` is a misconfiguration
 * and therefore as unhealthy as an unreachable server.
 */
export async function probeMongo(): Promise<HealthReport["mongo"]> {
  let uri: string;
  let dbName: string;
  try {
    ({ uri, dbName } = mongoConfig());
  } catch {
    return "error";
  }

  // `??=` keeps a single probe connection per process, the way `getDb()` keeps
  // a single pool; `closeHealthClient` is the only thing that drops it.
  const client = (probeClient ??= new MongoClient(uri, {
    serverSelectionTimeoutMS: HEALTH_TIMEOUT_MS,
    connectTimeoutMS: HEALTH_TIMEOUT_MS,
  }));

  try {
    await client.db(dbName).command({ ping: 1 }, { timeoutMS: HEALTH_TIMEOUT_MS });
    return "ok";
  } catch {
    return "error";
  }
}

/**
 * The worker control plane answers `/health` openly for container probes
 * (`apps/worker/httpapi.go`), so the BFF reads it the same way: no bearer token
 * on a route that does not want one. `ok` is only true for an HTTP 2xx carrying
 * a health payload that itself says `ok`, so a captive portal or a proxy error
 * page on `WORKER_URL` cannot pass as a healthy worker.
 */
export async function probeWorker(url: string | undefined): Promise<HealthReport["worker"]> {
  if (!url) return { reachable: false, ok: false, error: "WORKER_URL is not set" };

  let endpoint: string;
  try {
    endpoint = new URL("/health", url).toString();
  } catch {
    return { reachable: false, ok: false, error: "WORKER_URL is not a URL" };
  }

  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
  } catch {
    return { reachable: false, ok: false, error: "worker did not answer" };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  const reported = (payload as { ok?: unknown } | null)?.ok;
  if (typeof reported !== "boolean") {
    return { reachable: true, ok: false, error: "worker answer was not a health payload" };
  }
  if (!response.ok || !reported) {
    return { reachable: true, ok: false, error: `worker reported not ok (${response.status})` };
  }
  return { reachable: true, ok: true };
}

/**
 * Both probes run together, each bounded, so the route answers within one
 * timeout even when both dependencies are down.
 */
export async function checkHealth(): Promise<{ status: number; body: HealthReport }> {
  const [mongo, worker] = await Promise.all([probeMongo(), probeWorker(process.env.WORKER_URL)]);
  const ok = mongo === "ok" && worker.ok;
  return { status: ok ? 200 : 503, body: { ok, mongo, worker } };
}
