import type { ReactNode } from "react";

/**
 * The workspace header: scope, then state, then action (docs/ui-decision.md §1
 * reading order, §4.6 R-A5).
 *
 * Every workspace states what it is looking at and what condition that is in
 * before offering the controls that change it, and it does so once, in one
 * place, so no view invents its own composition for it. The shell owns the `h1`
 * and the page's landmarks; this is the region's own `h2` and its state line,
 * which is why the heading is required and the rest is optional: a workspace
 * with nothing to say says nothing rather than rendering an empty band.
 *
 * Document order is the reading order — identity, state, then the controls that
 * act on it — and the tools are placed at the end of the line by layout, not by
 * being written first (WCAG 1.3.2: the sequence has to mean something).
 *
 * It is not a `<header>` element: the shell already holds the page's `header`,
 * and a second one inside `main` would add a landmark that means nothing.
 */
export interface WorkspaceHeaderProps {
  /**
   * The id the region's `aria-labelledby` points at, so the workspace is a named
   * region rather than an anonymous one. Supplied by the caller, because only it
   * can generate one.
   */
  headingId?: string;
  /** The region's heading, an `h2` under the shell's `h1` (R-A5). */
  heading: string;
  /** What is in scope, said in words — the operator never opens anything to learn it (R-M2). */
  scope: string;
  /** The scope's condition: how fresh the read is, what just changed. */
  summary?: ReactNode;
  /** The stream's state (R-L1). */
  live?: ReactNode;
  /** What the workspace can do, sitting with the data it acts on. */
  actions?: ReactNode;
}

export function WorkspaceHeader({ headingId, heading, scope, summary, live, actions }: WorkspaceHeaderProps) {
  return (
    <div className="workspace-header">
      <div className="workspace-header__identity">
        <h2 id={headingId} className="workspace-header__heading">
          {heading}
        </h2>
        <p className="workspace-header__scope">{scope}</p>
      </div>
      {summary === undefined ? null : <div className="workspace-header__summary">{summary}</div>}
      {live === undefined && actions === undefined ? null : (
        <div className="workspace-header__tools">
          {live}
          {actions}
        </div>
      )}
    </div>
  );
}
