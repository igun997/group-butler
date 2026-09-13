/**
 * A modal `<dialog>` traps `Tab` in principle, but Chromium still moves focus
 * through the document body for one step when the layer's last control is left —
 * a real leak to the obscured page behind the scrim. This keeps the cycle inside
 * the layer. It is the native behaviour finished, not a dependency: it walks the
 * layer's own focusable elements.
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The part of a keyboard event the cycle needs; a DOM or React event satisfies it. */
export interface TabKeyEvent {
  key: string;
  shiftKey: boolean;
  preventDefault(): void;
}

export function trapTabKey(container: HTMLElement | null, event: TabKeyEvent): void {
  if (!container || event.key !== "Tab") return;

  const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!first || !last) return;

  const active = container.ownerDocument.activeElement;
  if (!container.contains(active)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
    return;
  }

  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}
