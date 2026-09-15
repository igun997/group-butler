/**
 * One line per server-side failure, for the failures a caller only sees as a 5xx.
 *
 * The response is deliberately generic — a driver's words never reach the browser
 * (§11.5) — but the operator has to be able to find out what happened, and a route
 * that answered 502 without writing anything left them with nothing at all. This is
 * where that line goes: the route, the identifiers that say which instance or row it
 * was about, and the error itself.
 *
 * It also names the cause when this deployment has met it before. Two failures
 * account for most of what an operator sees on a fresh install, and both are
 * configuration rather than bugs, so they are worth a sentence rather than a search.
 */
export function logFailure(scope: string, error: unknown, context: Record<string, string> = {}): void {
  console.error(`[api] ${scope} failed`, JSON.stringify(context), error);
  const cause = knownCause(error);
  if (cause !== null) console.error(`[api] ${scope}: ${cause}`);
}

/**
 * What a failure means when it is one this deployment has seen.
 *
 * MongoDB is matched by its code first and its wording second. The code is the
 * stable thing (`IllegalOperation` is 20 in every version), and the wording is what
 * older or proxied drivers sometimes give instead.
 */
function knownCause(error: unknown): string | null {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : null;
  const message = error instanceof Error ? error.message : "";

  // Mongo refuses every transaction on a server that is not a replica set or a
  // mongos. Almost all of this app's writes are transactional, so a standalone
  // MongoDB fails them one by one, each looking like an unrelated 502.
  if (code === 20 || /Transaction numbers are only allowed/iu.test(message)) {
    return "MongoDB refused a transaction because this deployment's database is not a replica set. Run it as one (a single node is enough — infra/dev/docker-compose.yml shows how), or point MONGODB_URI at a replica set. See docs/install.md";
  }

  // The address inside a container is not the address on the host: 127.0.0.1 there
  // is the container itself, which is the usual reason a first deployment cannot
  // reach a database the operator can see from their own shell.
  if (error instanceof Error && /MongoNetworkError|MongoServerSelectionError|ECONNREFUSED|getaddrinfo/iu.test(`${error.name} ${message}`)) {
    return "the database could not be reached from this process — check that MONGODB_URI resolves from inside the container, not just from your machine";
  }

  return null;
}
