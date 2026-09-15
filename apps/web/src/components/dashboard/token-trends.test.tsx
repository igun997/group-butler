import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { TokenTrends } from "./token-trends";
import type { Dashboard, TokenSeries } from "@/lib/dashboard";
import type { TokenDay } from "@/server/console";

const DAYS = ["2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13", "2026-09-14"];

/** A quiet day: no call, so the figures are a factual zero. */
const quietDay = (value: string): TokenDay => ({ day: value, calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 });

/** A day that called and reported: the provider's figures. */
const reportedDay = (value: string, input: number, output: number, total: number): TokenDay => ({
  day: value,
  calls: 1,
  inputTokens: input,
  outputTokens: output,
  totalTokens: total,
});

/** A day that called and came back with nothing: a gap, not a zero. */
const unreportedDay = (value: string, calls = 1): TokenDay => ({
  day: value,
  calls,
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
});

/** Calls on two days, one of which reported nothing: the gap the page must keep. */
const REPORTED: TokenSeries = {
  instanceId: "6a1f9c",
  label: "Support bot",
  calls: 6,
  reportedDays: 2,
  days: [
    quietDay(DAYS[0]!),
    reportedDay(DAYS[1]!, 40, 400, 440),
    unreportedDay(DAYS[2]!),
    quietDay(DAYS[3]!),
    quietDay(DAYS[4]!),
    reportedDay(DAYS[5]!, 7, 21, 28),
    quietDay(DAYS[6]!),
  ],
};

const read = (overrides: Partial<Pick<Dashboard, "tokens" | "tokenMax" | "tokensError">> = {}): Parameters<typeof TokenTrends>[0] => ({
  tokens: [REPORTED],
  tokenMax: 440,
  tokensError: null,
  ...overrides,
});

/**
 * The week's token spend, one chart per bot. A bot that never called and a bot
 * whose provider said nothing are different absences, and both must be stated
 * rather than drawn as a line at zero.
 */
describe("token trends", () => {
  test("charts a bot's week and counts the calls and the days that reported", () => {
    const html = renderToStaticMarkup(<TokenTrends {...read()} />);

    expect(html).toContain("Support bot");
    expect(html).toContain("6a1f9c");
    expect(html).toContain("Assistant tokens for Support bot, last seven days");
    expect(html).toContain("6 calls, usage reported on 2 of 7 days.");
  });

  test("the seven days are a table: a quiet day is zero, an unreported call is a gap", () => {
    const html = renderToStaticMarkup(<TokenTrends {...read()} />);

    expect(html).toContain("<table");
    expect(html).toContain("2026-09-09");
    expect(html).toContain("440");
    expect(html).toContain("not reported");
    expect((html.match(/<tr>/gu) ?? []).length).toBeGreaterThanOrEqual(8);
    // 2026-09-08 had no call, so its row is a factual zero rather than a gap.
    expect(html).toMatch(/2026-09-08<\/th><td>0<\/td><td>0<\/td><td>0<\/td><td>0<\/td>/u);
  });

  test("a bot with no call is said, not plotted at zero", () => {
    const quiet: TokenSeries = { ...REPORTED, calls: 0, reportedDays: 0, days: DAYS.map((value) => quietDay(value)) };
    const html = renderToStaticMarkup(<TokenTrends {...read({ tokens: [quiet], tokenMax: null })} />);

    expect(html).toContain("No assistant call in the last seven days.");
    expect(html).not.toContain("Assistant tokens for Support bot");
    expect(html).not.toContain("usage reported on");
  });

  test("calls whose usage never arrived are said, not filled with zeroes", () => {
    const unreported: TokenSeries = { ...REPORTED, calls: 2, reportedDays: 0, days: DAYS.map((value) => (value === DAYS[6] ? unreportedDay(value, 2) : quietDay(value))) };
    const html = renderToStaticMarkup(<TokenTrends {...read({ tokens: [unreported], tokenMax: null })} />);

    expect(html).toContain("Calls ran, but the provider reported no token usage, so there is nothing to plot.");
    expect(html).toContain("2 calls, usage reported on 0 of 7 days.");
    expect(html).not.toContain("Assistant tokens for Support bot");
  });

  test("no bot at all names what would create the history", () => {
    const html = renderToStaticMarkup(<TokenTrends {...read({ tokens: [], tokenMax: null })} />);

    expect(html).toContain("Token history appears once a bot runs an assistant call.");
  });

  test("a refused token read says why instead of drawing nothing", () => {
    const html = renderToStaticMarkup(
      <TokenTrends {...read({ tokens: null, tokenMax: null, tokensError: "MongoDB did not answer, so the token history could not be read." })} />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("MongoDB did not answer, so the token history could not be read.");
    expect(html).not.toContain("Token history appears once");
  });
});
