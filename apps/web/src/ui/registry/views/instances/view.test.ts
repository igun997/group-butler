import { describe, expect, test } from "vitest";
import { canonicalPath, parseParams, resolveView, views, viewsFor } from "../../index";
import { instancesView } from "./index";
import { INSTANCES_ALL } from "./model";

/**
 * The instances view's registration (docs/ui-decision.md §2.2 invariant 5, §2.3,
 * §2.5; P6's "one resource descriptor set, one view descriptor, one
 * registerView() call").
 *
 * The point of these cases is that P6 *completed* the address P2 declared rather
 * than restating it: the route, the scope mode and the catalog are still the
 * registry's, and what this module adds is the UI half.
 */

describe("the instances view is registered (§2.5)", () => {
  test("it completes the registry's declaration instead of adding a second view", () => {
    const declared = views().filter((view) => view.id === "instances");

    expect(declared).toHaveLength(1);
    expect(declared[0]).toBe(instancesView);
    expect(instancesView.routes).toEqual(["/instances"]);
    expect(instancesView.scopeMode).toBe("global");
  });

  test("registering it and the instance page left the rest of the catalog where it was", () => {
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

  test("its address resolves to it at the global scope, and to no deeper one", () => {
    expect(resolveView("/instances", new URLSearchParams())).toMatchObject({
      id: "instances",
      scope: { kind: "global" },
      canonical: "/instances",
    });
    expect(viewsFor("global").map((view) => view.id)).toContain("instances");
    expect(canonicalPath(instancesView, { kind: "instance", instanceId: "inst_1" })).toBeNull();
  });

  test("it declares the surfaces a route would otherwise have to write itself", () => {
    expect(instancesView.panels?.map((panel) => panel.id)).toEqual(["instances-list"]);
    expect(instancesView.panels?.[0]?.resources.map((resource) => resource.id)).toEqual([INSTANCES_ALL]);
    expect(instancesView.skeleton?.blocks).toEqual([
      { shape: "header", count: 1 },
      { shape: "table", count: 5 },
    ]);
  });

  test("every empty reason has copy of its own (R-E1, R-E2)", () => {
    const empty = instancesView.empty!;
    const titles = Object.values(empty).map((copy) => copy.title);
    const bodies = Object.values(empty).map((copy) => copy.body);

    expect(Object.keys(empty)).toHaveLength(5);
    expect(new Set(titles).size).toBe(5);
    expect(new Set(bodies).size).toBe(5);
  });

  test("it declares no param its read cannot honour (R-E1's `filtered` stays unreachable)", () => {
    // The read is the worker's whole instance list: it takes no filters, so a
    // filter in the address is dropped and the URL is rewritten rather than
    // half-applied (§2.3).
    expect(parseParams(instancesView.params, new URLSearchParams("q=ops&status=connected"))).toEqual({});
  });
});
