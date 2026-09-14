import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, readSession, type OwnerSession } from "./session";

/**
 * The console's own gate: the layout calls this before it renders a shell, so a
 * cookie that is present but expired, tampered with, or signed with a rotated
 * `AUTH_SECRET` cannot reach a page even though the edge middleware let it past.
 */
export async function requireOwner(): Promise<OwnerSession> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = readSession(token);
  if (!session) redirect("/login");
  return session;
}
