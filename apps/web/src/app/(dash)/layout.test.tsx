import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { currentOwner, redirect } = vi.hoisted(() => ({
  currentOwner: vi.fn(),
  // Next's `redirect` throws so the render stops; the layout must rely on that.
  redirect: vi.fn((href: string) => {
    throw new Error(`NEXT_REDIRECT:${href}`);
  }),
}));

vi.mock("../../server/auth/owner", () => ({ currentOwner }));
vi.mock("next/navigation", () => ({
  redirect,
  // The shell resolves the address with these; the layout's own concern is the
  // session, so the address here is the one address this file cares about.
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: () => undefined }),
}));

import DashboardLayout from "./layout";

describe("the authenticated layout's session gate (draft §11.1, invariant 1)", () => {
  beforeEach(() => {
    currentOwner.mockReset();
    redirect.mockClear();
  });

  test("sends a browser without a session to the login page", async () => {
    currentOwner.mockResolvedValue(null);

    await expect(DashboardLayout({ children: <p>panel</p> })).rejects.toThrow("NEXT_REDIRECT:/login");
    expect(redirect).toHaveBeenCalledWith("/login");
  });

  test("renders the owner's workspace inside the one shell", async () => {
    currentOwner.mockResolvedValue({ email: "owner@example.test", organizationId: "org_default" });

    const html = renderToStaticMarkup(await DashboardLayout({ children: <p>panel</p> }));

    expect(redirect).not.toHaveBeenCalled();
    expect(html.match(/aria-label="Workspaces"/g)).toHaveLength(2);
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(html).toContain("owner@example.test");
    expect(html).toContain("<p>panel</p>");
  });
});
