import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { Scope } from "../ui/registry";
import { ScopeSpine, type ScopeSpineProps, type SpineGroup, type SpineInstance } from "./scope-spine";

/**
 * R11 and R-M2. The spine is the switcher: every instance with its state, its
 * group counts and its last sync, and under each one its groups with the raw
 * `<id>@g.us` beside the current name — the two facts the operator is here for.
 *
 * Interactions (selection, the sheet's focus return) are exercised against a real
 * browser; what this file pins is the structure a browser and a screen reader
 * receive, which is where R11, R-A3, and R-A6 actually live.
 */
const instances: readonly SpineInstance[] = [
  {
    id: "inst_1",
    label: "Support bot",
    status: "connected",
    groupsObserved: 2,
    groupsLeft: 1,
    lastSyncAt: "2026-09-13T10:00:00Z",
  },
  {
    id: "inst_2",
    label: "Sales bot",
    status: "logged_out",
    groupsObserved: 0,
    groupsLeft: 0,
    lastSyncAt: null,
  },
];

const groups: readonly SpineGroup[] = [
  {
    instanceId: "inst_1",
    groupJid: "120363043123456789@g.us",
    name: "Ops Team",
    nameSource: "event",
    state: "active",
  },
  {
    instanceId: "inst_1",
    groupJid: "120363043999999999@g.us",
    name: "(unnamed group) 120363043999999999",
    nameSource: "fallback",
    state: "left",
  },
];

function render(scope: Scope | null, overrides: Partial<ScopeSpineProps> = {}) {
  return renderToStaticMarkup(
    <ScopeSpine instances={instances} groups={groups} scope={scope} onSelect={vi.fn()} {...overrides} />,
  );
}

describe("ScopeSpine (R11, R-M2)", () => {
  test("shows every instance and, under it, each group ID with its current name", () => {
    const html = render({ kind: "instance", instanceId: "inst_1" });

    expect(html).toContain("Support bot");
    expect(html).toContain("Sales bot");
    expect(html).toContain("2 observed");
    expect(html).toContain("1 left");
    expect(html).toContain("Last sync 2026-09-13 10:00 UTC");
    expect(html).toContain("Never synced");

    expect(html).toContain("120363043123456789@g.us");
    expect(html).toContain("Ops Team");
    expect(html).toContain("120363043999999999@g.us");
    expect(html).toContain("(unnamed group) 120363043999999999");
  });

  test("marks a left group without hiding its retained name", () => {
    const html = render(null);

    expect(html).toContain("Ops Team");
    expect(html).toContain("Left");
    expect(html).toContain("Name not synced yet");
  });

  test("copies a group ID from a control named by the value it copies", () => {
    const html = render(null);

    expect(html).toContain('aria-label="Copy group ID 120363043123456789@g.us"');
  });

  test("re-scopes in place: every interactive row is a control, never a link", () => {
    const html = render(null);

    expect(html).toContain("<button");
    expect(html).not.toContain("href");
  });

  test("marks the scope it is given as the current one", () => {
    const instance = render({ kind: "instance", instanceId: "inst_1" });
    const group = render({
      kind: "group",
      instanceId: "inst_1",
      groupJid: "120363043123456789@g.us",
    });

    expect(instance.match(/aria-current="true"/g)).toHaveLength(1);
    expect(group.match(/aria-current="true"/g)).toHaveLength(1);
    expect(render(null).match(/aria-current="true"/g)).toBeNull();
  });

  test("collapses to a scope chip that opens the switcher in a sheet (R-M2)", () => {
    const html = render({ kind: "group", instanceId: "inst_1", groupJid: "120363043123456789@g.us" });

    const chip = html.match(/<button[^>]*class="scope-spine__chip"[^>]*>([\s\S]*?)<\/button>/)?.[0] ?? "";
    expect(chip).toContain('aria-haspopup="dialog"');
    expect(chip).toContain('aria-expanded="false"');

    // The chip names the scope it is on, so the header can show it unopened.
    expect(chip).toContain("Ops Team");

    const sheet = html.match(/<dialog[^>]*class="scope-spine__sheet[^"]*"[^>]*>/)?.[0] ?? "";
    expect(sheet).toContain('aria-label="Scope"');
    expect(sheet).not.toContain(" open");

    const controls = chip.match(/aria-controls="([^"]+)"/)?.[1];
    expect(controls).toBeDefined();
    expect(html).toContain(`id="${controls}"`);
  });

  test("exposes exactly one switcher: the sheet's copy is not in the DOM until it opens (R-M2)", () => {
    const html = render(null);

    // The persistent list is the switcher until the chip opens the sheet, so a
    // screen reader is never handed two trees of the same rows.
    expect(html.match(/class="scope-spine__instances"/g)).toHaveLength(1);
    const sheet = html.slice(html.indexOf("<dialog"));
    expect(sheet).not.toContain("scope-spine__instances");
    expect(sheet).not.toContain("scope-spine__group-row");

    // The sheet names itself and offers a control to leave it other than Escape.
    expect(sheet).toContain(">Scope<");
    expect(sheet).toContain("Close");
  });

  test("marks every group row's copy control by the value it copies (R-A6)", () => {
    const html = render(null);

    for (const group of groups) {
      expect(html).toContain(`aria-label="Copy group ID ${group.groupJid}"`);
    }
  });

  test("names the whole-instance scope when nothing is selected", () => {
    const html = render(null);
    const chip = html.match(/<button[^>]*class="scope-spine__chip"[^>]*>([\s\S]*?)<\/button>/)?.[1] ?? "";
    expect(chip).toContain("All instances");
  });

  test("says so when there is nothing to switch between", () => {
    const html = renderToStaticMarkup(
      <ScopeSpine instances={[]} groups={[]} scope={null} onSelect={vi.fn()} />,
    );

    expect(html).toContain("No instances yet.");
  });
});
