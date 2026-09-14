import type { Metadata } from "next";
import { SchedulerSection } from "@/components/operations/scheduler-section";
import { UsageSection } from "@/components/operations/usage-section";
import { requireOwner } from "@/server/auth/require";
import { loadScheduler, loadUsage } from "@/server/console";

export const metadata: Metadata = { title: "Operations" };

/**
 * What the worker is doing on a timer, and what this organisation has used today.
 *
 * The two reads are independent and each returns its failure as a value, so the
 * worker being down still leaves the usage numbers on screen, and vice versa.
 *
 * This page is the only place the console loaders meet the sections: they hand
 * back the read models the sections are typed against (`@/lib/operations`), so a
 * shape change lands here and nowhere else.
 */
export default async function OperationsPage() {
  const owner = await requireOwner();
  const [scheduler, usage] = await Promise.all([loadScheduler(), loadUsage(owner.organizationId)]);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Operations</h1>
        <p className="max-w-[65ch] text-sm text-muted-foreground">
          What the worker is doing on a timer, and what this organisation has used today.
        </p>
      </header>

      <SchedulerSection result={scheduler} />
      <UsageSection result={usage} />
    </div>
  );
}
