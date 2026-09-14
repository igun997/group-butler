import { NextRequest } from "next/server";
import { describe, expect, test } from "vitest";
import { middleware, config } from "./middleware";

/**
 * The BFF serves JSON only. Middleware pre-gates API calls with no owner cookie;
 * non-API paths are left to the App Router, which returns its normal 404 because
 * the backend intentionally ships no pages or static UI assets.
 */
const answer = (pathname: string) => {
  const response = middleware(new NextRequest(new URL(`http://web.test${pathname}`)));
  return { status: response.status, redirect: response.headers.get("location") };
};

describe("middleware (API-only auth gate)", () => {
  test("rejects every protected API route before it reaches a handler", () => {
    for (const pathname of ["/api/groups", "/api/auth/session", "/api/media/abc/url", "/api/stream"]) {
      expect([pathname, answer(pathname)]).toEqual([pathname, { status: 401, redirect: null }]);
    }
  });

  test("leaves absent dashboard paths for the App Router instead of redirecting to a deleted login page", () => {
    for (const pathname of ["/", "/instances", "/instances/abc/groups", "/messages", "/sends", "/settings", "/fonts/notes.txt"]) {
      expect([pathname, answer(pathname)]).toEqual([pathname, { status: 200, redirect: null }]);
    }
  });

  test("keeps the login and health API routes reachable without a session", () => {
    for (const pathname of ["/api/auth/login", "/api/health"]) {
      expect([pathname, answer(pathname)]).toEqual([pathname, { status: 200, redirect: null }]);
    }
  });

  test("runs only for API routes", () => {
    expect(config.matcher).toEqual(["/api/:path*"]);
  });
});
