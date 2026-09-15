import { timingSafeEqual } from "node:crypto";
import { ObjectId } from "mongodb";
import { NextResponse } from "next/server";
import { z } from "zod";
import { COLLECTIONS } from "../collections";
import { summarizeMemoryBatch, type MemoryModelCall } from "./summarize";
import { getDb } from "../mongo";
import { claimMemorySummaryWork, completeMemoryBatch, InvalidMemoryBatchSourceError, loadMemoryBatch, releaseMemorySummaryWork, renewMemorySummaryWork, resolveAuthorizationRevokedMemoryBatch, resolveRevokedMemoryBatch, type MemoryBatch } from "../repos/memory";

const MEMORY_SUMMARY_HEARTBEAT_MS = 30_000;
const MEMORY_SUMMARY_WATCHDOG_MARGIN_MS = 5_000;
let modelCallForTest: MemoryModelCall | null = null;
let heartbeatIntervalForTest: number | null = null;
let renewForTest: ((input: { batch: MemoryBatch; token: string; signal: AbortSignal; maxTimeMS: number }) => Promise<{ kind: "renewed"; expiresAt: Date } | { kind: "lost" }>) | null = null;

export function setMemoryBatchModelCallForTest(call: MemoryModelCall | null): void {
  modelCallForTest = call;
}

export function setMemoryBatchHeartbeatIntervalForTest(interval: number | null): void {
  heartbeatIntervalForTest = interval;
}

export function setMemoryBatchRenewForTest(renew: ((input: { batch: MemoryBatch; token: string; signal: AbortSignal; maxTimeMS: number }) => Promise<{ kind: "renewed"; expiresAt: Date } | { kind: "lost" }>) | null): void {
  renewForTest = renew;
}

function sameSecret(value: string | null, secret: string | undefined): boolean {
  if (!value?.startsWith("Bearer ") || !secret) return false;
  const supplied = Buffer.from(value.slice(7), "utf8");
  const expected = Buffer.from(secret, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function batchIdOf(value: unknown): ObjectId | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length !== 1 || entries[0]?.[0] !== "batchId" || typeof entries[0][1] !== "string" || !ObjectId.isValid(entries[0][1])) return null;
  return new ObjectId(entries[0][1]);
}

function isTerminalModelError(error: unknown): boolean {
  if (error instanceof InvalidMemoryBatchSourceError || error instanceof SyntaxError || error instanceof z.ZodError) return true;
  return error instanceof Error && /AI_BASE_URL|AI_API_KEY|AI_MODEL|schema|structured|output.*invalid|refus/i.test(error.message);
}

function providerStatus(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("statusCode" in error)) return null;
  return typeof error.statusCode === "number" ? error.statusCode : null;
}

export async function postMemoryBatch(request: Request) {
  if (!sameSecret(request.headers.get("authorization"), process.env.MEMORY_CALLBACK_SECRET)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid memory batch" }, { status: 400 });
  }
  const batchId = batchIdOf(body);
  if (!batchId) return NextResponse.json({ error: "invalid memory batch" }, { status: 400 });

  const controller = new AbortController();
  const abortSignal = AbortSignal.any([request.signal, controller.signal]);
  let claimed: { batch: MemoryBatch; token: string } | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let watchdog: NodeJS.Timeout | null = null;
  let renewal = Promise.resolve();
  let renewalLost = false;
  try {
    const db = await getDb();
    const loaded = await loadMemoryBatch(db, batchId);
    if (!loaded) return new NextResponse(null, { status: 204 });
    const group = await db.collection(COLLECTIONS.groups).findOne(
      { organizationId: loaded.batch.organizationId, instanceId: loaded.batch.instanceId, groupJid: loaded.batch.groupJid },
      { projection: { "config.assigned": 1, "config.whitelisted": 1 } },
    );
    if (!group || group.config?.assigned !== true || group.config?.whitelisted !== true) {
      if (await resolveAuthorizationRevokedMemoryBatch(db, loaded.batch)) return NextResponse.json({ status: "complete" }, { status: 201 });
      return NextResponse.json({ error: "memory batch unavailable" }, { status: 503 });
    }
    if (loaded.messages.length === 0) return NextResponse.json({ error: "invalid memory batch" }, { status: 422 });
    const work = await claimMemorySummaryWork(db, loaded.batch);
    if (work.kind !== "claimed") return new NextResponse(null, { status: work.kind === "busy" ? 202 : 204 });
    claimed = { batch: loaded.batch, token: work.token };
    let workExpiresAt = work.expiresAt;
    const resetWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      const delay = Math.max(0, workExpiresAt.getTime() - Date.now() - MEMORY_SUMMARY_WATCHDOG_MARGIN_MS);
      watchdog = setTimeout(() => {
        renewalLost = true;
        controller.abort();
      }, delay);
    };
    resetWatchdog();
    const renew = () => {
      renewal = renewal.then(async () => {
        const remaining = workExpiresAt.getTime() - Date.now() - MEMORY_SUMMARY_WATCHDOG_MARGIN_MS;
        const maxTimeMS = Math.max(1, Math.min(10_000, remaining));
        const renewalController = new AbortController();
        const renewalSignal = AbortSignal.any([abortSignal, renewalController.signal]);
        const deadline = Promise.withResolvers<{ kind: "lost" }>();
        const timeout = setTimeout(() => {
          renewalController.abort();
          deadline.resolve({ kind: "lost" });
        }, maxTimeMS);
        try {
          const operation = renewForTest
            ? renewForTest({ batch: loaded.batch, token: work.token, signal: renewalSignal, maxTimeMS })
            : renewMemorySummaryWork(db, loaded.batch, work.token, { maxTimeMS });
          const result = await Promise.race([operation, deadline.promise]);
          if (result.kind !== "renewed") {
            renewalLost = true;
            controller.abort();
            return;
          }
          workExpiresAt = result.expiresAt;
          resetWatchdog();
        } catch {
          renewalLost = true;
          controller.abort();
        } finally {
          clearTimeout(timeout);
        }
      });
    };
    heartbeat = setInterval(renew, heartbeatIntervalForTest ?? MEMORY_SUMMARY_HEARTBEAT_MS);

    const existing = await db.collection(COLLECTIONS.memorySummaries).findOne({ organizationId: loaded.batch.organizationId, batchId: loaded.batch._id }, { projection: { _id: 1 } });

    if (existing) {
      clearInterval(heartbeat);
      heartbeat = null;
      if (watchdog) {
        clearTimeout(watchdog);
        watchdog = null;
      }
      await renewal;
      if (renewalLost || abortSignal.aborted) throw new Error("memory summary work was lost");
      const status = await completeMemoryBatch(db, loaded.batch, work.token, { summary: "", topics: [], decisions: [], commitments: [], openQuestions: [], actionItems: [], facts: [], containsUntrustedInstructions: false });
      claimed = null;
      return status === "lost_lease" ? new NextResponse(null, { status: 204 }) : NextResponse.json({ status: "complete" }, { status: 201 });
    }

    const eligibleBeforeModel = await db.collection(COLLECTIONS.groups).findOne(
      { organizationId: loaded.batch.organizationId, instanceId: loaded.batch.instanceId, groupJid: loaded.batch.groupJid },
      { projection: { "config.assigned": 1, "config.whitelisted": 1, "config.configVersion": 1 } },
    );
    const configVersion = typeof eligibleBeforeModel?.config?.configVersion === "number"
      ? eligibleBeforeModel.config.configVersion
      : 0;
    if (!eligibleBeforeModel || eligibleBeforeModel.config?.assigned !== true || eligibleBeforeModel.config?.whitelisted !== true) {
      if (await resolveAuthorizationRevokedMemoryBatch(db, loaded.batch, work.token)) {
        claimed = null;
        return NextResponse.json({ status: "complete" }, { status: 201 });
      }
      throw new Error("memory authorization resolution lost");
    }
    if (configVersion !== work.configVersion) throw new Error("memory configuration changed");

    const output = await summarizeMemoryBatch({ messages: loaded.messages, abortSignal }, modelCallForTest ?? undefined);
    clearInterval(heartbeat);
    heartbeat = null;
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = null;
    }
    await renewal;
    if (renewalLost || abortSignal.aborted) throw new Error("memory summary work was lost");
    const status = await completeMemoryBatch(db, loaded.batch, work.token, output);
    if (status === "completed") {
      claimed = null;
      return NextResponse.json({ status: "complete" }, { status: 201 });
    }
    const currentGroup = await db.collection(COLLECTIONS.groups).findOne(
      { organizationId: loaded.batch.organizationId, instanceId: loaded.batch.instanceId, groupJid: loaded.batch.groupJid },
      { projection: { "config.assigned": 1, "config.whitelisted": 1 } },
    );
    if (!currentGroup || currentGroup.config?.assigned !== true || currentGroup.config?.whitelisted !== true) {
      if (await resolveAuthorizationRevokedMemoryBatch(db, loaded.batch, work.token)) {
        claimed = null;
        return NextResponse.json({ status: "complete" }, { status: 201 });
      }
    }
    throw new Error("memory configuration changed");
  } catch (error) {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = null;
    }
    await renewal;
    if (claimed) await releaseMemorySummaryWork(await getDb(), claimed.batch, claimed.token);
    if (error instanceof InvalidMemoryBatchSourceError && await resolveRevokedMemoryBatch(await getDb(), batchId)) {
      return NextResponse.json({ status: "complete" }, { status: 201 });
    }
    if (isTerminalModelError(error)) return NextResponse.json({ error: "invalid memory batch" }, { status: 422 });
    const status = providerStatus(error);
    if (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) return NextResponse.json({ error: "invalid memory batch" }, { status: 422 });
    return NextResponse.json({ error: "memory batch unavailable" }, { status: 503 });
  } finally {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = null;
    }
  }
}
