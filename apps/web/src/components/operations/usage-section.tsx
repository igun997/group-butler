import { HugeiconsIcon } from "@hugeicons/react";
import { Analytics01Icon, SmartPhone01Icon } from "@hugeicons/core-free-icons";
import { FailureNotice } from "@/components/shell/failure-notice";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Item, ItemDescription, ItemHeader, ItemTitle } from "@/components/ui/item";
import { cn } from "@/lib/utils";
import { formatCount } from "@/lib/format";
import { aiTotals, type Loaded, type UsageDay, type UsageInstance } from "@/lib/operations";

/**
 * What this organisation has used today, per instance, for the current UTC day.
 *
 * The read is a value, not an exception, so Mongo being down leaves the loop
 * section above this one rendering normally.
 */
export function UsageSection({ result }: { result: Loaded<UsageDay> }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="font-heading text-lg font-medium tracking-tight">Today&apos;s usage</h2>
        <p className="max-w-[65ch] text-sm text-muted-foreground">
          Messages, media, sends and AI tokens the worker has recorded for the current UTC day, per
          instance.
        </p>
      </div>
      {!result.ok ? <FailureNotice>{result.error}</FailureNotice> : <UsageBody usage={result.data} />}
    </section>
  );
}

function UsageBody({ usage }: { usage: UsageDay }) {
  // Two different causes for an empty section, so they are said separately: no
  // instance exists to count against, or instances exist and the day is still
  // blank. Neither is a row of zeros pretending work happened.
  if (usage.instances.length === 0) {
    return (
      <Empty className="border border-dashed border-border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HugeiconsIcon icon={SmartPhone01Icon} strokeWidth={2} />
          </EmptyMedia>
          <EmptyTitle>No instance is linked yet</EmptyTitle>
          <EmptyDescription>
            Usage is counted per instance, so nothing appears here until a WhatsApp account is
            linked and paired.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  if (!usage.recorded) {
    return (
      <Empty className="border border-dashed border-border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HugeiconsIcon icon={Analytics01Icon} strokeWidth={2} />
          </EmptyMedia>
          <EmptyTitle>Nothing has been recorded for {usage.day} (UTC)</EmptyTitle>
          <EmptyDescription>
            A counter moves when the worker stores a message, stores media, dispatches a send, records
            a receipt or runs an assistant call.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        UTC day <span className="font-mono">{usage.day}</span>
      </p>
      <ul className="flex flex-col gap-2">
        {usage.instances.map((instance) => (
          <li key={instance.instanceId}>
            <UsageRow instance={instance} maxTokensPerDay={usage.maxTokensPerDay} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function UsageRow({ instance, maxTokensPerDay }: { instance: UsageInstance; maxTokensPerDay: number | null }) {
  const totals = aiTotals(instance.tokens, maxTokensPerDay);

  return (
    <Item variant="outline" className="flex-col items-stretch gap-3">
      <ItemHeader>
        <div className="flex min-w-0 flex-col gap-0.5">
          {/* The label is what the operator names the account; when the document
              has none, the id is the only true thing to show. */}
          <ItemTitle>{instance.label || instance.instanceId}</ItemTitle>
          {instance.label ? (
            <ItemDescription className="font-mono text-xs break-all">{instance.instanceId}</ItemDescription>
          ) : null}
        </div>
      </ItemHeader>

      {instance.recorded ? (
        <div className="flex flex-col gap-2">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
            <Cell label="Messages in" value={instance.counters.messagesIn} />
            <Cell label="Media stored" value={instance.counters.mediaStored} />
            <Cell label="Media unparsed" value={instance.counters.mediaUnparsed} />
            <Cell label="Sends ok" value={instance.counters.sendsOk} />
            <Cell label="Sends failed" value={instance.counters.sendsFailed} />
            <Cell label="Receipts" value={instance.counters.receipts} />
            {totals.kind === "reported" ? (
              <>
                <Cell label="AI tokens in" value={totals.input} />
                <Cell label="AI tokens out" value={totals.output} />
                <Cell label="AI tokens total" value={totals.total} />
              </>
            ) : totals.kind === "unreported" ? (
              <Cell label="AI tokens" value={null} />
            ) : null}
          </dl>
          {totals.kind === "no-calls" ? (
            <p className="text-xs text-muted-foreground">
              No assistant call has been made today, so no tokens were spent.
            </p>
          ) : totals.kind === "unreported" ? (
            <p className="text-xs text-muted-foreground">
              The provider reported no token usage for today&apos;s calls.
            </p>
          ) : (
            <p className={cn("text-xs", totals.over ? "text-warning" : "text-muted-foreground")}>{totals.note}</p>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Nothing recorded today yet. Counters move as the worker stores messages, media and sends.
        </p>
      )}
    </Item>
  );
}

/** One counter. A `null` is a provider that reported nothing, not a zero. */
function Cell({ label, value }: { label: string; value: number | null }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("text-sm tabular-nums", value === null ? "text-muted-foreground" : "font-mono")}>
        {value === null ? "not reported" : formatCount(value)}
      </dd>
    </div>
  );
}
