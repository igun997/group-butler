"use client";

import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { formatCount } from "@/lib/format";
import type { TokenSeries } from "@/lib/dashboard";

const CONFIG = {
  inputTokens: { label: "Input", color: "var(--chart-1)" },
  outputTokens: { label: "Output", color: "var(--chart-2)" },
  totalTokens: { label: "Total", color: "var(--chart-3)" },
} satisfies ChartConfig;

/** The one phrase a missing figure is allowed to read as (§10). */
const NOT_REPORTED = "not reported";

type Figure = unknown;

function shortDay(day: string): string {
  return day.slice(5);
}

/** The day row a tooltip is showing, read defensively: recharts hands the payload over untyped. */
function callCountOf(payload: unknown): number {
  if (!Array.isArray(payload)) return 0;
  const entry: unknown = payload[0];
  if (typeof entry !== "object" || entry === null || !("payload" in entry)) return 0;
  const row: unknown = entry.payload;
  if (typeof row !== "object" || row === null || !("calls" in row)) return 0;
  const calls: unknown = row.calls;
  return typeof calls === "number" ? calls : 0;
}

/**
 * The tooltip title: which UTC day, and whether the flat line over it is a quiet
 * day or a provider that said nothing. A gap must never be read as zero.
 */
function dayLabel(label: unknown, payload: unknown): string {
  const day = typeof label === "string" ? label : "";
  const calls = callCountOf(payload);
  if (calls === 0) return `${day} · no call`;
  return `${day} · ${calls === 1 ? "1 call" : `${formatCount(calls)} calls`}`;
}

function tokenFigure(value: Figure): string {
  return typeof value === "number" ? formatCount(value) : NOT_REPORTED;
}

/**
 * One bot's assistant tokens over the window: input, output and total by UTC day.
 *
 * Nulls stay null, so a day nobody reported is a break in the line rather than a
 * run along zero. Every chart is given the same `max`, so two bots can be read
 * against each other instead of each being silently rescaled to its own peak.
 *
 * The plot is one image with a short name; the seven days are also a real table in
 * the same figure, so the numbers are not locked behind a hover.
 */
export function TokenTrendChart({ series, max }: { series: TokenSeries; max: number }) {
  const name = series.label || series.instanceId;
  const data = series.days.map((day) => ({
    day: day.day,
    calls: day.calls,
    inputTokens: day.inputTokens,
    outputTokens: day.outputTokens,
    totalTokens: day.totalTokens,
  }));

  return (
    <figure className="flex flex-col gap-1">
      <ChartContainer
        config={CONFIG}
        className="aspect-auto h-40 w-full"
        role="img"
        aria-label={`Assistant tokens for ${name}, last seven days`}
      >
        <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} tickFormatter={shortDay} />
          <YAxis hide domain={[0, max > 0 ? max : 1]} allowDecimals={false} />
          <ChartTooltip content={<ChartTooltipContent labelFormatter={dayLabel} formatter={tokenFigure} />} />
          <ChartLegend content={<ChartLegendContent />} />
          <Line dataKey="inputTokens" type="monotone" stroke="var(--color-inputTokens)" strokeWidth={2} dot={false} connectNulls={false} />
          <Line dataKey="outputTokens" type="monotone" stroke="var(--color-outputTokens)" strokeWidth={2} dot={false} connectNulls={false} />
          <Line dataKey="totalTokens" type="monotone" stroke="var(--color-totalTokens)" strokeWidth={2} dot={false} connectNulls={false} />
        </LineChart>
      </ChartContainer>

      <table className="sr-only">
        <caption>
          {name} ({series.instanceId}) assistant tokens by UTC day
        </caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Calls</th>
            <th scope="col">Input</th>
            <th scope="col">Output</th>
            <th scope="col">Total</th>
          </tr>
        </thead>
        <tbody>
          {series.days.map((day) => (
            <tr key={day.day}>
              <th scope="row">{day.day}</th>
              <td>{formatCount(day.calls)}</td>
              <td>{day.inputTokens === null ? NOT_REPORTED : formatCount(day.inputTokens)}</td>
              <td>{day.outputTokens === null ? NOT_REPORTED : formatCount(day.outputTokens)}</td>
              <td>{day.totalTokens === null ? NOT_REPORTED : formatCount(day.totalTokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
