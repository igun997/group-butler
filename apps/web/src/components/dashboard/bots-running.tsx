import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import { SmartPhone01Icon } from "@hugeicons/core-free-icons";
import { FailureNotice } from "@/components/shell/failure-notice";
import { InstanceStatusBadge, StateBadge } from "@/components/shell/status-badge";
import { ButtonLink } from "@/components/shell/button-link";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import type { Dashboard } from "@/lib/dashboard";

/**
 * Whether capture is running. The count is the headline because it answers the
 * operator's first question; the bots that are not capturing are named under it,
 * because a count alone does not say which account to look at.
 */
export function BotsRunning({ bots, stalled, botsError }: Pick<Dashboard, "bots" | "stalled" | "botsError">) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="font-heading text-lg font-medium tracking-tight">Bots running</h2>
        <p className="max-w-[65ch] text-sm text-muted-foreground">
          How many linked accounts the worker is capturing from right now.
        </p>
      </div>

      {botsError ? (
        <FailureNotice>{botsError}</FailureNotice>
      ) : bots === null || stalled === null ? null : bots.total === 0 ? (
        <Empty className="border border-dashed border-border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={SmartPhone01Icon} strokeWidth={2} />
            </EmptyMedia>
            <EmptyTitle>No bot is linked yet</EmptyTitle>
            <EmptyDescription>
              A bot appears here once a WhatsApp account is created and paired through the worker.
            </EmptyDescription>
            <EmptyContent>
              <ButtonLink href="/instances/new" variant="outline" className="max-md:h-11">
                Link an account
              </ButtonLink>
            </EmptyContent>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="font-heading text-4xl leading-none font-semibold tabular-nums">{bots.capturing}</p>
            <p className="text-sm text-muted-foreground">of {bots.total} linked accounts are capturing</p>
            <StateBadge state={bots.capturing === bots.total ? "ok" : bots.capturing === 0 ? "failed" : "waiting"}>
              {bots.capturing === bots.total
                ? "All capturing"
                : bots.capturing === 0
                  ? "None capturing"
                  : `${bots.total - bots.capturing} not capturing`}
            </StateBadge>
          </div>

          {stalled.length === 0 ? (
            <p className="text-sm text-muted-foreground">Every linked account is capturing.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {stalled.map((instance) => (
                <li key={instance.id}>
                  <Item variant="outline" render={<Link href={`/instances/${instance.id}`} />}>
                    <ItemContent>
                      <ItemTitle>{instance.label || instance.id}</ItemTitle>
                      <ItemDescription className="font-mono text-xs break-all">{instance.id}</ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <InstanceStatusBadge status={instance.status} />
                    </ItemActions>
                  </Item>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
