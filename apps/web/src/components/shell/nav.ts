import { DashboardSquare01Icon, SmartPhone01Icon } from "@hugeicons/core-free-icons";

export type NavItem = {
  href: string;
  label: string;
  /** Chosen for what it depicts, not for the library's look (DESIGN.md). */
  icon: typeof DashboardSquare01Icon;
};

/**
 * The console's destinations, and the only ones the sidebar links to. A route is
 * added here when it exists, so navigation never promises a page that is not
 * built (antislop R-24).
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/", label: "Overview", icon: DashboardSquare01Icon },
  { href: "/instances", label: "Instances", icon: SmartPhone01Icon },
];

/** `/` is active only on itself; every other item owns its whole subtree. */
export function isActivePath(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}
