import { HugeiconsIcon } from "@hugeicons/react";
import { Timer01Icon } from "@hugeicons/core-free-icons";
import { FailureNotice } from "@/components/shell/failure-notice";
import { StateBadge } from "@/components/shell/status-badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { formatStamp } from "@/lib/instances";
import { formatInterval, loopOutcome, type Loaded, type LoopReport } from "@/lib/operations";

/**
 * The worker's scheduled loops: what runs on a timer, how often, and what the
 * last pass did.
 *
 * The read is a value, not an exception, so a worker that is down leaves the
 * usage section below this one rendering normally.
 */
export function SchedulerSection({ result }: { result: Loaded<LoopReport[]> }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="font-heading text-lg font-medium tracking-tight">Scheduled loops</h2>
        <p className="max-w-[65ch] text-sm text-muted-foreground">
          What the worker runs on a timer, and what each loop&apos;s last pass did. Times are UTC.
        </p>
      </div>
      {!result.ok ? (
        <FailureNotice>{result.error}</FailureNotice>
      ) : result.data.length === 0 ? (
        <Empty className="border border-dashed border-border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={Timer01Icon} strokeWidth={2} />
            </EmptyMedia>
            <EmptyTitle>The worker reports no scheduled loop</EmptyTitle>
            <EmptyDescription>
              A loop appears here once the worker starts it and records a pass.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="flex flex-col gap-2">
          {result.data.map((loop) => (
            <li key={loop.name}>
              <LoopRow loop={loop} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function LoopRow({ loop }: { loop: LoopReport }) {
  const outcome = loopOutcome(loop);

  return (
    <Item variant="outline">
      <ItemContent>
        <ItemTitle className="font-mono">{loop.name}</ItemTitle>
        <ItemDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>interval {formatInterval(loop.intervalMs)}</span>
          <span aria-hidden>·</span>
          <span>last run {formatStamp(loop.lastRunAt)}</span>
          <span aria-hidden>·</span>
          <span>
            <span className="font-mono tabular-nums">{loop.runs}</span>{" "}
            {loop.runs === 1 ? "run" : "runs"} since start
          </span>
        </ItemDescription>
        {loop.lastError ? (
          <p className="text-xs break-words text-destructive">Last pass failed: {loop.lastError}</p>
        ) : null}
      </ItemContent>
      <ItemActions>
        <StateBadge state={outcome.state}>{outcome.label}</StateBadge>
      </ItemActions>
    </Item>
  );
}
