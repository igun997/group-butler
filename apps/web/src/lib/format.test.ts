import { describe, expect, test } from "vitest";
import { formatCount, formatPercent } from "./format";

describe("formatCount", () => {
  test("counts are grouped so a column of them can be read", () => {
    expect(formatCount(1_204)).toBe("1,204");
    expect(formatCount(200_000)).toBe("200,000");
    expect(formatCount(0)).toBe("0");
  });
});

describe("formatPercent", () => {
  test("a share of the whole is one decimal, and an empty whole has no share to state", () => {
    expect(formatPercent(4_614, 200_000)).toBe("2.3%");
    expect(formatPercent(100, 100)).toBe("100%");
    expect(formatPercent(1, 0)).toBe("not available");
  });
});
