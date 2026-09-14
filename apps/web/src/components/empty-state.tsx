import type { EmptyCopy, EmptyReason } from "../ui/registry";

/**
 * The empty state (docs/ui-decision.md §4.4 R-E1–R-E5).
 *
 * It renders the copy the resource declared for this reason and the one way out
 * of it, and nothing else. The heading is the region's own `h2`, so an empty
 * workspace is not a paragraph of prose under the `h1`; the action is the
 * first focusable thing in the region, and it is a real control — a link with a
 * destination or a button with an operation, never a label with nothing behind
 * it.
 *
 * A reason whose way out is not available does not get a disabled control. Its
 * copy carries no action and names the prerequisite in the body instead, which
 * is the only honest way to say "this is blocked" without offering a dead end
 * (R-E5, R-L8).
 */
export interface EmptyStateProps {
  /** Which emptiness this is. It is on the element as `data-reason`, so the shell can assert it. */
  reason: EmptyReason;
  copy: EmptyCopy;
}

export function EmptyState({ reason, copy }: EmptyStateProps) {
  return (
    <div className="resource-surface empty-state" data-reason={reason}>
      <h2 className="resource-surface__title">{copy.title}</h2>
      <p className="resource-surface__body">{copy.body}</p>
      {copy.action === undefined ? null : "href" in copy.action ? (
        <a className="resource-surface__action" href={copy.action.href}>
          {copy.action.label}
        </a>
      ) : (
        <button type="button" className="resource-surface__action" onClick={copy.action.run}>
          {copy.action.label}
        </button>
      )}
    </div>
  );
}
