"use client";

import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Logout01Icon, UserCircleIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { ThemeToggle } from "@/components/theme/theme-toggle";

/**
 * The console's top bar: the rail control on touch layouts, the theme control,
 * and the account menu. It carries no page title on purpose: the page's own `h1`
 * already says where you are, and repeating it is noise.
 */
export function AppTopbar({ email, organizationId }: { email: string; organizationId: string }) {
  const [signingOut, setSigningOut] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function signOut() {
    setSigningOut(true);
    setFailure(null);
    let response: Response | null = null;
    try {
      response = await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      response = null;
    }
    if (!response?.ok) {
      // The cookie is only cleared when the attempt is recorded, so leaving the
      // console here would be a lie: say what happened and stay put.
      setFailure("Sign-out failed: the attempt could not be recorded. Try again.");
      setSigningOut(false);
      return;
    }
    // Same reason as sign-in: the cookie changed, so load the public shell fresh.
    window.location.assign("/login");
  }

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
      <SidebarTrigger className="max-md:size-11" />
      {/* The separator variant sets `data-vertical:self-stretch`, which beats the
          header's `items-center`; with an explicit height that pins the stub to
          the top edge. The `!` is required: both rules set `align-self`, and the
          data-attribute variant wins on order without it. */}
      <Separator orientation="vertical" className="me-1 h-4 self-center!" />
      <div className="ms-auto flex items-center gap-2">
        {failure ? (
          <p role="alert" className="max-w-64 text-xs text-destructive">
            {failure}
          </p>
        ) : null}
        <ThemeToggle className="max-md:size-11" />
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon" className="max-md:size-11" aria-label="Account menu" />}
          >
            <HugeiconsIcon icon={UserCircleIcon} strokeWidth={2} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            {/* Base UI's GroupLabel requires a Menu.Group parent: without this
                wrapper it throws "MenuGroupContext is missing" when the popup
                renders. Radix allowed a bare label; this library does not. */}
            <DropdownMenuGroup>
              <DropdownMenuLabel className="flex flex-col gap-0.5">
                <span className="truncate text-sm font-medium">{email}</span>
                <span className="truncate font-mono text-xs text-muted-foreground">{organizationId}</span>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              className="max-md:min-h-11"
              disabled={signingOut}
              onClick={signOut}
            >
              <HugeiconsIcon icon={Logout01Icon} strokeWidth={2} />
              {signingOut ? "Signing out" : "Sign out"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
