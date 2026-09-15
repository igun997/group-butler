"use client";

import { Bar, BarChart, LabelList, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { formatCount } from "@/lib/format";
import type { BotDay } from "@/lib/dashboard";

const CONFIG = {
  messagesIn: { label: "Messages stored", color: "var(--chart-2)" },
} satisfies ChartConfig;

/** One row per bot, tight enough that a roster of eight still reads as one chart. */
const ROW_HEIGHT = 36;
/** A long roster scrolls the page rather than stretching the plot off the screen. */
const MAX_HEIGHT = 288;
/** The label column, wide enough for two words and narrow enough for a 390px screen. */
const LABEL_WIDTH = 128;
const LABEL_CHARS = 16;

/**
 * The y-axis tick. Recharts prints a category label on one line and clips what
 * does not fit, so a long bot name would lose its tail: this wraps it onto two
 * lines instead, and only truncates what still does not fit.
 */
export function wrapLabel(label: string, perLine: number = LABEL_CHARS): string[] {
  const words = label.split(/\s+/u).filter(Boolean);
  const lines: string[] = [];
  let dropped = false;

  for (const word of words) {
    const current = lines.at(-1);
    if (current !== undefined && `${current} ${word}`.length <= perLine) {
      lines[lines.length - 1] = `${current} ${word}`;
      continue;
    }
    if (lines.length === 2) {
      dropped = true;
      break;
    }
    lines.push(word);
  }

  if (lines.length === 0) return [""];
  const last = lines.length - 1;
  const tail = lines[last] ?? "";
  if (dropped || tail.length > perLine) lines[last] = `${tail.slice(0, perLine - 1)}…`;
  return lines;
}

function BotTick({ x = 0, y = 0, payload }: { x?: number; y?: number; payload?: { value?: unknown } }) {
  const label = typeof payload?.value === "string" ? payload.value : "";
  const lines = wrapLabel(label);

  return (
    <text x={x} y={y} textAnchor="end" dominantBaseline="middle" fontSize={12} className="fill-muted-foreground">
      {/* The wrapped name can be a truncation, so the full one stays on the tick. */}
      <title>{label}</title>
      {lines.map((line, index) => (
        <tspan key={`${line}-${index}`} x={x} dy={index === 0 ? -(lines.length - 1) * 7 : 14}>
          {line}
        </tspan>
      ))}
    </text>
  );
}

/**
 * Messages stored today, one horizontal bar per bot. Horizontal because bot names
 * are the long axis and because a 390px screen can hold a label column beside a
 * bar but not a category axis under one.
 *
 * The chart is one image to assistive technology, and its accessible name is the
 * reading itself, so the numbers are not locked behind a hover.
 */
export function BotMessagesChart({ bots, day }: { bots: BotDay[]; day: string }) {
  const reading = bots
    .map((bot) => `${bot.label || bot.instanceId}: ${formatCount(bot.messagesIn)}`)
    .join("; ");

  return (
    <ChartContainer
      config={CONFIG}
      className="aspect-auto w-full"
      style={{ height: Math.min(bots.length * ROW_HEIGHT + 12, MAX_HEIGHT) }}
      role="img"
      aria-label={`Messages stored on ${day} (UTC), per bot. ${reading}.`}
    >
      <BarChart data={bots} layout="vertical" margin={{ top: 4, right: 56, bottom: 4, left: 0 }} barCategoryGap={10}>
        <XAxis type="number" hide />
        <YAxis type="category" dataKey="label" width={LABEL_WIDTH} tickLine={false} axisLine={false} interval={0} tick={<BotTick />} />
        <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel />} />
        <Bar dataKey="messagesIn" fill="var(--color-messagesIn)" radius={4}>
          <LabelList
            dataKey="messagesIn"
            position="right"
            offset={8}
            fontSize={12}
            className="fill-foreground"
            formatter={(value: unknown) => (typeof value === "number" ? formatCount(value) : "")}
          />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}
