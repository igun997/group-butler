/**
 * The app root, and deliberately all of it. This image ships the BFF, its
 * production runtime, the owner's session contract, and the health contract; the
 * dashboard of docs/ui-decision.md is a plan, not a build. A page that states
 * what the container serves is worth more to the operator who lands here than a
 * 404, and inventing a workspace would put fake panels in front of the real ones
 * later.
 */
export default function HomePage() {
  return (
    <main>
      <h1>Group Butler</h1>
      <p>
        Group Butler keeps one organization&apos;s WhatsApp groups in order: which groups are
        assigned, what they are called now, and what was said in them. The worker that talks
        to WhatsApp runs as its own container; this one serves the dashboard and its API.
      </p>
      <p>
        The dashboard is not built yet, so this page and the auth routes are the whole surface.
        All but the health report need the owner&apos;s session cookie: middleware sends a browser
        without one to <code>/login</code>, and <code>/api/auth/login</code> is the only thing that
        issues one.
      </p>

      <h2>What this container answers</h2>
      <dl>
        <dt>
          <code>/</code>
        </dt>
        <dd>This page, with an owner session.</dd>
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
        <dd>Clears the cookie.</dd>
        <dt>
          <code>/api/health</code>
        </dt>
        <dd>
          The database and the worker control plane, reported separately. It answers 200 only
          while both respond, and 503 naming the dependency that did not.
        </dd>
      </dl>

      <footer>
        <p>
          Health stays open on purpose: the container healthcheck calls it without a session.{" "}
          <a href="/api/health">Read the current report</a>
        </p>
      </footer>
    </main>
  );
}
