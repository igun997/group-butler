// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { scopeLabels } from "../ui/resource";

const navigation = vi.hoisted(() => ({
  pathname: "/",
  search: "",
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.search),
  useRouter: () => ({ replace: navigation.replace }),
}));

import { WorkspaceShell } from "./workspace-shell";

/**
 * The shell's registry wiring (docs/ui-decision.md §2.2 invariant 1, §2.3, §4.6
 * R-A5, §4.7 R-M2).
 *
 * What is asserted is the address as the operator meets it: the workspace's own
 * title, the scope said in words, the navigation the catalog offers at this
 * scope — and the promise that a stale or over-specified address renders a
 * working default rather than a screen that disagrees with its URL.
 */

beforeEach(() => {
  navigation.pathname = "/";
  navigation.search = "";
  navigation.replace.mockClear();
  scopeLabels.clear();
});

afterEach(() => {
  cleanup();
  scopeLabels.clear();
});

describe("the shell resolves the address it is given (§2.3)", () => {
  test("the global groups address names the workspace, the scope, and both destinations", async () => {
    navigation.pathname = "/groups";
    render(<WorkspaceShell ownerEmail="owner@example.test">panel</WorkspaceShell>);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Groups");
    expect(screen.getByText("All instances")).toBeTruthy();

    const nav = within(screen.getAllByRole("navigation", { name: "Workspaces" })[0]!);
    expect(nav.getByRole("link", { name: /Overview/ }).getAttribute("href")).toBe("/");
    const current = nav.getByRole("link", { name: /Groups/ });
    expect(current.getAttribute("href")).toBe("/groups");
    expect(current.getAttribute("aria-current")).toBe("page");
    // Already canonical: nothing is rewritten.
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  test("an instance-scoped address keeps the instance in the navigation and in the scope line", () => {
    navigation.pathname = "/instances/inst_1/groups";
    render(<WorkspaceShell ownerEmail="owner@example.test">panel</WorkspaceShell>);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Groups");
    // Nothing has taught this tab the instance's name yet, so the address says it.
    expect(screen.getByText("inst_1")).toBeTruthy();
    const nav = within(screen.getAllByRole("navigation", { name: "Workspaces" })[0]!);
    expect(nav.getByRole("link", { name: /Groups/ }).getAttribute("href")).toBe("/instances/inst_1/groups");
  });

  test("a label a read or a rename taught the tab is what the scope line says (R-M2, R-V4)", () => {
    navigation.pathname = "/instances/inst_1/groups";
    render(<WorkspaceShell ownerEmail="owner@example.test">panel</WorkspaceShell>);
    expect(screen.getByText("inst_1")).toBeTruthy();

    scopeLabels.write({ kind: "instance", instanceId: "inst_1" }, "Ops Team bot");

    return waitFor(() => expect(screen.getByText("Ops Team bot")).toBeTruthy());
  });

  test("an address that is not canonical is rewritten to the one that is (§2.3)", async () => {
    navigation.pathname = "/groups";
    navigation.search = "instance=inst_1";

    render(<WorkspaceShell ownerEmail="owner@example.test">panel</WorkspaceShell>);

    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/instances/inst_1/groups"));
  });

  test("a parameter the view cannot honour is dropped from the address, not half-applied", async () => {
    navigation.pathname = "/groups";
    navigation.search = "q=ops";

    render(<WorkspaceShell ownerEmail="owner@example.test">panel</WorkspaceShell>);

    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/groups"));
  });

  test("an address no view answers renders the shell's own landing title rather than a blank heading", () => {
    navigation.pathname = "/nope";
    render(<WorkspaceShell ownerEmail="owner@example.test">panel</WorkspaceShell>);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Overview");
    expect(navigation.replace).not.toHaveBeenCalled();
  });
});
