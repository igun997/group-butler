import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { CommandPalette } from "./command-palette";

describe("CommandPalette (R-A6)", () => {
  test("is a labelled trigger plus a closed dialog holding its commands", () => {
    const html = renderToStaticMarkup(
      <CommandPalette
        shortcutHint="Ctrl+K"
        commands={[
          { id: "overview", title: "Overview", hint: "/", run: () => {} },
          { id: "sign-out", title: "Sign out", run: () => {} },
        ]}
      />,
    );

    expect(html).toContain('aria-label="Command palette"');
    expect(html).toContain('aria-keyshortcuts="Control+K Meta+K"');
    expect(html).toContain("<dialog");
    expect(html).toContain("Search commands");
    expect(html).toContain("Overview");
    expect(html).toContain("Sign out");
  });
});
