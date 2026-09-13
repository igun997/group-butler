import { describe, expect, test } from "vitest";
import { encodeScope, normalizeScope, parseScope, resolveView, type Scope } from "./index";

/**
 * Spec §2.3: `parseScope → normalizeScope → encodeScope`. Every case below is an
 * address an operator can actually arrive at — a deep link, an alias, a stale
 * bookmark — and the expectation is always the same: a resolved scope or a
 * working default, never an error.
 */
describe("scope resolution and canonicalisation", () => {
  const cases: readonly {
    name: string;
    path: string;
    search: string;
    scope: Scope | null;
    view: string | null;
  }[] = [
    { name: "global root", path: "/", search: "", scope: { kind: "global" }, view: "overview" },
    {
      name: "instance",
      path: "/instances/inst_1",
      search: "",
      scope: { kind: "instance", instanceId: "inst_1" },
      view: "instance",
    },
    {
      name: "group with required instance",
      path: "/groups/120363043123456789%40g.us",
      search: "?instance=inst_1",
      scope: { kind: "group", instanceId: "inst_1", groupJid: "120363043123456789@g.us" },
      view: "group",
    },
    {
      name: "alias resolves to the same view",
      path: "/instances/inst_1/groups",
      search: "",
      scope: { kind: "instance", instanceId: "inst_1" },
      view: "groups",
    },
    { name: "unknown view", path: "/nope", search: "", scope: null, view: null },
    {
      name: "a trailing slash is the same address",
      path: "/instances/",
      search: "",
      scope: { kind: "global" },
      view: "instances",
    },
    {
      name: "the groups view is global when no instance is selected",
      path: "/groups",
      search: "",
      scope: { kind: "global" },
      view: "groups",
    },
    {
      name: "an instance query deepens a global route",
      path: "/groups",
      search: "?instance=inst_1",
      scope: { kind: "instance", instanceId: "inst_1" },
      view: "groups",
    },
    {
      name: "the instance activity alias is the messages view",
      path: "/instances/inst_1/activity",
      search: "",
      scope: { kind: "instance", instanceId: "inst_1" },
      view: "messages",
    },
    {
      name: "the instance sends alias is the sends view",
      path: "/instances/inst_1/sends",
      search: "",
      scope: { kind: "instance", instanceId: "inst_1" },
      view: "sends",
    },
    {
      name: "the instance stats alias is the stats view",
      path: "/instances/inst_1/stats",
      search: "",
      scope: { kind: "instance", instanceId: "inst_1" },
      view: "stats",
    },
    {
      name: "the assistant takes its instance from the query",
      path: "/assistant",
      search: "?instance=inst_1",
      scope: { kind: "instance", instanceId: "inst_1" },
      view: "assistant",
    },
    {
      name: "the assistant still resolves without the instance it requires",
      path: "/assistant",
      search: "",
      scope: { kind: "global" },
      view: "assistant",
    },
    {
      name: "a group query lifts the stats view to group scope",
      path: "/stats",
      search: "?instance=inst_1&group=120363043123456789%40g.us",
      scope: { kind: "group", instanceId: "inst_1", groupJid: "120363043123456789@g.us" },
      view: "stats",
    },
    {
      name: "a scope deeper than the view accepts is normalised",
      path: "/settings",
      search: "?instance=inst_1&group=120363043123456789%40g.us",
      scope: { kind: "global" },
      view: "settings",
    },
    {
      name: "a percent-encoded segment is decoded",
      path: "/instances/inst%5F1",
      search: "",
      scope: { kind: "instance", instanceId: "inst_1" },
      view: "instance",
    },
    { name: "an unknown sub-route is not a view", path: "/instances/inst_1/nope", search: "", scope: null, view: null },
  ];

  for (const tc of cases) {
    test(tc.name, () => {
      const scope = parseScope(tc.path, new URLSearchParams(tc.search));
      expect(scope).toEqual(tc.scope);
      expect(resolveView(tc.path, new URLSearchParams(tc.search))?.id ?? null).toBe(tc.view);
    });
  }

  test("a scope deeper than the view accepts is normalised, not rejected", () => {
    const normalized = normalizeScope(
      { kind: "group", instanceId: "inst_1", groupJid: "g@g.us" },
      "instance",
    );
    expect(normalized).toEqual({ kind: "instance", instanceId: "inst_1" });
  });

  test("normalisation keeps a scope the view is deep enough for, and shallowens one it is not", () => {
    expect(normalizeScope({ kind: "global" }, "group")).toEqual({ kind: "global" });
    expect(normalizeScope({ kind: "instance", instanceId: "inst_1" }, "global")).toEqual({
      kind: "global",
    });
    expect(normalizeScope({ kind: "instance", instanceId: "inst_1" }, "instance")).toEqual({
      kind: "instance",
      instanceId: "inst_1",
    });
    expect(
      normalizeScope({ kind: "group", instanceId: "inst_1", groupJid: "g@g.us" }, "group"),
    ).toEqual({ kind: "group", instanceId: "inst_1", groupJid: "g@g.us" });
  });

  test("a group scope without an instance is invalid, not an error page", () => {
    expect(parseScope("/groups/120363043123456789%40g.us", new URLSearchParams())).toBeNull();
    expect(resolveView("/groups/120363043123456789%40g.us", new URLSearchParams())).toBeNull();
  });

  test("encodeScope round-trips and keeps the canonical form", () => {
    const scope = {
      kind: "group",
      instanceId: "inst_1",
      groupJid: "120363043123456789@g.us",
    } as const;
    expect(encodeScope(scope)).toBe("/groups/120363043123456789%40g.us?instance=inst_1");
    expect(encodeScope({ kind: "global" })).toBe("/");
    expect(encodeScope({ kind: "instance", instanceId: "inst_1" })).toBe("/instances/inst_1");
  });

  test("every canonical address resolves back to the scope it encodes", () => {
    const scopes: readonly Scope[] = [
      { kind: "global" },
      { kind: "instance", instanceId: "inst_1" },
      { kind: "group", instanceId: "inst_1", groupJid: "120363043123456789@g.us" },
    ];
    for (const scope of scopes) {
      const [path, query = ""] = encodeScope(scope).split("?");
      expect(parseScope(path!, new URLSearchParams(query))).toEqual(scope);
    }
  });

  test("invalid params are dropped and the view still renders a working default", () => {
    const resolved = resolveView("/messages", new URLSearchParams("limit=not-a-number"));
    expect(resolved?.id).toBe("messages");
    expect(resolved?.params.limit).toBeUndefined();
  });

  test("valid params survive and unknown ones do not", () => {
    const resolved = resolveView("/messages", new URLSearchParams("q=invoice&cursor=abc&nope=1"));
    expect(resolved?.params).toEqual({ q: "invoice", cursor: "abc" });
  });

  test("a declared param holding an invalid value is dropped rather than failing the view", () => {
    const resolved = resolveView("/instances", new URLSearchParams("status=bogus"));
    expect(resolved?.id).toBe("instances");
    expect(resolved?.params.status).toBeUndefined();
    expect(resolveView("/instances", new URLSearchParams("status=connected"))?.params.status).toBe(
      "connected",
    );
  });

  test("the canonical address carries the scope in the path and drops the query that expressed it", () => {
    expect(resolveView("/groups", new URLSearchParams("instance=inst_1"))?.canonical).toBe(
      "/instances/inst_1/groups",
    );
    expect(
      resolveView(
        "/groups/120363043123456789%40g.us",
        new URLSearchParams("instance=inst_1"),
      )?.canonical,
    ).toBe("/groups/120363043123456789%40g.us?instance=inst_1");
    expect(resolveView("/messages", new URLSearchParams("instance=inst_1"))?.canonical).toBe(
      "/instances/inst_1/activity",
    );
    expect(resolveView("/assistant", new URLSearchParams("instance=inst_1"))?.canonical).toBe(
      "/assistant?instance=inst_1",
    );
  });

  test("the canonical address keeps the validated params in a stable order", () => {
    expect(resolveView("/messages", new URLSearchParams("cursor=abc&q=invoice"))?.canonical).toBe(
      "/messages?cursor=abc&q=invoice",
    );
  });

  test("scope carries the instance and the group, never a loose filter param", () => {
    const resolved = resolveView(
      "/groups/120363043123456789%40g.us",
      new URLSearchParams("instance=inst_1"),
    );
    expect(resolved?.params.instance).toBeUndefined();
    expect(resolved?.params.group).toBeUndefined();
  });
});
