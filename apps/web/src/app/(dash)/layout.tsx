import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { WorkspaceShell } from "../../components/workspace-shell";
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
 * What the shell renders — the workspace title, the scope's label, the
 * navigation — is resolved from the address by `WorkspaceShell`, which is the
 * registry's one wiring point (§2.3, §2.5). This layout's own job is the session
 * and nothing else, so it cannot grow an opinion about a workspace.
 */
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const owner = await currentOwner();
  if (!owner) redirect("/login");

  return <WorkspaceShell ownerEmail={owner.email}>{children}</WorkspaceShell>;
}
