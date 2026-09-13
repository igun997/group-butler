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

/**
 * The two static files of the §3.2 bundled fallback face and the OFL licence that
 * ships with it (`apps/web/public/fonts`). The sign-in page — an open path —
 * renders the face before any session exists, so those two exact paths are open
 * as well. Exact paths, never a `fonts/` prefix: every other path under that
 * directory, and every route that merely looks like one, keeps the gate.
 */
const OPEN_STATIC_FILES: Record<string, true> = {
  "/fonts/inter-latin-wght-normal.woff2": true,
  "/fonts/Inter-OFL.txt": true,
};

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  if (OPEN_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))) return NextResponse.next();
  if (OPEN_STATIC_FILES[pathname]) return NextResponse.next();
  if (request.cookies.has(SESSION_COOKIE)) return NextResponse.next();

  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const login = request.nextUrl.clone();
  login.pathname = "/login";
  login.search = "";
  return NextResponse.redirect(login);
}

/**
 * Static namespaces never need the gate; everything the app serves does. A single
 * file inside a namespace cannot be named here without a fragile regex, so the
 * two open static files are listed by exact path in the middleware itself.
 */
export const config = {
  matcher: ["/((?!_next/|favicon.ico).*)"],
};
