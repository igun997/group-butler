export type LoginOutcome = { ok: true } | { ok: false; message: string };

/**
 * The fetch seam: the browser's `fetch` in the page, the real route handler in
 * tests. It is narrower than `typeof fetch` so a test double cannot be forced to
 * carry undici's extra surface.
 */
export type LoginFetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * The one call the sign-in form makes, as a plain function over `fetch` so its
 * whole outcome contract is testable against the real route handler — including
 * the two failures a handler cannot produce for us: an unreachable server, and a
 * server that refused because it could not record the attempt.
 */
export async function submitLogin(
  email: string,
  password: string,
  fetchImpl: LoginFetch = fetch,
): Promise<LoginOutcome> {
  let response: Response;
  try {
    response = await fetchImpl("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    return { ok: false, message: "Could not reach the server. Try again." };
  }

  if (response.ok) return { ok: true };
  if (response.status === 401) {
    return { ok: false, message: "That email and password do not match the owner account." };
  }
  if (response.status === 429) {
    return { ok: false, message: "Too many attempts. Wait a few minutes, then try again." };
  }
  if (response.status === 503) {
    return { ok: false, message: "The server is not ready to sign you in. Try again." };
  }
  return { ok: false, message: "Sign-in failed. Try again." };
}
