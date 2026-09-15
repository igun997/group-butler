import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { TokenTrendChart } from "./token-trend-chart";
import type { TokenSeries } from "@/lib/dashboard";

const SERIES: TokenSeries = {
  instanceId: "6a1f9c",
  label: "Support bot",
  calls: 6,
  reportedDays: 2,
  days: [
    // No call: a factual zero, which is what the line reaches.
    { day: "2026-09-12", calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    // Called, provider said nothing: a gap in the line.
    { day: "2026-09-13", calls: 1, inputTokens: null, outputTokens: null, totalTokens: null },
    { day: "2026-09-14", calls: 1, inputTokens: 40, outputTokens: 400, totalTokens: 440 },
  ],
};

/**
 * The chart is one image with a short accessible name, and the same figure holds
 * the seven days as a table, so the numbers are reachable without hovering a line
 * — and a day nobody reported reads as "not reported", never as zero.
 */
describe("token trend chart", () => {
  test("names itself after the bot and keeps its whole week in the same figure", () => {
    const html = renderToStaticMarkup(<TokenTrendChart series={SERIES} max={440} />);

    expect(html).toContain('role="img"');
    expect(html).toContain("Assistant tokens for Support bot, last seven days");
    expect(html).toContain("<caption>");
    expect(html).toContain("Support bot (6a1f9c) assistant tokens by UTC day");
    expect(html).toContain("440");
    // The two absences must not read the same: a quiet day is zero, a silent
    // provider is a gap.
    expect(html).toMatch(/2026-09-12<\/th><td>0<\/td><td>0<\/td><td>0<\/td><td>0<\/td>/u);
    expect(html).toMatch(/2026-09-13<\/th><td>1<\/td><td>not reported<\/td><td>not reported<\/td><td>not reported<\/td>/u);
  });

  test("a bot with no label is named by its id in both places", () => {
    const html = renderToStaticMarkup(<TokenTrendChart series={{ ...SERIES, label: "" }} max={440} />);

    expect(html).toContain("Assistant tokens for 6a1f9c, last seven days");
    expect(html).toContain("6a1f9c (6a1f9c) assistant tokens by UTC day");
  });
});
