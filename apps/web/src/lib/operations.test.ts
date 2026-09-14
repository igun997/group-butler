import { describe, expect, test } from "vitest";
import { aiTotals, formatCount, formatInterval, formatPercent, loopOutcome } from "./operations";

describe("formatInterval", () => {
  test("a cadence is stated in the largest unit that divides it exactly", () => {
    expect(formatInterval(5_000)).toBe("5s");
    expect(formatInterval(300_000)).toBe("5m");
    expect(formatInterval(1_800_000)).toBe("30m");
    expect(formatInterval(3_600_000)).toBe("1h");
    expect(formatInterval(5_400_000)).toBe("90m");
  });

  test("a sub-second ticker keeps its milliseconds", () => {
    expect(formatInterval(500)).toBe("500ms");
  });

  test("no declared interval is stated in words rather than as a dash", () => {
    expect(formatInterval(0)).toBe("not available");
    expect(formatInterval(-1)).toBe("not available");
    expect(formatInterval(Number.NaN)).toBe("not available");
  });
});

describe("formatCount", () => {
  test("counts are grouped so a column of them can be read", () => {
    expect(formatCount(1_204)).toBe("1,204");
    expect(formatCount(200_000)).toBe("200,000");
    expect(formatCount(0)).toBe("0");
  });
});

describe("formatPercent", () => {
  test("a share of the budget is one decimal, and an empty budget has no share to state", () => {
    expect(formatPercent(4_614, 200_000)).toBe("2.3%");
    expect(formatPercent(100, 100)).toBe("100%");
    expect(formatPercent(1, 0)).toBe("not available");
  });
});

describe("loopOutcome", () => {
  test("a pass that ran and failed is a failure, whatever the stamp says", () => {
    expect(loopOutcome({ lastRunAt: "2026-09-14T09:12:03Z", lastError: "GetJoinedGroups timed out" })).toEqual({
      state: "failed",
      label: "Failed",
    });
  });

  test("a clean pass carries its last run", () => {
    expect(loopOutcome({ lastRunAt: "2026-09-14T09:12:03Z", lastError: "" })).toEqual({
      state: "ok",
      label: "OK",
    });
  });

  test("a declared loop that has not run yet is not a failure", () => {
    expect(loopOutcome({ lastRunAt: null, lastError: "" })).toEqual({
      state: "inactive",
      label: "Not yet run",
    });
  });
});

describe("aiTotals", () => {
  const tokens = { calls: 3, inputTokens: 1_204, outputTokens: 3_410, totalTokens: 4_614 };

  test("no call today is said in words, not as zero tokens", () => {
    expect(aiTotals({ ...tokens, calls: 0 }, 200_000)).toEqual({ kind: "no-calls" });
  });

  test("a provider that reported nothing is absent, not a zero that reads as free", () => {
    expect(aiTotals({ calls: 2, inputTokens: null, outputTokens: null, totalTokens: null }, 200_000)).toEqual({
      kind: "unreported",
    });
  });

  test("a measured day is stated against the configured budget", () => {
    expect(aiTotals(tokens, 200_000)).toEqual({
      kind: "reported",
      input: 1_204,
      output: 3_410,
      total: 4_614,
      note: "4,614 of 200,000 tokens allowed today (2.3%).",
      over: false,
    });
  });

  test("an overspent day says so in words, so the colour is not the only signal", () => {
    const over = aiTotals({ ...tokens, totalTokens: 250_000 }, 200_000);
    expect(over).toMatchObject({ kind: "reported", over: true });
    expect(over.kind === "reported" && over.note).toBe(
      "Over budget: 250,000 of 200,000 tokens allowed today (125%).",
    );
  });

  test("an unconfigured budget is named instead of comparing against nothing", () => {
    const unset = aiTotals(tokens, null);
    expect(unset).toMatchObject({ kind: "reported", over: false });
    expect(unset.kind === "reported" && unset.note).toContain("No daily token budget is configured");
    expect(aiTotals(tokens, 0)).toMatchObject({ kind: "reported", over: false });
  });
});
