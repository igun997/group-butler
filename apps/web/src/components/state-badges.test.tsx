import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { GroupStateBadge, InstanceStateBadge } from "./state-badges";

/**
 * R-A3: state is never colour alone. Every badge carries its own text and its own
 * glyph, and the glyph is a decoration a screen reader must not read twice, so the
 * label is text a test can find and the icon is hidden from the accessibility tree.
 */
describe("state badges (R-A3)", () => {
  test("every instance state has a text label beside its glyph", () => {
    const labels: Record<string, string> = {
      disconnected: "Disconnected",
      pairing: "Pairing",
      connected: "Connected",
      logged_out: "Logged out",
      error: "Error",
    };
    for (const [status, label] of Object.entries(labels)) {
      const html = renderToStaticMarkup(<InstanceStateBadge status={status} />);
      expect(html).toContain(label);
      expect(html).toContain('aria-hidden="true"');
    }
  });

  test("every group state has a text label beside its glyph", () => {
    const labels: Record<string, string> = {
      active: "Active",
      left: "Left",
      deleted: "Deleted",
      suspended: "Suspended",
    };
    for (const [state, label] of Object.entries(labels)) {
      const html = renderToStaticMarkup(<GroupStateBadge state={state as never} />);
      expect(html).toContain(label);
      expect(html).toContain('aria-hidden="true"');
    }
  });

  test("an unknown instance status is shown verbatim rather than swallowed", () => {
    const html = renderToStaticMarkup(<InstanceStateBadge status="restarting" />);
    expect(html).toContain("restarting");
  });

  test("a left or deleted group is tonally distinct from an active one", () => {
    const active = renderToStaticMarkup(<GroupStateBadge state="active" />);
    const left = renderToStaticMarkup(<GroupStateBadge state="left" />);
    const deleted = renderToStaticMarkup(<GroupStateBadge state="deleted" />);

    expect(left).not.toBe(active);
    expect(deleted).not.toBe(active);
    expect(deleted).toContain("state-badge--bad");
    expect(active).not.toContain("state-badge--bad");
  });
});
