import { describe, expect, test } from "vitest";
import { config } from "./middleware";

/**
 * The matcher is the gate's surface: what it does not match, `middleware` never
 * sees. The §3.2 bundled fallback face and its OFL licence live under
 * `apps/web/public/fonts` and must load on the open sign-in page, so they join
 * `_next/` and `favicon.ico` in the static-asset exclusion list — and nothing
 * else may. A page or an API added here would be an unauthenticated hole, which
 * is what this pins.
 */
const gated = (pathname: string) => config.matcher.some((matcher) => new RegExp(`^${matcher}/?$`).test(pathname));

describe("middleware matcher (the auth gate's surface)", () => {
  test("the bundled font asset and its licence are static files, outside the gate", () => {
    expect(gated("/fonts/inter-latin-wght-normal.woff2")).toBe(false);
    expect(gated("/fonts/Inter-OFL.txt")).toBe(false);
  });

  test("every page and API keeps the gate", () => {
    for (const pathname of [
      "/",
      "/login",
      "/instances",
      "/instances/abc/groups",
      "/messages",
      "/settings",
      "/api/groups",
      "/api/auth/session",
      "/api/health",
      "/api/media/abc/url",
    ]) {
      expect([pathname, gated(pathname)]).toEqual([pathname, true]);
    }
  });
});
