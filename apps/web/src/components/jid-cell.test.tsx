import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { JidCell } from "./jid-cell";

const JID = "120363043123456789@g.us";

/**
 * R11 through R-A6: the full `<id>@g.us` is always on screen — never truncated,
 * never replaced by a name — and where it can be copied, the control that copies
 * it is named by the value it copies.
 */
describe("JidCell (R11, R-A6, R-M7)", () => {
  test("renders the whole JID as text, in its own monospace container", () => {
    const html = renderToStaticMarkup(<JidCell jid={JID} />);

    expect(html).toContain(JID);
    expect(html).toContain('class="jid-cell__value"');
  });

  test("is a non-interactive cell until it is asked to be copyable", () => {
    expect(renderToStaticMarkup(<JidCell jid={JID} />)).not.toContain("<button");
  });

  test("offers a copy control named by the value it copies", () => {
    const html = renderToStaticMarkup(<JidCell jid={JID} copyable />);

    expect(html).toContain("<button");
    expect(html).toContain(`aria-label="Copy group ID ${JID}"`);
    expect(html).toContain(JID);
  });
});
