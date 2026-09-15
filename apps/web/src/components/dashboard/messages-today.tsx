import { HugeiconsIcon } from "@hugeicons/react";
import { Analytics01Icon } from "@hugeicons/core-free-icons";
import { FailureNotice } from "@/components/shell/failure-notice";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { BotMessagesChart } from "./bot-messages-chart";
import { formatCount } from "@/lib/format";
import type { Dashboard } from "@/lib/dashboard";

/**
 * The day's throughput: how many messages the worker stored, and which bot they
 * came from.
 *
 * A day with nothing stored renders no chart at all. Bars of zero length are a
 * blank plot with floating bot names, which reads as a rendering fault rather than
 * as a quiet day, so that case says what is missing and what will fill it.
 */
export function MessagesToday({
  day,
  messagesIn,
  activity,
  messagesError,
}: Pick<Dashboard, "day" | "messagesIn" | "activity" | "messagesError">) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="font-heading text-lg font-medium tracking-tight">Messages processed today</h2>
        <p className="max-w-[65ch] text-sm text-muted-foreground">
          Messages the worker stored from your groups{day ? ` for ${day}` : ""} (UTC).
        </p>
      </div>

      {messagesError ? (
        <FailureNotice>{messagesError}</FailureNotice>
      ) : messagesIn === null || day === null ? null : messagesIn === 0 ? (
        <Empty className="flex-none border border-dashed border-border p-6">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={Analytics01Icon} strokeWidth={2} />
            </EmptyMedia>
            <EmptyTitle>No message has been stored for {day} (UTC)</EmptyTitle>
            <EmptyDescription>
              The first message that arrives in a group one of your bots is in appears here, counted
              against that bot.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <p className="font-heading text-3xl leading-none font-semibold tabular-nums">{formatCount(messagesIn)}</p>
            <p className="text-sm text-muted-foreground">
              {messagesIn === 1 ? "message stored today" : "messages stored today"}
            </p>
          </div>
          <BotMessagesChart bots={activity} day={day} />
        </>
      )}
    </section>
  );
}
