import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { LoginForm } from "@/components/auth/login-form";
import { safeNextPath } from "@/server/auth/next-path";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, readSession } from "@/server/auth/session";

export const metadata: Metadata = { title: "Sign in" };

const SESSION_DAYS = SESSION_TTL_SECONDS / 86_400;

/**
 * The public shell: one panel, one job. There is no signup, no OAuth and no
 * password reset to offer, because the owner account is one server-side
 * credential, so the panel carries only what exists.
 */
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNextPath((await searchParams).next);
  const cookieStore = await cookies();
  if (readSession(cookieStore.get(SESSION_COOKIE)?.value)) redirect(next);

  return (
    <main className="flex min-h-svh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="font-heading text-base leading-none">Group Butler</p>
                <p className="mt-1.5 text-xs text-muted-foreground">WhatsApp group capture console</p>
              </div>
              <ThemeToggle className="-me-2 -mt-2 max-md:size-11" />
            </div>
            <h1 className="mt-5 font-heading text-2xl font-semibold tracking-tight">Sign in</h1>
            <CardDescription>
              The owner account is configured on the server. Nothing to register, nothing to confirm.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LoginForm next={next} />
          </CardContent>
        </Card>
        <p className="mt-4 text-center text-xs text-muted-foreground">
          Internal tool. A session lasts {SESSION_DAYS} days.
        </p>
      </div>
    </main>
  );
}
