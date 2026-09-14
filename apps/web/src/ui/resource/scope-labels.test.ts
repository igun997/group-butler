import { describe, expect, test, vi } from "vitest";
import type { Scope } from "../registry";
import { createScopeLabelStore, fallbackScopeLabel } from "./scope-labels";

/**
 * R-V4 and R-M2: the scope's name is learned from reads and live patches, and
 * the store never invents one. There is no renderer here — the store is policy,
 * so this stays on the node environment.
 */

const OPS: Scope = { kind: "instance", instanceId: "inst_1" };
const OTHER: Scope = { kind: "instance", instanceId: "inst_2" };
const GROUP: Scope = { kind: "group", instanceId: "inst_1", groupJid: "120363@g.us" };

describe("the scope label store (R-V4, R-M2)", () => {
  test("an untaught scope has no label, so the caller's fallback stands", () => {
    const store = createScopeLabelStore();

    expect(store.read(OPS)).toBeUndefined();
    expect(store.read({ kind: "global" })).toBeUndefined();
  });

  test("a learned label is per scope and never leaks across scopes", () => {
    const store = createScopeLabelStore();
    store.write(OPS, "Ops Team");
    store.write(GROUP, "120363@g.us");

    expect(store.read(OPS)).toBe("Ops Team");
    expect(store.read(OTHER)).toBeUndefined();
    // The same JID under another instance is another scope.
    expect(store.read({ kind: "group", instanceId: "inst_2", groupJid: "120363@g.us" })).toBeUndefined();
  });

  test("a rename replaces the label in place and notifies the shell once", () => {
    const store = createScopeLabelStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.write(GROUP, "Ops Team");
    expect(listener).toHaveBeenCalledTimes(1);

    store.write(GROUP, "Ops Team 2");
    expect(store.read(GROUP)).toBe("Ops Team 2");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  test("a repeated or blank label changes nothing and notifies nobody", () => {
    const store = createScopeLabelStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.write(OPS, "Ops Team");
    listener.mockClear();

    store.write(OPS, "Ops Team");
    store.write(OTHER, "   ");
    expect(listener).not.toHaveBeenCalled();
    expect(store.read(OTHER)).toBeUndefined();
  });

  test("unsubscribing stops the notification", () => {
    const store = createScopeLabelStore();
    const listener = vi.fn();
    store.subscribe(listener)();
    store.write(OPS, "Ops Team");

    expect(listener).not.toHaveBeenCalled();
  });

  test("the fallback is the address said in words, never an empty string", () => {
    expect(fallbackScopeLabel({ kind: "global" })).toBe("All instances");
    expect(fallbackScopeLabel(OPS)).toBe("inst_1");
    expect(fallbackScopeLabel(GROUP)).toBe("120363@g.us");
  });
});
