import { NextRequest } from "next/server";
import { describe, expect, test } from "vitest";
import { middleware, config } from "./middleware";
import { SESSION_COOKIE } from "./server/auth/cookie";

const answer = (pathname: string, authenticated = false) => {
  const request = new NextRequest(new URL(`http://web.test${pathname}`));
  if (authenticated) request.cookies.set(SESSION_COOKIE, "issued-for-this-test");
  const response = middleware(request);
  return { status: response.status, redirect: response.headers.get("location") };
};

describe("middleware", () => {
  test("rejects every protected API route before it reaches a handler", () => {
    for (const pathname of ["/api/groups", "/api/auth/session", "/api/media/abc/url", "/api/stream"]) {
      expect([pathname, answer(pathname)]).toEqual([pathname, { status: 401, redirect: null }]);
    }
  });

  test("keeps the open API routes reachable without a session", () => {
    for (const pathname of ["/api/auth/login", "/api/health", "/api/internal/reply-jobs"]) {
      expect([pathname, answer(pathname)]).toEqual([pathname, { status: 200, redirect: null }]);
    }
  });

  test("lets a session through to both the API and the console pages", () => {
    for (const pathname of ["/api/groups", "/", "/instances"]) {
      expect([pathname, answer(pathname, true)]).toEqual([pathname, { status: 200, redirect: null }]);
    }
  });

  test("serves the public shell without a session", () => {
    expect(answer("/login")).toEqual({ status: 200, redirect: null });
  });

  test("sends an unauthenticated page request to the public shell", () => {
    expect(answer("/instances")).toEqual({ status: 307, redirect: "http://web.test/login?next=%2Finstances" });
  });

  test("keeps the query string it was asked for", () => {
    expect(answer("/instances/abc/groups?tab=members")).toEqual({
      status: 307,
      redirect: "http://web.test/login?next=%2Finstances%2Fabc%2Fgroups%3Ftab%3Dmembers",
    });
  });

  test("does not bother remembering the console root", () => {
    expect(answer("/")).toEqual({ status: 307, redirect: "http://web.test/login" });
  });

  test("matches page requests and skips Next's own assets", () => {
    const pattern = new RegExp(`^${config.matcher[0]}$`);
    for (const pathname of ["/", "/login", "/instances", "/api/groups"]) {
      expect([pathname, pattern.test(pathname)]).toEqual([pathname, true]);
    }
    for (const pathname of ["/_next/static/chunk.js", "/_next/image", "/favicon.ico"]) {
      expect([pathname, pattern.test(pathname)]).toEqual([pathname, false]);
    }
  });
});
