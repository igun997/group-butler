/**
 * The app root, and deliberately all of it. This image ships the BFF, its
 * production runtime, and the health contract; the dashboard of
 * docs/ui-decision.md is a plan, not a build. A page that states what the
 * container serves is worth more to the operator who lands here than a 404, and
 * inventing a workspace would put fake panels in front of the real ones later.
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
        The dashboard is not built yet, so this page is the whole surface: one route in
        addition to a health report.
      </p>

      <h2>What this container answers</h2>
      <dl>
        <dt>
          <code>/</code>
        </dt>
        <dd>This page.</dd>
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
