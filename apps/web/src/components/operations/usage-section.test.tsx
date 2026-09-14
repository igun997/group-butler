import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { UsageSection } from "./usage-section";
import type { UsageDay, UsageInstance } from "@/lib/operations";

const RECORDED: UsageInstance = {
  instanceId: "6a1f9c",
  label: "Support bot",
  recorded: true,
  counters: { messagesIn: 1_204, mediaStored: 318, mediaUnparsed: 12, sendsOk: 47, sendsFailed: 2, receipts: 39 },
  tokens: { calls: 3, inputTokens: 1_204, outputTokens: 3_410, totalTokens: 4_614 },
};

const DAY: UsageDay = { day: "2026-09-14", maxTokensPerDay: 200_000, recorded: true, instances: [RECORDED] };

/**
 * Today's usage is the only place the day's numbers exist, and every one of them
 * has to be either true or visibly absent: a zero that means "unread" would be
 * read as "nothing happened".
 */
describe("usage section", () => {
  test("the day's counters are printed per instance, with the UTC day named", () => {
    const html = renderToStaticMarkup(<UsageSection result={{ ok: true, data: DAY }} />);

    expect(html).toContain("Support bot");
    expect(html).toContain("6a1f9c");
    expect(html).toContain("2026-09-14");
    expect(html).toContain("Messages in");
    expect(html).toContain("1,204");
    expect(html).toContain("Media stored");
    expect(html).toContain("318");
    expect(html).toContain("Media unparsed");
    expect(html).toContain("12");
    expect(html).toContain("Sends ok");
    expect(html).toContain("47");
    expect(html).toContain("Sends failed");
    expect(html).toContain("Receipts");
    expect(html).toContain("39");
  });

  test("tokens are shown in, out and total, measured against the daily budget", () => {
    const html = renderToStaticMarkup(<UsageSection result={{ ok: true, data: DAY }} />);

    expect(html).toContain("AI tokens in");
    expect(html).toContain("AI tokens out");
    expect(html).toContain("AI tokens total");
    expect(html).toContain("4,614 of 200,000 tokens allowed today (2.3%)");
  });

  test("an overspent day says so in words, so colour is not the only signal", () => {
    const html = renderToStaticMarkup(
      <UsageSection
        result={{
          ok: true,
          data: { ...DAY, instances: [{ ...RECORDED, tokens: { ...RECORDED.tokens, totalTokens: 250_000 } }] },
        }}
      />,
    );

    expect(html).toContain("Over budget: 250,000 of 200,000 tokens allowed today (125%)");
  });

  test("a provider that reported nothing is absent, not a free zero", () => {
    const html = renderToStaticMarkup(
      <UsageSection
        result={{
          ok: true,
          data: {
            ...DAY,
            instances: [
              {
                ...RECORDED,
                tokens: { calls: 2, inputTokens: null, outputTokens: null, totalTokens: null },
              },
            ],
          },
        }}
      />,
    );

    expect(html).toContain("not reported");
    expect(html).toContain("The provider reported no token usage");
    expect(html).not.toContain("AI tokens total");
    expect(html).not.toContain("tokens allowed today");
  });

  test("an unconfigured budget is named rather than compared against nothing", () => {
    const html = renderToStaticMarkup(<UsageSection result={{ ok: true, data: { ...DAY, maxTokensPerDay: null } }} />);

    expect(html).toContain("4,614");
    expect(html).toContain("No daily token budget is configured");
    expect(html).not.toContain("tokens allowed today");
  });

  test("a day with no assistant call says that, instead of printing zero tokens", () => {
    const html = renderToStaticMarkup(
      <UsageSection
        result={{
          ok: true,
          data: {
            ...DAY,
            instances: [
              {
                ...RECORDED,
                tokens: { calls: 0, inputTokens: null, outputTokens: null, totalTokens: null },
              },
            ],
          },
        }}
      />,
    );

    expect(html).toContain("No assistant call has been made today");
    expect(html).not.toContain("AI tokens in");
  });

  test("an instance with nothing recorded is a sentence, not a row of zeros", () => {
    const html = renderToStaticMarkup(
      <UsageSection
        result={{
          ok: true,
          data: {
            ...DAY,
            instances: [
              {
                ...RECORDED,
                recorded: false,
                counters: { messagesIn: 0, mediaStored: 0, mediaUnparsed: 0, sendsOk: 0, sendsFailed: 0, receipts: 0 },
                tokens: { calls: 0, inputTokens: null, outputTokens: null, totalTokens: null },
              },
            ],
          },
        }}
      />,
    );

    expect(html).toContain("Nothing recorded today yet");
    expect(html).not.toContain("Messages in");
  });

  test("a day that recorded nothing names the day and what would fill it", () => {
    const html = renderToStaticMarkup(
      <UsageSection
        result={{
          ok: true,
          data: {
            ...DAY,
            recorded: false,
            instances: [
              {
                ...RECORDED,
                recorded: false,
                counters: { messagesIn: 0, mediaStored: 0, mediaUnparsed: 0, sendsOk: 0, sendsFailed: 0, receipts: 0 },
                tokens: { calls: 0, inputTokens: null, outputTokens: null, totalTokens: null },
              },
            ],
          },
        }}
      />,
    );

    expect(html).toContain("Nothing has been recorded for 2026-09-14 (UTC)");
    expect(html).toContain("A counter moves when the worker stores a message");
  });

  test("no instance asks for the one thing that would create usage", () => {
    const html = renderToStaticMarkup(
      <UsageSection result={{ ok: true, data: { ...DAY, recorded: false, instances: [] } }} />,
    );

    expect(html).toContain("No instance is linked yet");
    expect(html).toContain("until a WhatsApp account is linked");
  });

  test("an instance with no stored label is shown by its id, once", () => {
    const html = renderToStaticMarkup(
      <UsageSection
        result={{ ok: true, data: { ...DAY, instances: [{ ...RECORDED, label: "" }] } }}
      />,
    );

    expect(html).toContain("6a1f9c");
    expect(html.match(/6a1f9c/g)).toHaveLength(1);
  });

  test("Mongo being unreadable fails on its own, with the loader's fixed phrase", () => {
    const html = renderToStaticMarkup(
      <UsageSection result={{ ok: false, error: "MongoDB did not answer, so today could not be read." }} />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("MongoDB did not answer, so today could not be read.");
  });
});
