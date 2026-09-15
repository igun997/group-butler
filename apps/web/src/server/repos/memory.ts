import { randomUUID } from "node:crypto";
import { ObjectId, type Db, type Document } from "mongodb";
import { COLLECTIONS } from "../collections";
import type { MemorySourceMessage, MemorySummaryOutput } from "../memory/summarize";

interface Lease {
  token: string;
  expiresAt: Date;
}

interface SummaryWork extends Lease {
  configVersion: number;
}

export interface MemoryBatch {
  _id: ObjectId;
  organizationId: string;
  instanceId: string;
  groupJid: string;
  first: { timestamp: Date; waMessageId: string };
  last: { timestamp: Date; waMessageId: string };
  sourceCount: number;
  sourceWaMessageIds: string[];
  state: string;
  summaryId?: ObjectId;
  lease: Lease | null;
  summaryWork?: SummaryWork | null;
}

export interface LoadedMemoryBatch {
  batch: MemoryBatch;
  messages: MemorySourceMessage[];
}


let memoryReadFenceHookForTest: (() => Promise<void>) | null = null;

export function setMemoryReadFenceHookForTest(hook: (() => Promise<void>) | null): void {
  memoryReadFenceHookForTest = hook;
}
export class InvalidMemoryBatchSourceError extends Error {}

function liveFilter(batch: MemoryBatch, leaseToken: string, workToken?: string) {
  return {
    _id: batch._id,
    organizationId: batch.organizationId,
    instanceId: batch.instanceId,
    groupJid: batch.groupJid,
    state: "processing",
    "lease.token": leaseToken,
    "lease.expiresAt": { $gt: new Date() },
    ...(workToken ? { "summaryWork.token": workToken, "summaryWork.expiresAt": { $gt: new Date() } } : {}),
  };
}


function normalizedText(value: string): string {
  return value.trim().toLowerCase().replaceAll(/\s+/g, " ");
}

function dateOrNull(value: string | null): Date | null {
  if (!value) return null;
  const result = new Date(value);
  return Number.isNaN(result.getTime()) ? null : result;
}

export async function loadMemoryBatch(db: Db, batchId: ObjectId): Promise<LoadedMemoryBatch | null> {
  const batch = await db.collection<MemoryBatch>(COLLECTIONS.memoryBatches).findOne({
    _id: batchId,
    state: "processing",
    "lease.expiresAt": { $gt: new Date() },
  });
  if (!batch || !batch.lease || batch.sourceWaMessageIds.length !== batch.sourceCount) return null;

  const messages = await db.collection<MemorySourceMessage>(COLLECTIONS.messages).find(
    {
      organizationId: batch.organizationId,
      instanceId: batch.instanceId,
      groupJid: batch.groupJid,
      waMessageId: { $in: batch.sourceWaMessageIds },
      "flags.revoked": { $ne: true },
    },
    {
      projection: {
        _id: 0, waMessageId: 1, timestamp: 1, senderJid: 1, kind: 1, text: 1,
        "media.status": 1, "media.mime": 1, "media.fileName": 1,
        "raw.truncated": 1, "raw.bytes": 1,
      },
    },
  ).sort({ timestamp: 1, waMessageId: 1 }).toArray();

  if (messages.length !== batch.sourceCount) throw new InvalidMemoryBatchSourceError();
  return { batch, messages };
}

export async function claimMemorySummaryWork(db: Db, batch: MemoryBatch) {
  if (!batch.lease) return { kind: "lost_lease" as const };
  const group = await db.collection<Document>(COLLECTIONS.groups).findOne(
    { organizationId: batch.organizationId, instanceId: batch.instanceId, groupJid: batch.groupJid, "config.assigned": true, "config.whitelisted": true },
    { projection: { "config.configVersion": 1 } },
  );
  if (!group) return { kind: "lost_lease" as const };

  const token = randomUUID();
  const expiresAt = new Date(Math.min(batch.lease.expiresAt.getTime(), Date.now() + 90_000));
  const configVersion = typeof group.config === "object" && group.config !== null &&
    typeof (group.config as Document).configVersion === "number"
    ? (group.config as Document).configVersion as number
    : 0;
  const result = await db.collection<MemoryBatch>(COLLECTIONS.memoryBatches).findOneAndUpdate(
    { ...liveFilter(batch, batch.lease.token), $or: [{ summaryWork: null }, { summaryWork: { $exists: false } }, { "summaryWork.expiresAt": { $lte: new Date() } }] },
    { $set: { summaryWork: { token, expiresAt, configVersion } } },
    { returnDocument: "after" },
  );
  if (result?.summaryWork?.token === token) return { kind: "claimed" as const, token, expiresAt, configVersion };
  return { kind: "busy" as const };
}

export async function renewMemorySummaryWork(db: Db, batch: MemoryBatch, token: string, input: { maxTimeMS: number }) {
  if (!batch.lease) return { kind: "lost" as const };
  const result = await db.collection<MemoryBatch>(COLLECTIONS.memoryBatches).findOneAndUpdate(
    liveFilter(batch, batch.lease.token, token),
    [{ $set: { "summaryWork.expiresAt": { $min: ["$lease.expiresAt", new Date(Date.now() + 90_000)] } } }],
    { returnDocument: "after", maxTimeMS: input.maxTimeMS },
  );
  return result?.summaryWork?.expiresAt instanceof Date
    ? { kind: "renewed" as const, expiresAt: result.summaryWork.expiresAt }
    : { kind: "lost" as const };
}

export async function releaseMemorySummaryWork(db: Db, batch: MemoryBatch, token: string): Promise<void> {
  if (batch.lease) await db.collection(COLLECTIONS.memoryBatches).updateOne(liveFilter(batch, batch.lease.token, token), { $set: { summaryWork: null } });
}

export async function completeMemoryBatch(db: Db, batch: MemoryBatch, token: string, output: MemorySummaryOutput): Promise<"completed" | "already_complete" | "lost_lease"> {
  if (!batch.lease) return "lost_lease";
  const session = db.client.startSession();
  let status: "completed" | "already_complete" | "lost_lease" = "lost_lease";
  const now = new Date();

  try {
    await session.withTransaction(async () => {
      const existing = await db.collection(COLLECTIONS.memorySummaries).findOne(
        { organizationId: batch.organizationId, instanceId: batch.instanceId, groupJid: batch.groupJid, batchId: batch._id },
        { session, projection: { _id: 1 } },
      );
      if (existing) {
        const current = await db.collection<MemoryBatch>(COLLECTIONS.memoryBatches).findOne(
          { _id: batch._id, organizationId: batch.organizationId, instanceId: batch.instanceId, groupJid: batch.groupJid },
          { session, projection: { state: 1, summaryId: 1 } },
        );
        if (current?.state === "complete" && current.summaryId instanceof ObjectId && current.summaryId.equals(existing._id)) {
          status = "already_complete";
          return;
        }
        const updated = await db.collection(COLLECTIONS.memoryBatches).updateOne(
          liveFilter(batch, batch.lease!.token, token),
          { $set: { state: "complete", summaryId: existing._id, completedAt: now, lease: null, summaryWork: null } },
          { session },
        );
        status = updated.matchedCount === 1 ? "already_complete" : "lost_lease";
        return;
      }

      const group = await db.collection<Document>(COLLECTIONS.groups).findOne(
        { organizationId: batch.organizationId, instanceId: batch.instanceId, groupJid: batch.groupJid, "config.assigned": true, "config.whitelisted": true },
        { session, projection: { "config.configVersion": 1 } },
      );
      const claimed = await db.collection<MemoryBatch>(COLLECTIONS.memoryBatches).findOne(
        { _id: batch._id },
        { session, projection: { summaryWork: 1 } },
      );
      const work = claimed?.summaryWork;
      const configVersion = typeof group?.config === "object" && group.config !== null &&
        typeof (group.config as Document).configVersion === "number"
        ? (group.config as Document).configVersion as number
        : 0;
      if (!group || !work || work.token !== token || work.configVersion !== configVersion) {
        status = "lost_lease";
        return;
      }
      const fenced = await db.collection(COLLECTIONS.groups).updateOne(
        {
          organizationId: batch.organizationId,
          instanceId: batch.instanceId,
          groupJid: batch.groupJid,
          "config.assigned": true,
          "config.whitelisted": true,
          ...(configVersion === 0
            ? { $or: [{ "config.configVersion": 0 }, { "config.configVersion": { $exists: false } }] }
            : { "config.configVersion": configVersion }),
        },
        { $inc: { memoryReadFence: 1 } },
        { session },
      );
      if (fenced.matchedCount !== 1) {
        status = "lost_lease";
        return;
      }
      await memoryReadFenceHookForTest?.();
      const summaryId = new ObjectId();
      await db.collection(COLLECTIONS.memorySummaries).insertOne({
        _id: summaryId,
        organizationId: batch.organizationId,
        instanceId: batch.instanceId,
        groupJid: batch.groupJid,
        batchId: batch._id,
        schemaVersion: 1,
        period: { from: batch.first.timestamp, to: batch.last.timestamp },
        source: { count: batch.sourceCount, messageIds: batch.sourceWaMessageIds },
        summary: output.summary,
        topics: output.topics,
        decisions: output.decisions,
        commitments: output.commitments,
        openQuestions: output.openQuestions,
        actionItems: output.actionItems,
        safety: { containsUntrustedInstructions: output.containsUntrustedInstructions, redactions: 0 },
        createdAt: now,
      }, { session });
      const facts = new Map<string, typeof output.facts[number]>();
      for (const fact of output.facts) {
        const textSearch = normalizedText(fact.text);
        const key = `${fact.kind}\u0000${textSearch}`;
        if (!facts.has(key)) facts.set(key, fact);
      }
      if (facts.size) await db.collection(COLLECTIONS.memoryFacts).insertMany([...facts.values()].map((fact) => ({
        organizationId: batch.organizationId,
        instanceId: batch.instanceId,
        groupJid: batch.groupJid,
        batchId: batch._id,
        summaryId,
        kind: fact.kind,
        text: fact.text,
        textSearch: normalizedText(fact.text),
        subject: fact.subject,
        confidence: fact.confidence,
        occurredAt: dateOrNull(fact.occurredAt),
        sourceWaMessageIds: fact.sourceWaMessageIds,
        createdAt: now,
      })), { session });
      const updated = await db.collection(COLLECTIONS.memoryBatches).updateOne(
        liveFilter(batch, batch.lease!.token, token),
        { $set: { state: "complete", summaryId, completedAt: now, lease: null, summaryWork: null } },
        { session },
      );
      status = updated.matchedCount === 1 ? "completed" : "lost_lease";
      if (status === "lost_lease") throw new Error("memory batch lease was lost");
    });
    return status;
  } catch {
    return "lost_lease";
  } finally {
    await session.endSession();
  }
}

export async function resolveAuthorizationRevokedMemoryBatch(db: Db, batch: MemoryBatch, workToken?: string): Promise<boolean> {
  if (!batch.lease) return false;
  const session = db.client.startSession();
  let resolved = false;
  try {
    await session.withTransaction(async () => {
      const group = await db.collection<Document>(COLLECTIONS.groups).findOne(
        { organizationId: batch.organizationId, instanceId: batch.instanceId, groupJid: batch.groupJid },
        { session, projection: { "config.assigned": 1, "config.whitelisted": 1 } },
      );
      const config = group?.config as Document | undefined;
      if (!group || (config?.assigned === true && config?.whitelisted === true)) return;
      const summaryId = new ObjectId();
      const now = new Date();
      await db.collection(COLLECTIONS.memorySummaries).insertOne({
        _id: summaryId, organizationId: batch.organizationId, instanceId: batch.instanceId, groupJid: batch.groupJid,
        batchId: batch._id, schemaVersion: 1,
        period: { from: batch.first.timestamp, to: batch.last.timestamp },
        source: { count: batch.sourceCount, messageIds: batch.sourceWaMessageIds },
        summary: "", topics: [], decisions: [], commitments: [], openQuestions: [], actionItems: [],
        safety: { containsUntrustedInstructions: false, redactions: batch.sourceCount }, createdAt: now,
      }, { session });
      const updated = await db.collection(COLLECTIONS.memoryBatches).updateOne(
        liveFilter(batch, batch.lease!.token, workToken),
        { $set: { state: "complete", summaryId, completedAt: now, lease: null, summaryWork: null } },
        { session },
      );
      if (updated.matchedCount !== 1) throw new Error("memory batch lease was lost");
      resolved = true;
    });
    return resolved;
  } catch {
    return false;
  } finally {
    await session.endSession();
  }
}

export async function resolveRevokedMemoryBatch(db: Db, batchId: ObjectId): Promise<boolean> {
  const session = db.client.startSession();
  let resolved = false;
  try {
    await session.withTransaction(async () => {
      const batch = await db.collection<MemoryBatch>(COLLECTIONS.memoryBatches).findOne(
        { _id: batchId, state: "processing", "lease.expiresAt": { $gt: new Date() } },
        { session },
      );
      if (!batch?.lease) return;
      const revoked = await db.collection(COLLECTIONS.messages).countDocuments({
        organizationId: batch.organizationId,
        instanceId: batch.instanceId,
        groupJid: batch.groupJid,
        waMessageId: { $in: batch.sourceWaMessageIds },
        "flags.revoked": true,
      }, { session, limit: 1 });
      if (!revoked) return;

      const now = new Date();
      const summaryId = new ObjectId();
      await db.collection(COLLECTIONS.memorySummaries).insertOne({
        _id: summaryId,
        organizationId: batch.organizationId,
        instanceId: batch.instanceId,
        groupJid: batch.groupJid,
        batchId: batch._id,
        schemaVersion: 1,
        period: { from: batch.first.timestamp, to: batch.last.timestamp },
        source: { count: batch.sourceCount, messageIds: batch.sourceWaMessageIds },
        summary: "",
        topics: [], decisions: [], commitments: [], openQuestions: [], actionItems: [],
        safety: { containsUntrustedInstructions: false, redactions: batch.sourceCount },
        createdAt: now,
      }, { session });
      const updated = await db.collection(COLLECTIONS.memoryBatches).updateOne(
        liveFilter(batch, batch.lease.token),
        { $set: { state: "complete", summaryId, completedAt: now, lease: null, summaryWork: null } },
        { session },
      );
      if (updated.matchedCount !== 1) throw new Error("memory batch lease was lost");
      resolved = true;
    });
    return resolved;
  } catch {
    return false;
  } finally {
    await session.endSession();
  }
}
