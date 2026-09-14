"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { Moon02Icon, Sun03Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { useTheme } from "./theme-provider";

/**
 * One icon button that flips light and dark. Both glyphs are always rendered and
 * swapped by CSS off the `dark` class, so the button needs no mounted flag and
 * its markup is identical on the server and on the client.
 *
 * `aria-label` is deliberately static: it names the control rather than the next
 * state, so the accessible name does not change under a screen reader. The
 * theme swap itself is animated from the point the owner pressed.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { toggle, theme } = useTheme();

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={className}
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        toggle({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      }}
      aria-label="Colour theme"
      title={theme === "system" ? "Colour theme: follows your system" : `Colour theme: ${theme}`}
    >
      <HugeiconsIcon icon={Sun03Icon} strokeWidth={2} className="hidden dark:block" />
      <HugeiconsIcon icon={Moon02Icon} strokeWidth={2} className="dark:hidden" />
    </Button>
  );
}
