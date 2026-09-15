import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { MessagesToday } from "./messages-today";
import type { Dashboard } from "@/lib/dashboard";

const ACTIVITY = [
  { instanceId: "6a1f9c", label: "Support bot", messagesIn: 1_204 },
  { instanceId: "8c2d5f", label: "Sales bot", messagesIn: 0 },
];

const read = (
  overrides: Partial<Pick<Dashboard, "day" | "messagesIn" | "activity" | "messagesError">> = {},
): Parameters<typeof MessagesToday>[0] => ({
  day: "2026-09-14",
  messagesIn: 1_204,
  activity: ACTIVITY,
  messagesError: null,
  ...overrides,
});

/**
 * The day's throughput. A day with nothing stored must not draw a plot: bars of
 * zero length are a blank chart with floating names, so the section says what is
 * missing and what will fill it instead (§10, antislop R-24).
 */
describe("messages today", () => {
  test("states the day's total and plots each bot under it", () => {
    const html = renderToStaticMarkup(<MessagesToday {...read()} />);

    expect(html).toContain("1,204");
    expect(html).toContain("messages stored today");
    expect(html).toContain("Messages stored on 2026-09-14 (UTC), per bot.");
    expect(html).toContain("Sales bot: 0");
    expect(html).toContain('data-slot="chart"');
  });

  test("a single message is counted in the singular", () => {
    const html = renderToStaticMarkup(<MessagesToday {...read({ messagesIn: 1 })} />);

    expect(html).toContain("message stored today");
    expect(html).not.toContain("messages stored today");
  });

  test("no message stored today draws no chart at all, and says what will fill it", () => {
    const html = renderToStaticMarkup(<MessagesToday {...read({ messagesIn: 0 })} />);

    expect(html).toContain("No message has been stored for 2026-09-14 (UTC)");
    expect(html).toContain("The first message that arrives in a group one of your bots is in appears here");
    expect(html).not.toContain('data-slot="chart"');
    expect(html).not.toContain("messages stored today");
    expect(html).not.toContain("axis");
  });

  test("a refused usage read says why instead of showing a zero", () => {
    const html = renderToStaticMarkup(
      <MessagesToday
        {...read({ day: null, messagesIn: null, activity: [], messagesError: "MongoDB did not answer, so today's usage could not be read." })}
      />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("MongoDB did not answer, so today&#x27;s usage could not be read.");
    expect(html).not.toContain("messages stored today");
    expect(html).not.toContain("data-slot=\"chart\"");
    expect(html).not.toContain("No message has been stored");
  });
});
