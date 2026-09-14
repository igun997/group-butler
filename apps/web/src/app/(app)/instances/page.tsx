import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import { SmartPhone01Icon } from "@hugeicons/core-free-icons";
import { ButtonLink } from "@/components/shell/button-link";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { InstanceStatusBadge } from "@/components/shell/status-badge";
import { requireOwner } from "@/server/auth/require";
import { loadHealth, loadInstances } from "@/server/console";
import { formatStamp } from "@/lib/instances";

export const metadata: Metadata = { title: "Instances" };

function FailureNotice({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
      {children}
    </div>
  );
}

export default async function InstancesPage() {
  const owner = await requireOwner();
  const [instances, health] = await Promise.all([loadInstances(owner.organizationId), loadHealth()]);

  // A stored status is only as fresh as the worker was. Say so rather than
  // presenting an idle row as current (antislop R-38).
  const workerDown = health.ok && !health.data.worker.ok;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <header className="flex flex-col gap-3">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Instances</h1>
        <p className="max-w-[65ch] text-sm text-muted-foreground">
          Each instance is one linked WhatsApp account.
        </p>
        <div>
          <ButtonLink href="/instances/new" className="max-md:h-11">
            Link an account
          </ButtonLink>
        </div>
      </header>

      {workerDown ? (
        <p className="rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
          The worker is not answering, so the statuses below are the last ones it stored and may be
          stale.
        </p>
      ) : null}

      {!instances.ok ? (
        <FailureNotice>{instances.error}</FailureNotice>
      ) : instances.data.length === 0 ? (
        <Empty className="border border-dashed border-border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={SmartPhone01Icon} strokeWidth={2} />
            </EmptyMedia>
            <EmptyTitle>No instance is linked yet</EmptyTitle>
            <EmptyDescription>
              An instance appears here once a WhatsApp account is linked and the worker pairs it.
            </EmptyDescription>
            <EmptyContent>
              <ButtonLink href="/instances/new" variant="outline" className="max-md:h-11">
                Link an account
              </ButtonLink>
            </EmptyContent>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="flex flex-col gap-2">
          {instances.data.map((instance) => (
            <li key={instance.id}>
              <Item variant="outline" render={<Link href={`/instances/${instance.id}`} />}>
                <ItemContent>
                  <ItemTitle>{instance.label}</ItemTitle>
                  <ItemDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-mono">{instance.id}</span>
                    <span aria-hidden>·</span>
                    <span>
                      {instance.groupSync.groupsObserved} groups observed
                      {instance.groupSync.groupsLeft > 0 ? `, ${instance.groupSync.groupsLeft} left` : ""}
                    </span>
                    <span aria-hidden>·</span>
                    <span>last sync {formatStamp(instance.groupSync.lastSyncAt)}</span>
                  </ItemDescription>
                  {instance.groupSync.lastError ? (
                    <p className="text-xs text-destructive">Last sync error: {instance.groupSync.lastError}</p>
                  ) : null}
                </ItemContent>
                <ItemActions>
                  <InstanceStatusBadge status={instance.status} />
                </ItemActions>
              </Item>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
