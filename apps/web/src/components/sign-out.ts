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

/** Where the browser is sent once the session has really ended. */
export type Navigate = (href: string) => void;

/** `true` when the server ended the session; `false` when it did not, or was unreachable. */
export async function signOut(fetchImpl: SignOutFetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl("/api/auth/logout", { method: "POST" });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * The whole sign-out outcome: end the session, and navigate to `/login` only
 * when it did. Split from the DOM so the navigation decision — the part a
 * forgotten redirect or a redirect-on-failure would break — is testable.
 */
export async function signOutAndRedirect(
  navigate: Navigate,
  fetchImpl: SignOutFetch = fetch,
): Promise<boolean> {
  const ended = await signOut(fetchImpl);
  if (ended) navigate("/login");
  return ended;
}
