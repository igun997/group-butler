import type { ReactNode } from "react";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/shell/app-sidebar";
import { AppTopbar } from "@/components/shell/app-topbar";
import { requireOwner } from "@/server/auth/require";

/**
 * The private shell. The edge middleware has already rejected requests with no
 * cookie; this is the check that costs a signature verification, so a forged or
 * expired cookie cannot render a console page.
 */
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const owner = await requireOwner();

  return (
    <SidebarProvider>
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:absolute focus:start-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>
      <AppSidebar />
      <SidebarInset>
        <AppTopbar email={owner.email} organizationId={owner.organizationId} />
        <main id="content" tabIndex={-1} className="flex-1 p-4 md:p-6">
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
