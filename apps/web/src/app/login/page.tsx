import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentOwner } from "../../server/auth/owner";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in · Group Butler" };

/** The page reads the signed cookie, so it is never prerendered. */
export const dynamic = "force-dynamic";

/**
 * The owner's way in (§11.1). One account configured in the environment, no
 * sign-up, no invitation, no reset — so the page is a form and one generic
 * failure message. `src/middleware.ts` sends every browser without a session
 * here, and an owner who already has one is sent straight on.
 */
export default async function LoginPage() {
  if (await currentOwner()) redirect("/");

  return (
    <main>
      <h1>Sign in</h1>
      <p>
        Group Butler has one owner account, and its credentials live in this deployment&apos;s
        environment (<code>OWNER_EMAIL</code> and the configured password hash). There is no
        sign-up and no password reset.
      </p>
      <LoginForm />
    </main>
  );
}
