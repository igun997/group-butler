import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "./server/auth/cookie";

/**
 * A UX gate only (docs/architecture-draft.md §11.1): it decides whether the
 * browser sees a page or a login form before anything renders. Every route
 * handler calls `requireOwner()` itself, so this check is deliberately only that
 * the cookie is *present* — verifying the HMAC here would pull `node:crypto`
 * into the edge bundle, and a forged cookie still fails the handler.
 */
const OPEN_PATHS = ["/login", "/api/auth/login", "/api/health"];

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  if (OPEN_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))) return NextResponse.next();
  if (request.cookies.has(SESSION_COOKIE)) return NextResponse.next();

  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const login = request.nextUrl.clone();
  login.pathname = "/login";
  login.search = "";
  return NextResponse.redirect(login);
}

/** Static assets never need the gate; everything the app serves does. */
export const config = {
  matcher: ["/((?!_next/|favicon.ico).*)"],
};
