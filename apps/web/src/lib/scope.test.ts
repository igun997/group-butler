import { describe, expect, test } from "vitest";
import { filterGroups, scopeIsDirty, scopePayload } from "./scope";

const groups = [
  { jid: "120363040000000001@g.us", name: "Ops Team" },
  { jid: "120363040000000002@g.us", name: "Suppliers ID" },
  { jid: "120363040000000003@g.us", name: "Ops Standup" },
];

/**
 * The assistant-scope editor's decisions, kept out of the component: whether a
 * selection differs from what is stored, what the request carries, and which
 * groups a search leaves visible.
 */
describe("scopeIsDirty", () => {
  test("the same groups in a different order are not a change", () => {
    const whitelisted = ["120363040000000001@g.us", "120363040000000002@g.us"];

    expect(scopeIsDirty(whitelisted, ["120363040000000002@g.us", "120363040000000001@g.us"])).toBe(false);
  });

  test("adding or removing one group is a change", () => {
    const whitelisted = ["120363040000000001@g.us"];

    expect(scopeIsDirty(whitelisted, ["120363040000000001@g.us", "120363040000000002@g.us"])).toBe(true);
    expect(scopeIsDirty(whitelisted, [])).toBe(true);
  });

  test("an empty scope against an empty selection is settled", () => {
    expect(scopeIsDirty([], [])).toBe(false);
  });
});

describe("scopePayload", () => {
  test("the request carries each group once, in a stable order", () => {
    expect(scopePayload(["120363040000000002@g.us", "120363040000000001@g.us", "120363040000000002@g.us"])).toEqual([
      "120363040000000001@g.us",
      "120363040000000002@g.us",
    ]);
  });
});

describe("filterGroups", () => {
  test("an empty query keeps every group", () => {
    expect(filterGroups(groups, "")).toHaveLength(3);
  });

  test("the query matches the name or the jid, ignoring case and surrounding space", () => {
    expect(filterGroups(groups, "  ops ").map((group) => group.name)).toEqual(["Ops Team", "Ops Standup"]);
    expect(filterGroups(groups, "0002").map((group) => group.name)).toEqual(["Suppliers ID"]);
  });

  test("a query that matches nothing returns nothing, rather than everything", () => {
    expect(filterGroups(groups, "no such group")).toEqual([]);
  });
});
