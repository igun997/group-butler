import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { AppShell, type AppShellProps } from "./app-shell";

/**
 * The shell is rendered to static markup, the way the repo's page tests render
 * server components: what matters here is the structure a browser and a screen
 * reader receive — the landmarks, the single `h1`, the eager live regions, and
 * the controls — not a client interaction the node environment cannot run.
 */
function shell(overrides: Partial<AppShellProps> = {}): string {
  return renderToStaticMarkup(
    <AppShell title="Overview" scopeLabel="All instances" {...overrides}>
      <p>panel</p>
    </AppShell>,
  );
}

/** The opening tag of the element carrying `data-testid="<testId>"`. */
function element(html: string, testId: string): string {
  return html.match(new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? "";
}

describe("AppShell (spec §2.2 invariant 1, R-A5, R-A7)", () => {
  test("renders the four landmarks around exactly one h1", () => {
    const html = shell();

    expect(html).toContain('aria-label="Workspaces"');
    expect(html).toContain("<nav");
    expect(html).toContain("<header");
    expect(html).toContain("<main");
    expect(html).toContain("<footer");
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(html).toContain("All instances");
  });

  test("mounts exactly one polite and one assertive live region, eagerly", () => {
    const html = shell();

    expect(element(html, "live-polite")).toContain('aria-live="polite"');
    expect(element(html, "live-assertive")).toContain('aria-live="assertive"');
    expect(html.match(/data-testid="live-/g)).toHaveLength(2);
  });

  test("exposes the palette trigger with its keyboard shortcut hint", () => {
    const html = shell();

    expect(html).toContain('aria-label="Command palette"');
    expect(html).toContain('aria-keyshortcuts="Control+K Meta+K"');
    expect(html).toContain("Ctrl+K");
  });

  test("marks the current destination and links nowhere the build does not serve", () => {
    const html = shell({ currentId: "overview" });

    expect(html).toContain('aria-current="page"');

    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(hrefs)).toEqual(new Set(["/", "/api/health"]));
  });

  test("offers the owner's identity and a sign-out control", () => {
    const html = shell({ ownerEmail: "owner@example.test" });

    expect(html).toContain("owner@example.test");
    expect(html).toMatch(/sign out/i);
  });
});
