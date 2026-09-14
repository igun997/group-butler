import type { Db } from "mongodb";
import { COLLECTIONS } from "../collections";

/**
 * The §10 live counters as one instance's day totals. `messagesIn` is the
 * worker's `counters.messagesIn` — messages a flush actually stored — and the
 * send pair is `counters.sendsSent` / `counters.sendsFailed`, which is why the
 * console calls them ok/failed: the day row names the event, the page names the
 * outcome.
 */
export interface UsageCounters {
  messagesIn: number;
  mediaStored: number;
  mediaUnparsed: number;
  sendsOk: number;
  sendsFailed: number;
  receipts: number;
}

/**
 * Today's assistant calls and the tokens they reported. A `null` figure means
 * the provider reported nothing — the AI SDK types each one as optional, and a
 * stored zero would read as "this was free" (§10).
 */
export interface UsageTokens {
  calls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface UsageInstance {
  instanceId: string;
  /** The stored label; `""` for a document that never had one. */
  label: string;
  /** Whether anything at all was recorded today — a row of zeros is not a day. */
  recorded: boolean;
  counters: UsageCounters;
  tokens: UsageTokens;
}

/** One organisation's usage for one UTC day, which is the page's second section. */
export interface UsageDay {
  /** The UTC calendar day these figures cover, `YYYY-MM-DD`. */
  day: string;
  /** `appSettings.ai.maxTokensPerDay`; `null` when no budget is configured. */
  maxTokensPerDay: number | null;
  recorded: boolean;
  instances: UsageInstance[];
}

interface LabelDoc {
  _id: string;
  label?: string;
}

interface CounterRow {
  _id: string;
  messagesIn: number;
  mediaStored: number;
  mediaUnparsed: number;
  sendsOk: number;
  sendsFailed: number;
  receipts: number;
}

interface TokenRow {
  _id: string;
  calls: number;
  inputReported: number;
  outputReported: number;
  totalReported: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

const EMPTY_COUNTERS: UsageCounters = {
  messagesIn: 0,
  mediaStored: 0,
  mediaUnparsed: 0,
  sendsOk: 0,
  sendsFailed: 0,
  receipts: 0,
};

/**
 * One organisation's day of usage: the worker's counters from `statsDaily`, the
 * assistant calls from `aiCalls`, and the budget they are measured against.
 *
 * Every event the worker counts increments exactly one day row — the group's, or
 * the instance-level row for an event with no group — so summing the day's rows
 * per instance counts each event once. Both collections are read by `$group` per
 * instance rather than fetched, so the cost is one pass each however much the
 * day holds.
 *
 * Rows are the organisation's live instances (an idle instance is visible as
 * *not recorded* rather than absent), plus any instance that recorded usage
 * today but is no longer live: a removal must not silently delete today's work.
 */
export async function readUsage(db: Db, organizationId: string, now: Date = new Date()): Promise<UsageDay> {
  const day = now.toISOString().slice(0, 10);
  const dayStart = new Date(`${day}T00:00:00.000Z`);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  const [counters, tokens, live, settings] = await Promise.all([
    db
      .collection(COLLECTIONS.statsDaily)
      .aggregate<CounterRow>([
        { $match: { organizationId, day } },
        {
          $group: {
            _id: "$instanceId",
            messagesIn: { $sum: "$counters.messagesIn" },
            mediaStored: { $sum: "$counters.mediaStored" },
            mediaUnparsed: { $sum: "$counters.mediaUnparsed" },
            sendsOk: { $sum: "$counters.sendsSent" },
            sendsFailed: { $sum: "$counters.sendsFailed" },
            receipts: { $sum: "$counters.receipts" },
          },
        },
      ])
      .toArray(),
    db
      .collection(COLLECTIONS.aiCalls)
      .aggregate<TokenRow>([
        { $match: { organizationId, createdAt: { $gte: dayStart, $lt: dayEnd } } },
        {
          $group: {
            _id: "$instanceId",
            calls: { $sum: 1 },
            // Reported per figure, because a provider may answer with a total and
            // no split (or the reverse): a figure nobody reported stays null
            // instead of being summed into a zero.
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
      .sort({ label: 1 })
      .toArray(),
    db
      .collection<{ ai?: { maxTokensPerDay?: number } }>(COLLECTIONS.appSettings)
      .findOne({ _id: organizationId as never }, { projection: { _id: 0, "ai.maxTokensPerDay": 1 } }),
  ]);

  const byCounters = new Map(counters.map((row) => [row._id, row]));
  const byTokens = new Map(tokens.map((row) => [row._id, row]));
  const labelOf = new Map(live.map((doc) => [doc._id, doc.label ?? ""]));

  const recorded = [...new Set([...byCounters.keys(), ...byTokens.keys()])];
  const noDocumentYet = recorded.filter((instanceId) => !labelOf.has(instanceId));
  if (noDocumentYet.length > 0) {
    // A removed instance still recorded today's work, so its label is read once
    // rather than dropped; an id with no document at all falls back to the id.
    const removed = await db
      .collection<LabelDoc>(COLLECTIONS.instances)
      .find({ organizationId, _id: { $in: noDocumentYet } }, { projection: { label: 1 } })
      .toArray();
    for (const doc of removed) labelOf.set(doc._id, doc.label ?? "");
  }

  const instanceIds = [...new Set([...labelOf.keys(), ...recorded])].sort();
  const instances = instanceIds.map((instanceId): UsageInstance => {
    const counter = byCounters.get(instanceId);
    const token = byTokens.get(instanceId);
    const counters: UsageCounters = counter
      ? {
          messagesIn: counter.messagesIn,
          mediaStored: counter.mediaStored,
          mediaUnparsed: counter.mediaUnparsed,
          sendsOk: counter.sendsOk,
          sendsFailed: counter.sendsFailed,
          receipts: counter.receipts,
        }
      : { ...EMPTY_COUNTERS };
    const tokens: UsageTokens = {
      calls: token?.calls ?? 0,
      inputTokens: token && token.inputReported > 0 ? token.inputTokens : null,
      outputTokens: token && token.outputReported > 0 ? token.outputTokens : null,
      totalTokens: token && token.totalReported > 0 ? token.totalTokens : null,
    };
    return {
      instanceId,
      label: labelOf.get(instanceId) ?? "",
      recorded: tokens.calls > 0 || Object.values(counters).some((count) => count > 0),
      counters,
      tokens,
    };
  });

  return {
    day,
    maxTokensPerDay: settings?.ai?.maxTokensPerDay ?? null,
    recorded: instances.some((instance) => instance.recorded),
    instances,
  };
}
