/**
 * Where sign-in sends the owner once it succeeds.
 *
 * `next` is attacker-influenced (anyone can craft `/login?next=...`), so it is
 * only honoured when it is a path on this origin: no scheme, no host, no
 * protocol-relative `//host`, no backslash or control character that a browser
 * might normalise into one. Anything else lands on the console root.
 */
export const DEFAULT_LANDING = "/";

export function safeNextPath(value: string | undefined | null): string {
  if (typeof value !== "string") return DEFAULT_LANDING;
  if (!value.startsWith("/") || value.startsWith("//")) return DEFAULT_LANDING;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return DEFAULT_LANDING;
  return value;
}
