import { describe, expect, test } from "vitest";
import { DEFAULT_LANDING, safeNextPath } from "./next-path";

describe("safeNextPath", () => {
  test("keeps a path on this origin", () => {
    for (const value of ["/", "/instances", "/instances/abc/groups?tab=members"]) {
      expect([value, safeNextPath(value)]).toEqual([value, value]);
    }
  });

  test("falls back to the console root for anything that could leave this origin", () => {
    for (const value of ["//evil.test", "https://evil.test", "/\\evil.test", "/a\u0000b", "instances", ""]) {
      expect([value, safeNextPath(value)]).toEqual([value, DEFAULT_LANDING]);
    }
  });

  test("falls back when there is nothing to read", () => {
    for (const value of [undefined, null]) {
      expect([value, safeNextPath(value)]).toEqual([value, DEFAULT_LANDING]);
    }
  });
});
