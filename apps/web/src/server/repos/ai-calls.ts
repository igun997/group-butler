import type { Db } from "mongodb";
import { COLLECTIONS } from "../collections";

/**
 * The token figures of one model call. `null` is "the provider reported
 * nothing", which is not the same as zero: AI SDK 7 types each figure as
 * `number | undefined`, and a call whose usage never arrived must not be stored
 * as a call that cost nothing (§10, the operations slice's decision 5).
 */
export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

/** A call the provider reported nothing about — a failure before or inside it. */
export const NO_TOKEN_USAGE: TokenUsage = { inputTokens: null, outputTokens: null, totalTokens: null };

/**
 * The `aiCalls` document of §5.1 as the reply path writes it: one row per model
 * call, whether it succeeded or failed. `groupJid` is the group the call was
 * made for — the reply path never spans groups — and `latencyMs` is the model
 * call, not the work around it.
 */
export interface AiCallRow {
  organizationId: string;
  instanceId: string;
  groupJid: string;
  kind: "assistant";
  model: string;
  status: "ok" | "error";
  latencyMs: number;
  usage: TokenUsage;
  createdAt: Date;
}

/**
 * Writes one `aiCalls` row. The collection had no writer at all before the
 * operations slice, which is why the console's token figures had nothing behind
 * them; this is now the only path that creates them, so the shape here is the
 * shape the read model aggregates.
 */
export async function writeAiCall(db: Db, row: AiCallRow): Promise<void> {
  await db.collection(COLLECTIONS.aiCalls).insertOne({
    organizationId: row.organizationId,
    instanceId: row.instanceId,
    groupJid: row.groupJid,
    kind: row.kind,
    model: row.model,
    status: row.status,
    latencyMs: row.latencyMs,
    usage: row.usage,
    createdAt: row.createdAt,
  });
}
