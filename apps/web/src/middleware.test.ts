import { NextRequest } from "next/server";
import { describe, expect, test } from "vitest";
import { middleware, config } from "./middleware";

/**
 * The gate's surface, exercised through the middleware itself: a `NextResponse`
 * with a `location` is a redirect to the sign-in page, `401` is the API answer,
 * and anything else means the request passed through. Nothing is asserted about
 * the compiled matcher — what matters is what a request gets.
 */
const answer = (pathname: string) => {
  const response = middleware(new NextRequest(new URL(`http://web.test${pathname}`)));
  return { status: response.status, redirect: response.headers.get("location") };
};

describe("middleware (the auth gate's surface)", () => {
  test("only the two vendored static files are open", () => {
    for (const pathname of ["/fonts/inter-latin-wght-normal.woff2", "/fonts/Inter-OFL.txt"]) {
      expect([pathname, answer(pathname)]).toEqual([pathname, { status: 200, redirect: null }]);
    }
  });

  test("every other path under the font directory, and every route-looking one, keeps the gate", () => {
    for (const pathname of [
      "/fonts/notes.txt",
      "/fonts/README.md",
      "/fonts/groups",
      "/fonts/api/groups",
      "/fonts/instances/abc/groups",
      "/fonts/inter-latin-wght-normal.woff2.bak",
      "/fonts/Inter-OFL.txt/html",
    ]) {
      expect([pathname, answer(pathname).redirect]).toEqual([pathname, "http://web.test/login"]);
    }
  });

  test("pages redirect to the sign-in page and APIs answer 401", () => {
    for (const pathname of ["/", "/instances", "/instances/abc/groups", "/messages", "/sends", "/settings"]) {
      expect([pathname, answer(pathname).redirect]).toEqual([pathname, "http://web.test/login"]);
    }
    for (const pathname of ["/api/groups", "/api/auth/session", "/api/media/abc/url", "/api/stream"]) {
      expect([pathname, answer(pathname)]).toEqual([pathname, { status: 401, redirect: null }]);
    }
  });

  test("the open paths stay open", () => {
    for (const pathname of ["/login", "/api/auth/login", "/api/health"]) {
      expect([pathname, answer(pathname)]).toEqual([pathname, { status: 200, redirect: null }]);
    }
  });

  test("the matcher excludes no part of the font directory, so only the two exact files are open", () => {
    // Next compiles these path patterns itself; this mirrors their shape. The
    // approximation can only over-match, which is the safe direction: if a
    // future change added `fonts/` to the exclusions, the middleware would never
    // run for these paths and this fails.
    const reachesMiddleware = (pathname: string) =>
      config.matcher.some((matcher) => new RegExp(`^${matcher}/?$`).test(pathname));

    for (const pathname of [
      "/fonts/inter-latin-wght-normal.woff2",
      "/fonts/Inter-OFL.txt",
      "/fonts/notes.txt",
      "/fonts/groups",
      "/instances",
    ]) {
      expect([pathname, reachesMiddleware(pathname)]).toEqual([pathname, true]);
    }
  });
});
