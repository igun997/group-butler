import { describe, expect, test } from "vitest";
import { canonicalPath, parseParams, resolveView, views, viewsFor } from "../../index";
import { GROUPS_INSTANCE } from "../groups/model";
import { INSTANCE_CONFIG, INSTANCE_SNAPSHOT } from "./model";
import { instanceView } from "./index";

/**
 * The instance view's registration (docs/ui-decision.md §2.2 invariant 5, §2.3,
 * §2.5; P6's "one resource descriptor set, one view descriptor, one
 * registerView() call").
 *
 * The point of these cases is that P6 completed the address P2 declared rather
 * than restating it, and that the page's three panels are three declared reads:
 * the session, the configuration, and this instance's groups. The groups panel is
 * the groups view composed at this scope, which is why its read is the same
 * descriptor id here as there.
 */

describe("the instance view is registered (§2.5)", () => {
  test("it completes the registry's declaration instead of adding a second view", () => {
    const declared = views().filter((view) => view.id === "instance");

    expect(declared).toHaveLength(1);
    expect(declared[0]).toBe(instanceView);
    expect(instanceView.routes).toEqual(["/instances/:instanceId"]);
    expect(instanceView.scopeMode).toBe("instance");
  });

  test("its address resolves to it at an instance scope, and it is offered there", () => {
    expect(resolveView("/instances/inst_1", new URLSearchParams())).toMatchObject({
      id: "instance",
      scope: { kind: "instance", instanceId: "inst_1" },
      canonical: "/instances/inst_1",
    });
    expect(viewsFor("instance").map((view) => view.id)).toContain("instance");
    expect(canonicalPath(instanceView, { kind: "global" })).toBeNull();
  });

  test("it declares three panels, each naming the reads it projects", () => {
    expect(instanceView.panels?.map((panel) => panel.id)).toEqual([
      "instance-session",
      "instance-config",
      "instance-groups",
    ]);
    expect(instanceView.panels?.map((panel) => panel.resources.map((resource) => resource.id))).toEqual([
      [INSTANCE_SNAPSHOT],
      [INSTANCE_CONFIG, GROUPS_INSTANCE],
      [GROUPS_INSTANCE],
    ]);
  });

  test("every panel reserves its own first-paint geometry (R-L4)", () => {
    expect(instanceView.skeleton?.blocks).toEqual([
      { shape: "header", count: 1 },
      { shape: "cards", count: 2 },
      { shape: "table", count: 8 },
    ]);
    for (const panel of instanceView.panels ?? []) {
      expect(panel.minHeight).toBeGreaterThan(0);
    }
  });

  test("it declares its two operations, and the destructive one asks first (R-A8)", () => {
    const actions = instanceView.actions ?? [];

    expect(actions.map((action) => action.id)).toEqual(["request-pairing-code", "delete-instance"]);
    expect(actions[0]?.confirm).toBeUndefined();
    expect(actions[1]?.confirm).toMatchObject({ confirmLabel: "Log out and delete" });
    // R-A8: the plan names the target and states the consequence.
    expect(actions[1]?.confirm?.title).toMatch(/instance/i);
    expect(actions[1]?.confirm?.body).toMatch(/logged out/i);
  });

  test("every empty reason has copy of its own (R-E1, R-E2)", () => {
    const empty = instanceView.empty!;
    const titles = Object.values(empty).map((copy) => copy.title);
    const bodies = Object.values(empty).map((copy) => copy.body);

    expect(Object.keys(empty)).toHaveLength(5);
    expect(new Set(titles).size).toBe(5);
    expect(new Set(bodies).size).toBe(5);
    // §7.2's prerequisite is the one this page produces.
    expect(empty.unconfigured.body).toMatch(/whitelist/);
  });

  test("it declares no param its reads cannot honour", () => {
    expect(parseParams(instanceView.params, new URLSearchParams("tab=groups&q=ops"))).toEqual({});
  });
});
