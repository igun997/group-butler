import { useId } from "react";
import type { MappedError } from "../ui/feedback";

/**
 * The banner surface (docs/ui-decision.md §4.5 R-X2/R-X3, §4.6 R-A3/R-A7).
 *
 * `ErrorState` is the panel surface: a failure of the read that panel made. A
 * banner is the other surface the error map declares — a durable operational
 * failure that is true of the whole scope rather than of one read, and that the
 * operator must keep in front of them for as long as it is true: an instance
 * logged out of WhatsApp, a pairing that stopped, a connection this deployment
 * cannot make. It therefore sits above the workspace's own content, states the
 * condition and what still works, and is never a toast (R-T5: something durable
 * is not carried by something that disappears).
 *
 * It is a named region rather than a second live region. R-A7 fixes the shell at
 * exactly one polite and one assertive region, and a durable failure is content
 * the operator reads rather than an announcement: a status that arrives on the
 * stream is a background patch, which R-A7 says is not announced. The heading
 * sits a level under the panel's own, so the region is navigable and named
 * without skipping a level (§4.6 R-A5).
 *
 * It renders the mapped copy and the recovery the map declares, and nothing
 * else: what it is and which surface it is are on the element for a test to
 * assert, and there is no free-form field for a driver message or a stack to
 * reach (R-X1).
 */
export interface ErrorBannerProps {
  /** A failure whose mapped surface is the banner (R-X2). */
  error: MappedError;
  /**
   * Re-runs exactly the call that failed (R-X4). Omit where the operation is not
   * idempotent: then only a declared recovery, if any, is rendered.
   */
  onRetry?: () => void;
}

export function ErrorBanner({ error, onRetry }: ErrorBannerProps) {
  const titleId = useId();
  const recovery = error.action;
  const retries = (recovery?.kind === "retry" || error.retryable === true) && onRetry !== undefined;

  return (
    <section
      className="error-banner"
      aria-labelledby={titleId}
      data-code={error.code}
      data-surface={error.surface}
    >
      <h3 id={titleId} className="error-banner__title">
        {error.title}
      </h3>
      {error.body === undefined ? null : <p className="error-banner__body">{error.body}</p>}
      {error.copyableCode === undefined ? null : (
        <p className="code-chip-row">
          <span className="code-chip-label">Error code</span>
          <code className="code-chip">{error.copyableCode}</code>
        </p>
      )}
      {recovery?.kind === "navigate" && recovery.href !== undefined ? (
        <a className="error-banner__action" href={recovery.href}>
          {recovery.label}
        </a>
      ) : retries ? (
        <button type="button" className="error-banner__action" onClick={onRetry}>
          {recovery?.label ?? "Try again"}
        </button>
      ) : null}
    </section>
  );
}
