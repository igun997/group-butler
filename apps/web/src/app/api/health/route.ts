import { checkHealth } from "../../../server/health";

/**
 * §7.3: the probe reports the database and the worker control plane, named
 * separately. It stays open on purpose, exactly like the worker's `/health`:
 * the container healthcheck (apps/web/Dockerfile) and any load balancer in
 * front of it call this route without a session, and an owner session would
 * only make the container unhealthable.
 *
 * `no-store`: a probe answer is about this second and must not be replayed from
 * a cache between here and the caller.
 */
export async function GET(): Promise<Response> {
  const { status, body } = await checkHealth();
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}
