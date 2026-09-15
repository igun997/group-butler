import type { Metadata } from "next";
import { BotsRunning } from "@/components/dashboard/bots-running";
import { DependencyStrip } from "@/components/dashboard/dependency-strip";
import { MessagesToday } from "@/components/dashboard/messages-today";
import { TokenTrends } from "@/components/dashboard/token-trends";
import { dashboardRead } from "@/lib/dashboard";
import { requireOwner } from "@/server/auth/require";
import { loadHealth, loadInstances, loadTokens, loadUsage } from "@/server/console";

export const metadata: Metadata = { title: "Overview" };

/**
 * The operator's first screen: is capture running, what came in today, and what
 * the assistant has spent this week.
 *
 * The four reads are independent and each returns its failure as a value, so one
 * dead dependency leaves the rest of the reading on screen, and `dashboardRead`
 * folds them into the one shape the sections render.
 */
export default async function OverviewPage() {
  const owner = await requireOwner();
  const [instances, usage, tokens, health] = await Promise.all([
    loadInstances(owner.organizationId),
    loadUsage(owner.organizationId),
    loadTokens(owner.organizationId),
    loadHealth(),
  ]);
  const dashboard = dashboardRead({ instances, usage, tokens, health });

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="max-w-[65ch] text-sm text-muted-foreground">
          Whether capture is running, and what your bots have stored and spent.
        </p>
      </header>
      <MessagesToday
        day={dashboard.day}
        messagesIn={dashboard.messagesIn}
        activity={dashboard.activity}
        messagesError={dashboard.messagesError}
      />
      <DependencyStrip workerOk={dashboard.workerOk} mongoOk={dashboard.mongoOk} healthError={dashboard.healthError} />
      <BotsRunning bots={dashboard.bots} stalled={dashboard.stalled} botsError={dashboard.botsError} />

      <TokenTrends tokens={dashboard.tokens} tokenMax={dashboard.tokenMax} tokensError={dashboard.tokensError} />
    </div>
  );
}
