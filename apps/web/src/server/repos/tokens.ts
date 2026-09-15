import type { Db } from "mongodb";
import { COLLECTIONS } from "../collections";

/**
 * The assistant's token use over the last week, per instance and UTC day: the
 * `aiCalls` rows of §5.1, grouped in one pass for the whole window.
 *
 * Two absences are kept apart. A day with no call spent nothing, so its figures
 * are `0` and the line reaches zero. Calls that ran while the provider reported
 * nothing are `null`, so the line breaks there instead of running along a zero
 * that would read as a call that cost nothing (§10, the operations slice's
 * decision 5).
 */
export interface TokenDay {
  /** UTC calendar day, `YYYY-MM-DD`. */
  day: string;
  /** Assistant calls that ran that day, whether or not they reported usage. */
  calls: number;
  /**
   * `0` on a day with no call, which is a fact: nothing was spent. `null` when
   * calls ran and none reported the figure, which is an absence, not a zero.
   */
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface TokenTrendInstance {
  instanceId: string;
  /** The stored label, `""` when the document never had one. */
  label: string;
  /** One entry per window day, oldest first, so every instance reads on one axis. */
  days: TokenDay[];
}

export interface TokenTrend {
  /** The window, oldest first and today last. */
  days: string[];
  instances: TokenTrendInstance[];
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The window the dashboard plots; the knob is a constant because nothing varies it. */
export const TOKEN_WINDOW_DAYS = 7;

interface TrendRow {
  _id: { instanceId: string; day: string };
  calls: number;
  inputReported: number;
  outputReported: number;
  totalReported: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

interface LabelDoc {
  _id: string;
  label?: string;
}

/**
 * Reads the window in one aggregation: every day of every instance that called
 * comes back from a single `$match` and `$group`, so the cost is one pass over the
 * week however many bots called. Labels are read with the same two queries the
 * usage read model uses — live instances once, and every called-but-unlinked
 * instance in one `$in` — rather than one query per row.
 */
export async function readTokenTrend(db: Db, organizationId: string, now: Date = new Date()): Promise<TokenTrend> {
  const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  const start = new Date(today.getTime() - (TOKEN_WINDOW_DAYS - 1) * MS_PER_DAY);
  const end = new Date(today.getTime() + MS_PER_DAY);
  const days = Array.from({ length: TOKEN_WINDOW_DAYS }, (_, index) => new Date(start.getTime() + index * MS_PER_DAY).toISOString().slice(0, 10));

  const [rows, live] = await Promise.all([
    db
      .collection(COLLECTIONS.aiCalls)
      .aggregate<TrendRow>([
        { $match: { organizationId, createdAt: { $gte: start, $lt: end } } },
        {
          $group: {
            _id: { instanceId: "$instanceId", day: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "UTC" } } },
            calls: { $sum: 1 },
            // Counted per figure, because a provider may answer with a total and no
            // split: a figure nobody reported must stay absent, not sum to a zero.
            inputReported: { $sum: { $cond: [{ $isNumber: "$usage.inputTokens" }, 1, 0] } },
            outputReported: { $sum: { $cond: [{ $isNumber: "$usage.outputTokens" }, 1, 0] } },
            totalReported: { $sum: { $cond: [{ $isNumber: "$usage.totalTokens" }, 1, 0] } },
            inputTokens: { $sum: "$usage.inputTokens" },
            outputTokens: { $sum: "$usage.outputTokens" },
            totalTokens: { $sum: "$usage.totalTokens" },
          },
        },
      ])
      .toArray(),
    db
      .collection<LabelDoc>(COLLECTIONS.instances)
      .find({ organizationId, deletedAt: null }, { projection: { label: 1 } })
      .toArray(),
  ]);

  const byDay = new Map(rows.map((row) => [`${row._id.instanceId}|${row._id.day}`, row]));
  const labels = new Map(live.map((doc) => [doc._id, doc.label ?? ""]));
  const unlinked = [...new Set(rows.map((row) => row._id.instanceId))].filter((instanceId) => !labels.has(instanceId));
  if (unlinked.length > 0) {
    // An unlinked instance still spent tokens this week, so its label is read
    // rather than the row dropped; an id with no document at all stays the id.
    const removed = await db
      .collection<LabelDoc>(COLLECTIONS.instances)
      .find({ organizationId, _id: { $in: unlinked } }, { projection: { label: 1 } })
      .toArray();
    for (const doc of removed) labels.set(doc._id, doc.label ?? "");
  }

  const instances = [...new Set([...labels.keys(), ...rows.map((row) => row._id.instanceId)])]
    .sort((a, b) => (labels.get(a) ?? a).localeCompare(labels.get(b) ?? b) || a.localeCompare(b))
    .map((instanceId): TokenTrendInstance => {
      const label = labels.get(instanceId) ?? "";
      return {
        instanceId,
        label,
        days: days.map((day): TokenDay => {
          const row = byDay.get(`${instanceId}|${day}`);
          const calls = row?.calls ?? 0;
          // No call is a zero: nothing was spent. Calls with no reported figure
          // stay null, so the chart breaks rather than plotting a zero.
          if (calls === 0) return { day, calls, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
          return {
            day,
            calls,
            inputTokens: row && row.inputReported > 0 ? row.inputTokens : null,
            outputTokens: row && row.outputReported > 0 ? row.outputTokens : null,
            totalTokens: row && row.totalReported > 0 ? row.totalTokens : null,
          };
        }),
      };
    });

  return { days, instances };
}
