/**
 * The key a request is rate limited and audited by.
 *
 * `X-Forwarded-For` is attacker-controlled, so it is only read when a deployment
 * declares how many of its own proxies sit in front of this process:
 * `TRUSTED_PROXY_HOPS`. At the default 0 no forwarded header is consulted at
 * all and every client shares one bucket — a forged chain cannot buy a fresh
 * attempt budget, at the cost of the shared window. At N ≥ 1 the key is the N-th
 * address from the right, the peer the outermost trusted proxy appended;
 * anything a client prepends sits to its left and is never used. N ≥ 1 is only
 * trustworthy while this process's own port is reachable *only* through those
 * proxies (§11.7), the same condition under which the header means anything.
 */
export const DIRECT_CLIENT = "direct";

export function clientKey(request: Request): string {
  const hops = Number(process.env.TRUSTED_PROXY_HOPS);
  if (!Number.isInteger(hops) || hops < 1) return DIRECT_CLIENT;

  const chain = request.headers.get("x-forwarded-for")?.split(",") ?? [];
  const forwarded = chain[chain.length - hops]?.trim() ?? "";
  const usable = forwarded.length > 0 && forwarded.length <= 45 && /^[0-9a-fA-F.:]+$/.test(forwarded);
  return usable ? forwarded : DIRECT_CLIENT;
}
