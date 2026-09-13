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
});
