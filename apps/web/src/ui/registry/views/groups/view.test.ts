import { describe, expect, test } from "vitest";
import { canonicalPath, parseParams, resolveView, views, viewsFor } from "../../index";
import { groupsView } from "./index";
import { GROUPS_ALL, GROUPS_INSTANCE } from "./model";

/**
 * The groups view's registration (docs/ui-decision.md §2.2 invariant 5, §2.3,
 * §2.5; P5's "one resource descriptor set, one view descriptor, one
 * registerView() call").
 *
 * The point of these cases is that P5 *completed* the address P2 declared rather
 * than restating it: the routes, the scope mode, and the catalog are still the
 * registry's, and what this module adds is the UI half. That is what makes
 * adding a workspace a thing a view owns instead of a thing the shell absorbs.
 */

describe("the groups view is registered (§2.5)", () => {
  test("it completes the registry's declaration instead of adding a second view", () => {
    const declared = views().filter((view) => view.id === "groups");

    expect(declared).toHaveLength(1);
    expect(declared[0]).toBe(groupsView);
    expect(groupsView.routes).toEqual(["/groups", "/instances/:instanceId/groups"]);
    expect(groupsView.scopeMode).toBe("instance");
  });

  test("registering it left the rest of the catalog where it was", () => {
    expect(views().map((view) => view.id)).toEqual([
      "overview",
      "instances",
      "instance",
      "groups",
      "group",
      "messages",
      "sends",
      "assistant",
      "stats",
      "settings",
    ]);
  });

  test("both addresses resolve to it, each with its own scope", () => {
    expect(resolveView("/groups", new URLSearchParams())).toMatchObject({
      id: "groups",
      scope: { kind: "global" },
      canonical: "/groups",
    });
    expect(resolveView("/instances/inst_1/groups", new URLSearchParams())).toMatchObject({
      id: "groups",
      scope: { kind: "instance", instanceId: "inst_1" },
      canonical: "/instances/inst_1/groups",
    });
  });

  test("it is offered at the two scopes it answers, and at no deeper one", () => {
    expect(viewsFor("global").map((view) => view.id)).toContain("groups");
    expect(viewsFor("instance").map((view) => view.id)).toContain("groups");
    expect(canonicalPath(groupsView, { kind: "group", instanceId: "inst_1", groupJid: "g@g.us" })).toBeNull();
  });

  test("it declares the three surfaces a route would otherwise have to write itself", () => {
    expect(groupsView.panels?.map((panel) => panel.id)).toEqual(["groups-table"]);
    expect(groupsView.panels?.[0]?.resources.map((resource) => resource.id)).toEqual([
      GROUPS_ALL,
      GROUPS_INSTANCE,
    ]);
    expect(groupsView.skeleton?.blocks).toEqual([
      { shape: "header", count: 1 },
      { shape: "table", count: 8 },
    ]);
    expect(groupsView.actions?.map((action) => action.id)).toEqual(["sync-groups"]);
  });

  test("every empty reason has copy of its own (R-E1, R-E2)", () => {
    const empty = groupsView.empty!;
    const titles = Object.values(empty).map((copy) => copy.title);
    const bodies = Object.values(empty).map((copy) => copy.body);

    expect(Object.keys(empty)).toHaveLength(5);
    expect(new Set(titles).size).toBe(5);
    expect(new Set(bodies).size).toBe(5);
  });

  test("the params it declares are the ones its reads can honour", () => {
    // The two group reads accept no filters, so a filter in the address is
    // dropped and the URL is rewritten rather than half-applied (§2.3).
    expect(parseParams(groupsView.params, new URLSearchParams("q=ops&assigned=true&state=active"))).toEqual({});
  });
});
