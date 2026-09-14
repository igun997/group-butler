import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon, SmartPhone01Icon } from "@hugeicons/core-free-icons";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { DependencyBadge, InstanceStatusBadge } from "@/components/shell/status-badge";
import { requireOwner } from "@/server/auth/require";
import { attentionNeeded, loadHealth, loadInstances, statusCounts } from "@/server/console";
import { formatStamp } from "@/lib/instances";

export const metadata: Metadata = { title: "Overview" };

function FailureNotice({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
      {children}
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="font-heading text-lg font-medium tracking-tight">{children}</h2>;
}

export default async function OverviewPage() {
  const owner = await requireOwner();
  const [health, instances] = await Promise.all([loadHealth(), loadInstances(owner.organizationId)]);

  const rows = instances.ok ? instances.data : [];
  const counts = statusCounts(rows);
  const attention = attentionNeeded(rows);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="max-w-[65ch] text-sm text-muted-foreground">
          The two dependencies this console needs, and every WhatsApp account it is capturing from.
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <SectionTitle>Dependencies</SectionTitle>
        {health.ok ? (
          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
            <li className="flex items-center justify-between gap-4 px-4 py-3">
              <div>
                <p className="text-sm font-medium">MongoDB</p>
                <p className="text-xs text-muted-foreground">Messages, groups, sends and the audit log</p>
              </div>
              <DependencyBadge ok={health.data.mongo === "ok"} okLabel="Reachable" failedLabel="Unreachable" />
            </li>
            <li className="flex items-center justify-between gap-4 px-4 py-3">
              <div>
                <p className="text-sm font-medium">WhatsApp worker</p>
                <p className="text-xs text-muted-foreground">
                  {health.data.worker.reachable && health.data.worker.ok
                    ? "Live session control and group reads"
                    : health.data.worker.error ?? "The control plane did not answer its probe"}
                </p>
              </div>
              <DependencyBadge ok={health.data.worker.ok} okLabel="Reachable" failedLabel="Unreachable" />
            </li>
          </ul>
        ) : (
          <FailureNotice>{health.error}</FailureNotice>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <SectionTitle>Instances</SectionTitle>
        {!instances.ok ? (
          <FailureNotice>{instances.error}</FailureNotice>
        ) : rows.length === 0 ? (
          <Empty className="border border-dashed border-border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HugeiconsIcon icon={SmartPhone01Icon} strokeWidth={2} />
              </EmptyMedia>
              <EmptyTitle>No instance is linked yet</EmptyTitle>
              <EmptyDescription>
                An instance appears here once a WhatsApp account is created and paired through the
                worker&apos;s control API. Nothing in this shell creates one.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {counts.connected} capturing, {counts.inactive} not capturing.
            </p>
            {attention.length === 0 ? (
              <p className="rounded-xl border border-border px-4 py-3 text-sm">
                Every linked account is connected.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {attention.map((instance) => (
                  <li key={instance.id}>
                    <Item variant="outline">
                      <ItemContent>
                        <ItemTitle>{instance.label}</ItemTitle>
                        <ItemDescription>
                          <span className="font-mono">{instance.id}</span> · last group sync{" "}
                          {formatStamp(instance.groupSync.lastSyncAt)}
                        </ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        <InstanceStatusBadge status={instance.status} />
                      </ItemActions>
                    </Item>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-sm">
              <Link href="/instances" className="underline underline-offset-4 hover:text-foreground">
                Open the instance list
              </Link>
            </p>
          </>
        )}
      </section>

      {health.ok && !health.data.ok ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="size-4" />
          One dependency is down: capture and sends stop until it answers.
        </p>
      ) : null}
    </div>
  );
}
