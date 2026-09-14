import type { MappedError } from "../ui/feedback";

/**
 * The error state (docs/ui-decision.md §4.5 R-X1–R-X4).
 *
 * It renders one mapped `UIError` and nothing that was not mapped: a title, one
 * sentence of cause or consequence, the recovery the error declares, and — for
 * a failure nobody recognises — the raw code in a monospace chip that is
 * selectable as one unit. A stack, a driver message, or a raw worker payload
 * has nowhere to enter, because the map never reads one (R-X1) and this
 * component renders no free-form field.
 *
 * The recovery is a control only when it can do something: a `retry` needs the
 * caller's `onRetry`, a `navigate` needs its destination, and an error that
 * declares neither renders no control at all — an error with no recovery path
 * has to say what state it left the system in, not offer a button that cannot
 * help (R-X4).
 */
export interface ErrorStateProps {
  error: MappedError;
  /**
   * Re-runs exactly the call that failed (R-X4). Omit where the operation is
   * not idempotent: then only a declared recovery, if any, is rendered.
   */
  onRetry?: () => void;
}

export function ErrorState({ error, onRetry }: ErrorStateProps) {
  const recovery = error.action;
  const retries = (recovery?.kind === "retry" || error.retryable === true) && onRetry !== undefined;

  return (
    <div className="resource-surface error-state" data-code={error.code}>
      <h2 className="resource-surface__title">{error.title}</h2>
      {error.body === undefined ? null : <p className="resource-surface__body">{error.body}</p>}
      {error.copyableCode === undefined ? null : (
        <p className="error-state__code-row">
          <span className="error-state__code-label">Error code</span>
          <code className="error-state__code">{error.copyableCode}</code>
        </p>
      )}
      {recovery?.kind === "navigate" && recovery.href !== undefined ? (
        <a className="resource-surface__action" href={recovery.href}>
          {recovery.label}
        </a>
      ) : retries ? (
        <button type="button" className="resource-surface__action" onClick={onRetry}>
          {recovery?.label ?? "Try again"}
        </button>
      ) : null}
    </div>
  );
}
