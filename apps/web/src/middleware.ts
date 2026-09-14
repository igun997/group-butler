import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "./server/auth/cookie";

const OPEN_API_PATHS = ["/api/auth/login", "/api/health", "/api/internal/reply-jobs"];

/** The one page the public shell serves. Everything else needs a session. */
const PUBLIC_PAGES = new Set(["/login"]);

const LOGIN_PATH = "/login";

/**
 * Two gates, one pass:
 *
 * - `/api/*` — the route handlers verify the signed session themselves; this
 *   edge check rejects unauthenticated API traffic before a handler runs, and
 *   answers JSON rather than a redirect so a fetch never follows HTML.
 * - every other path — the console's pages. No session means a redirect to the
 *   public shell, carrying the intended path so sign-in lands where the operator
 *   was going. The layout behind this gate re-checks the signature, because a
 *   cookie can be present and still be forged or expired.
 */
export function middleware(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  const authenticated = request.cookies.has(SESSION_COOKIE);

  if (pathname.startsWith("/api/")) {
    if (OPEN_API_PATHS.includes(pathname) || authenticated) return NextResponse.next();
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (authenticated || PUBLIC_PAGES.has(pathname)) return NextResponse.next();

  const login = request.nextUrl.clone();
  login.pathname = LOGIN_PATH;
  login.search = "";
  // `/` is the console's default landing, so remembering it adds nothing.
  if (pathname !== "/") login.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(login);
}

export const config = {
  // Everything except Next's own build output and the icon, so page requests
  // reach the redirect above instead of the App Router's 404 handling.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
