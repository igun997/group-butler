/**
 * The shell's sign-out call, as a plain function over `fetch` so its outcome
 * contract is testable against the real route handler — the same seam pattern as
 * `app/login/submit-login.ts`.
 *
 * `POST /api/auth/logout` ends the session and answers JSON, so a plain
 * `<form action>` would leave the operator looking at that JSON. The shell
 * therefore posts here and navigates only when the session actually ended: the
 * route fails closed (a logout it cannot audit is not ended), and navigating on
 * a failed logout would bounce the still-authenticated browser straight back to
 * the dashboard off the login page.
 */
export type SignOutFetch = (input: string, init: RequestInit) => Promise<Response>;

/** `true` when the server ended the session; `false` when it did not, or was unreachable. */
export async function signOut(fetchImpl: SignOutFetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl("/api/auth/logout", { method: "POST" });
    return response.ok;
  } catch {
    return false;
  }
}
