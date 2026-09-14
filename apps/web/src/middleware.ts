import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "./server/auth/cookie";

const OPEN_API_PATHS = ["/api/auth/login", "/api/health"];

/**
 * Route handlers verify the signed owner session. This edge gate cheaply rejects
 * unauthenticated API traffic before a handler is invoked; all other paths are
 * intentionally left to the API-only App Router, which has no pages to render.
 */
export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  if (!pathname.startsWith("/api/") || OPEN_API_PATHS.includes(pathname) || request.cookies.has(SESSION_COOKIE)) {
    return NextResponse.next();
  }
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

export const config = {
  matcher: ["/api/:path*"],
};
