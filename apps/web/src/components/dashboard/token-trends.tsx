import { FailureNotice } from "@/components/shell/failure-notice";
import { TokenTrendChart } from "./token-trend-chart";
import { formatCount } from "@/lib/format";
import type { Dashboard, TokenSeries } from "@/lib/dashboard";

/**
 * What the assistant spent, per bot, over the week. One compact line chart each,
 * all on the same scale so the bots can be read against each other, and a bot with
 * no calls says so rather than being charted flat at zero.
 */
export function TokenTrends({ tokens, tokenMax, tokensError }: Pick<Dashboard, "tokens" | "tokenMax" | "tokensError">) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="font-heading text-lg font-medium tracking-tight">Assistant tokens, last seven days</h2>
        <p className="max-w-[65ch] text-sm text-muted-foreground">
          Input, output and total tokens per UTC day. Every chart shares one scale, so the bots compare.
        </p>
      </div>

      {tokensError ? (
        <FailureNotice>{tokensError}</FailureNotice>
      ) : tokens === null || tokens.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Token history appears once a bot runs an assistant call.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {tokens.map((series) => (
            <TokenCard key={series.instanceId} series={series} max={tokenMax ?? 0} />
          ))}
        </div>
      )}
    </section>
  );
}

function TokenCard({ series, max }: { series: TokenSeries; max: number }) {
  const name = series.label || series.instanceId;
  const reported = series.reportedDays > 0;

  return (
    <article className="flex flex-col gap-3 rounded-xl border border-border p-4">
      <header className="flex flex-col gap-0.5">
        <h3 className="text-sm font-medium break-words">{name}</h3>
        {/* Always the full id, whatever the name does to the axis labels. */}
        <p className="font-mono text-xs break-all text-muted-foreground">{series.instanceId}</p>
      </header>

      {series.calls === 0 ? (
        <p className="text-sm text-muted-foreground">No assistant call in the last seven days.</p>
      ) : reported ? (
        <TokenTrendChart series={series} max={max} />
      ) : (
        <p className="text-sm text-muted-foreground">
          Calls ran, but the provider reported no token usage, so there is nothing to plot.
        </p>
      )}

      {series.calls > 0 ? (
        <p className="text-xs text-muted-foreground">
          {series.calls === 1 ? "1 call" : `${formatCount(series.calls)} calls`}, usage reported on{" "}
          {series.reportedDays} of {series.days.length} days.
        </p>
      ) : null}
    </article>
  );
}
