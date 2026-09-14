"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { NAV_ITEMS, isActivePath } from "./nav";

/**
 * The console's rail. Written in the source rather than patched in, and it only
 * ever links to the routes in `nav.ts` (antislop R-33, R-24).
 *
 * Tooltips are passed only while the rail is collapsed on a pointer device: they
 * exist to label an icon-only button. On the mobile sheet the label is already
 * visible, and a tooltip there would mount a trigger that swallows the first
 * Escape, so the sheet would need two presses to close.
 */
export function AppSidebar() {
  const pathname = usePathname();
  const { state, isMobile } = useSidebar();
  const labelFor = (label: string) => (!isMobile && state === "collapsed" ? label : undefined);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              tooltip={labelFor("Group Butler")}
              className="max-md:min-h-12"
              render={<Link href="/" />}
            >
              <span
                aria-hidden
                className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-xs leading-none text-primary-foreground"
              >
                GB
              </span>
              <span className="grid gap-1 text-left">
                <span className="text-sm leading-none">Group Butler</span>
                <span className="text-xs text-muted-foreground">Capture console</span>
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Console</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    isActive={isActivePath(pathname, item.href)}
                    tooltip={labelFor(item.label)}
                    className="max-md:min-h-11"
                    render={<Link href={item.href} />}
                  >
                    <HugeiconsIcon icon={item.icon} strokeWidth={2} />
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
