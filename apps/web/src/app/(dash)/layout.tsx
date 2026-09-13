import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { AppShell } from "../../components/app-shell";
import { currentOwner } from "../../server/auth/owner";

/** The layout reads the signed cookie, so it is never prerendered. */
export const dynamic = "force-dynamic";

/**
 * The one page shell for every authenticated page (docs/ui-decision.md §2.2
 * invariant 1, draft §7.6). It gates on the session before anything renders:
 * `src/middleware.ts` already turns an unauthenticated browser away, and this is
 * the check that stays true if a route is ever reached another way. The session
 * is verified here with the same code the API routes use, so a forged cookie
 * gets no further than the login page.
 *
 * The title and scope label are the shell's `h1` and scope text (R-A5). P2's
 * registry resolves both from the URL; until the routes it resolves exist, this
 * layout serves the one address the build has — the `overview` address at `/`.
 */
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const owner = await currentOwner();
  if (!owner) redirect("/login");

  return (
    <AppShell
      title="Overview"
      scopeLabel="All instances"
      currentId="overview"
      ownerEmail={owner.email}
    >
      {children}
    </AppShell>
  );
}
