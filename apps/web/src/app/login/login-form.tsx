"use client";

import { useId, useState, type FormEvent } from "react";
import { submitLogin } from "./submit-login";

/**
 * The owner's sign-in form: plain labelled controls styled by the app's own
 * baseline (globals.css), because the project has no other UI layer yet and one
 * page is not a reason to add one. The failure is announced through a live
 * region mounted from the first render, so the message is spoken when it
 * appears, and it is text — never colour alone.
 */
export function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [failure, setFailure] = useState("");
  const [pending, setPending] = useState(false);
  const failureId = useId();

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setFailure("");

    const outcome = await submitLogin(email, password);
    if (outcome.ok) {
      // A full navigation rather than a client route: the next render has to be
      // the server's, evaluated with the cookie this response just set.
      window.location.assign("/");
      return;
    }

    setFailure(outcome.message);
    setPending(false);
  }

  return (
    <form onSubmit={signIn}>
      <p id={failureId} role="alert">
        {failure}
      </p>

      <label htmlFor="email">Email</label>
      <input
        id="email"
        name="email"
        type="email"
        autoComplete="username"
        required
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        aria-describedby={failureId}
      />

      <label htmlFor="password">Password</label>
      <input
        id="password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        aria-describedby={failureId}
      />

      <button type="submit" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
