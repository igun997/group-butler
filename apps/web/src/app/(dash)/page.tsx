import type { Metadata } from "next";

export const metadata: Metadata = { title: "Overview · Group Butler" };

/**
 * The `overview` address (`/`, docs/ui-decision.md §2.3) until P10 builds it.
 * It is honest content, not a fake workspace: it states what the container
 * serves, which is what the operator who lands here actually needs. It adds no
 * `h1` and no `main` of its own — `(dash)/layout.tsx` and `AppShell` own both
 * landmarks, and the one `h1` is the shell's workspace heading (R-A5).
 */
export default function OverviewPage() {
  return (
    <>
      <p>
        Group Butler keeps one organization&apos;s WhatsApp groups in order: which groups are
        assigned, what they are called now, and what was said in them. The worker that talks
        to WhatsApp runs as its own container; this one serves the dashboard and its API.
      </p>
      <p>
        The workspace views are not built yet, so this address and the auth routes are the whole
        surface. All but the health report need the owner&apos;s session cookie: middleware sends a
        browser without one to <code>/login</code>, the sign-in form, and{" "}
        <code>/api/auth/login</code> is the only thing that issues one.
      </p>

      <h2>What this container answers</h2>
      <dl>
        <dt>
          <code>/</code>
        </dt>
        <dd>This workspace, inside the one shell, with an owner session.</dd>
        <dt>
          <code>/api/auth/login</code>
        </dt>
        <dd>
          The owner&apos;s email and password (env-configured, no signup) for a signed session
          cookie. It is the only way in.
        </dd>
        <dt>
          <code>/api/auth/session</code>
        </dt>
        <dd>The identity the cookie carries, or 401.</dd>
        <dt>
          <code>/api/auth/logout</code>
        </dt>
        <dd>Clears the cookie, and is what the shell&apos;s sign-out control calls.</dd>
        <dt>
          <code>/api/health</code>
        </dt>
        <dd>
          The database and the worker control plane, reported separately. It answers 200 only
          while both respond, and 503 naming the dependency that did not.
        </dd>
      </dl>
    </>
  );
}
