"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

/**
 * Every failure the login route documents, in the operator's words. Branching is
 * on the status the route actually returns (see docs/api-contract.md), and an
 * unknown status gets a message that does not invent a cause.
 */
async function failureMessage(response: Response): Promise<string> {
  if (response.status === 401) return "That email and password do not match the owner account.";
  if (response.status === 400) return "Enter both an email address and a password.";
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after"));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? ` Try again in ${retryAfter} seconds.` : "";
    return `Too many sign-in attempts.${wait}`;
  }
  if (response.status === 503) return "The attempt could not be recorded, so it was refused. Try again.";
  return `Sign-in failed (${response.status}). Try again.`;
}

export function LoginForm({ next }: { next: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);

    let response: Response;
    try {
      response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: String(form.get("email") ?? ""),
          password: String(form.get("password") ?? ""),
        }),
      });
    } catch {
      setError("The server did not answer. Check your connection and try again.");
      setPending(false);
      return;
    }

    if (response.ok) {
      // A document navigation rather than `router.replace` + `router.refresh`:
      // the session cookie was just issued, and a client transition can be
      // superseded by the refresh that follows it, leaving the form on screen.
      // The button stays pending while the browser loads the console.
      window.location.assign(next);
      return;
    }

    setError(await failureMessage(response));
    setPending(false);
  }

  return (
    <form onSubmit={onSubmit} noValidate={false}>
      <FieldGroup className="gap-5">
        <Field>
          <FieldLabel htmlFor="email">Email</FieldLabel>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            autoFocus
            required
            disabled={pending}
            placeholder="owner@example.com"
            className="max-md:h-11"
            aria-invalid={error ? true : undefined}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            disabled={pending}
            className="max-md:h-11"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "sign-in-error" : undefined}
          />
          {/* The failure sits with the credentials it is about, so the form keeps
              one rhythm instead of reserving an empty line above the button. */}
          {error ? <FieldError id="sign-in-error">{error}</FieldError> : null}
        </Field>
        <Field>
          <Button type="submit" disabled={pending} className="h-10 w-full max-md:h-12">
            {pending ? <Spinner /> : null}
            {pending ? "Signing in" : "Sign in"}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  );
}
