import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { GroupNameCell } from "./group-name-cell";

/**
 * R11 and R-V4: the current name is always readable, and how it was learned is
 * stated rather than implied. A fallback name is still a name — it is marked, not
 * hidden — and a rename count is provenance, so it renders even before the sheet
 * that shows the history exists.
 */
describe("GroupNameCell (R11, R-V4)", () => {
  test("renders the current name it was given", () => {
    expect(renderToStaticMarkup(<GroupNameCell name="Ops Team" nameSource="event" />)).toContain(
      "Ops Team",
    );
  });

  test("marks a name that has not been synced yet without hiding it", () => {
    const html = renderToStaticMarkup(
      <GroupNameCell name="(unnamed group) 120363043999999999" nameSource="fallback" />,
    );

    expect(html).toContain("(unnamed group) 120363043999999999");
    expect(html).toContain("Name not synced yet");
  });

  test("a synced name carries no fallback marker", () => {
    expect(
      renderToStaticMarkup(<GroupNameCell name="Ops Team" nameSource="sync" />),
    ).not.toContain("Name not synced yet");
  });

  test("states how many times the group has been renamed", () => {
    expect(
      renderToStaticMarkup(<GroupNameCell name="Ops Team" nameSource="event" renameCount={2} />),
    ).toContain("renamed 2×");
  });

  test("says nothing about renames when there have been none", () => {
    expect(
      renderToStaticMarkup(<GroupNameCell name="Ops Team" nameSource="event" renameCount={0} />),
    ).not.toContain("renamed");
  });

  test("the rename count is a control when the surface can open the history (R-V4)", () => {
    const html = renderToStaticMarkup(
      <GroupNameCell name="Ops Team" nameSource="event" renameCount={2} onShowHistory={() => undefined} />,
    );

    expect(html).toContain("<button");
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain("renamed 2×");
    // The accessible name keeps the visible words and adds what the control does.
    expect(html).toContain("show the earlier names");
  });

  test("with no way to open them it stays a number, not a control that does nothing (R-26)", () => {
    const html = renderToStaticMarkup(<GroupNameCell name="Ops Team" nameSource="event" renameCount={2} />);

    expect(html).not.toContain("<button");
    expect(html).toContain("renamed 2×");
  });

  test("states who set the current name, and when (§5.1 subjectSetBy)", () => {
    const html = renderToStaticMarkup(
      <GroupNameCell
        name="Ops Team"
        nameSource="event"
        nameSetAt="2026-09-13T08:12:00Z"
        nameSetBy="4915112345678"
      />,
    );

    expect(html).toContain("set by 4915112345678 on 2026-09-13 08:12 UTC");
  });

  test("attaches no provenance to a name WhatsApp has not given yet", () => {
    const html = renderToStaticMarkup(
      <GroupNameCell
        name="(unnamed group) 120363043999999999"
        nameSource="fallback"
        nameSetAt="2026-09-13T08:12:00Z"
        nameSetBy="4915112345678"
      />,
    );

    expect(html).toContain("Name not synced yet");
    expect(html).not.toContain("set by");
  });
});
