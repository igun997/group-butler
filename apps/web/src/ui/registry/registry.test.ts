import { describe, expect, test } from "vitest";
import {
  canonicalPath,
  registerView,
  resolveView,
  views,
  viewsFor,
  type Scope,
  type ScopeMode,
} from "./index";

/** The address catalog of spec §2.3 — one row per view, canonical route first. */
const ROUTES: readonly { id: string; scopeMode: ScopeMode; routes: readonly string[] }[] = [
  { id: "overview", scopeMode: "global", routes: ["/"] },
  { id: "instances", scopeMode: "global", routes: ["/instances"] },
  { id: "instance", scopeMode: "instance", routes: ["/instances/:instanceId"] },
  { id: "groups", scopeMode: "instance", routes: ["/groups", "/instances/:instanceId/groups"] },
  { id: "group", scopeMode: "group", routes: ["/groups/:groupJid"] },
  { id: "messages", scopeMode: "instance", routes: ["/messages", "/instances/:instanceId/activity"] },
  { id: "sends", scopeMode: "instance", routes: ["/sends", "/instances/:instanceId/sends"] },
  { id: "assistant", scopeMode: "group", routes: ["/assistant"] },
  { id: "stats", scopeMode: "group", routes: ["/stats", "/instances/:instanceId/stats"] },
  { id: "settings", scopeMode: "global", routes: ["/settings"] },
];

describe("the view registry (spec §2.3, §2.5)", () => {
  test("declares exactly the ten views of the workspace catalog", () => {
    expect(views().map((view) => view.id)).toEqual(ROUTES.map((row) => row.id));
  });

  test("every view declares its canonical route first and its scope mode", () => {
    for (const row of ROUTES) {
      const view = views().find((candidate) => candidate.id === row.id);
      expect(view?.scopeMode).toBe(row.scopeMode);
      expect(view?.routes).toEqual(row.routes);
    }
  });

  test("no two views claim the same route", () => {
    const claimed = views().flatMap((view) => view.routes);
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  test("every canonical route resolves to the view that declares it", () => {
    for (const view of views()) {
      for (const route of view.routes) {
        const deep = route
          .replace(":instanceId", "inst_1")
          .replace(":groupJid", "120363043123456789%40g.us");
        // A group address needs its instance, and a view with a required scope
        // needs it in the query when its route has no segment for one.
        const search =
          route.includes(":groupJid") || view.minScope === "instance" ? "?instance=inst_1" : "";
        expect(resolveView(deep, new URLSearchParams(search))?.id).toBe(view.id);
      }
    }
  });

  test("a view whose scope is required does not resolve at a shallower one (R5)", () => {
    const assistant = views().find((view) => view.id === "assistant")!;
    expect(assistant.minScope).toBe("instance");
    expect(canonicalPath(assistant, { kind: "global" })).toBeNull();
    expect(resolveView("/assistant", new URLSearchParams())).toBeNull();
    expect(viewsFor("global").map((view) => view.id)).not.toContain("assistant");
    expect(viewsFor("instance").map((view) => view.id)).toContain("assistant");
  });

  test("the alias of a view resolves to the same view as its canonical route", () => {
    const pairs: readonly [string, string, Scope][] = [
      ["/groups", "/instances/inst_1/groups", { kind: "instance", instanceId: "inst_1" }],
      ["/messages", "/instances/inst_1/activity", { kind: "instance", instanceId: "inst_1" }],
      ["/sends", "/instances/inst_1/sends", { kind: "instance", instanceId: "inst_1" }],
      ["/stats", "/instances/inst_1/stats", { kind: "instance", instanceId: "inst_1" }],
    ];
    for (const [canonical, alias, scope] of pairs) {
      const fromAlias = resolveView(alias, new URLSearchParams());
      expect(fromAlias?.scope).toEqual(scope);
      expect(resolveView(canonical, new URLSearchParams("instance=inst_1"))?.id).toBe(fromAlias?.id);
    }
  });

  test("an instance address is canonical when a scope is selected, the global one when it is not", () => {
    const groups = views().find((view) => view.id === "groups")!;
    expect(canonicalPath(groups, { kind: "global" })).toBe("/groups");
    expect(canonicalPath(groups, { kind: "instance", instanceId: "inst_1" })).toBe(
      "/instances/inst_1/groups",
    );
    expect(canonicalPath(groups, { kind: "group", instanceId: "inst_1", groupJid: "g@g.us" })).toBe(
      null,
    );
  });

  test("a view with no route for the scope gets a query address instead of none", () => {
    const assistant = views().find((view) => view.id === "assistant")!;
    expect(canonicalPath(assistant, { kind: "instance", instanceId: "inst_1" })).toBe(
      "/assistant?instance=inst_1",
    );
    expect(
      canonicalPath(assistant, { kind: "group", instanceId: "inst_1", groupJid: "g@g.us" }),
    ).toBe("/assistant?group=g%40g.us&instance=inst_1");
  });

  test("viewsFor returns the views an operator can open at that scope", () => {
    expect(viewsFor("global").map((view) => view.id)).toEqual([
      "overview",
      "instances",
      "groups",
      "messages",
      "sends",
      "stats",
      "settings",
    ]);
    expect(viewsFor("instance").map((view) => view.id)).toEqual([
      "instance",
      "groups",
      "messages",
      "sends",
      "assistant",
      "stats",
    ]);
    expect(viewsFor("group").map((view) => view.id)).toEqual(["group", "assistant", "stats"]);
  });

  test("registerView adds a view without touching any other, and upserts by id", () => {
    registerView({
      id: "audit",
      title: "Audit",
      scopeMode: "global",
      routes: ["/audit"],
      params: views()[0]!.params,
    });
    expect(resolveView("/audit", new URLSearchParams())?.id).toBe("audit");
    expect(viewsFor("global").map((view) => view.id)).toContain("audit");

    // Registering an id twice completes or replaces it; it never shadows it twice.
    registerView({ id: "audit", title: "Audit log", scopeMode: "global", routes: ["/audit"], params: views()[0]!.params });
    expect(views().filter((view) => view.id === "audit")).toHaveLength(1);
    expect(resolveView("/audit", new URLSearchParams())?.view.title).toBe("Audit log");
    expect(views()).toHaveLength(ROUTES.length + 1);
  });
});
