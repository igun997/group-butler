import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { BotMessagesChart, wrapLabel } from "./bot-messages-chart";
import type { BotDay } from "@/lib/dashboard";

const BOTS: BotDay[] = [
  { instanceId: "6a1f9c", label: "Support bot", messagesIn: 1_204 },
  { instanceId: "8c2d5f", label: "Sales bot", messagesIn: 96 },
  { instanceId: "b0", label: "", messagesIn: 0 },
];

describe("wrapLabel", () => {
  test("a name that fits stays on one line", () => {
    expect(wrapLabel("Support bot")).toEqual(["Support bot"]);
  });

  test("a longer name wraps onto a second line rather than being clipped", () => {
    expect(wrapLabel("Customer Support Escalations")).toEqual(["Customer Support", "Escalations"]);
  });

  test("a name that still does not fit is truncated with an ellipsis", () => {
    expect(wrapLabel("Global Support Escalations Team Daily Digest")).toEqual(["Global Support", "Escalations Tea…"]);
    expect(wrapLabel("Supercalifragilisticexpialidocious")).toEqual(["Supercalifragil…"]);
  });

  test("an empty name is an empty line, never a missing tick", () => {
    expect(wrapLabel("")).toEqual([""]);
  });
});

/**
 * The chart is one image whose accessible name is the reading, so the per-bot
 * numbers are available without hovering a bar.
 */
describe("bot messages chart", () => {
  test("carries the day and every bot's count in its accessible name", () => {
    const html = renderToStaticMarkup(<BotMessagesChart bots={BOTS} day="2026-09-14" />);

    expect(html).toContain('role="img"');
    expect(html).toContain("Messages stored on 2026-09-14 (UTC), per bot.");
    expect(html).toContain("Support bot: 1,204");
    expect(html).toContain("Sales bot: 96");
    // A bot whose document has no label is named by its id rather than left blank.
    expect(html).toContain("b0: 0");
  });

  test("every bot gets a row, and a long roster stays bounded", () => {
    const rows = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ instanceId: `b${index}`, label: `Bot ${index}`, messagesIn: index }));

    // The plot itself is drawn by recharts in the browser; the height the
    // container reserves is what a dropped or unbounded row would change.
    expect(renderToStaticMarkup(<BotMessagesChart bots={rows(3)} day="2026-09-14" />)).toContain("height:120px");
    expect(renderToStaticMarkup(<BotMessagesChart bots={rows(1)} day="2026-09-14" />)).toContain("height:48px");
    expect(renderToStaticMarkup(<BotMessagesChart bots={rows(20)} day="2026-09-14" />)).toContain("height:288px");
  });
});
