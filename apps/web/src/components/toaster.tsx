/**
 * The two shell live regions of docs/ui-decision.md §4.6 R-A7: exactly one
 * polite and one assertive, and both mounted with the shell rather than created
 * when a message arrives — a region that appears with its first message is not
 * announced. They are empty and visually hidden, so they occupy no space and
 * change no layout, but they are in the accessibility tree from the first paint.
 *
 * This is the whole of `Toaster` in P1. P4 adds the toast queue and the policy
 * that decides what may enter these regions; the regions themselves are already
 * here so a message emitted before the first view renders is still spoken.
 */
export function Toaster() {
  return (
    <>
      <div
        className="visually-hidden"
        data-testid="live-polite"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      />
      <div
        className="visually-hidden"
        data-testid="live-assertive"
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
      />
    </>
  );
}
