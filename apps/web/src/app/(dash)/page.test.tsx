import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import OverviewPage from "./page";

/**
 * The one authenticated route that exists in P1. The shell owns the `h1` and the
 * `main` landmark (R-A5), so the page must add neither: this is what keeps the
 * whole rendered page at exactly one heading of level 1.
 */
describe("the overview route's page content", () => {
  test("adds no landmark and no heading of its own", () => {
    const html = renderToStaticMarkup(<OverviewPage />);

    expect(html).not.toContain("<h1");
    expect(html).not.toContain("<main");
    expect(html).toContain("<h2");
  });
});
