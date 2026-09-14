import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { COLLECTIONS } from "../../../../server/collections";
import { getDb } from "../../../../server/mongo";
import type { Db } from "mongodb";
import { NO_TOKEN_USAGE, writeAiCall, type AiCallRow } from "../../../../server/repos/ai-calls";
import { createAutomaticSend } from "../../../../server/repos/sends";
import { generateGroupReply, replyModelConfig, type GeneratedReply } from "../../../../server/replies/generate";

export const runtime = "nodejs";

interface ReplyJobRequest {
  organizationId: string;
  instanceId: string;
  groupJid: string;
  waMessageId: string;
}

/**
 * Records one model call, swallowing a failed write. The call has already
 * happened by the time this runs, so a statistics row the database refused must
 * not become a second call, a lost reply, or a 5xx to the worker that asked;
 * it is logged instead.
 */
async function recordCall(db: Db, row: AiCallRow): Promise<void> {
  try {
    await writeAiCall(db, row);
  } catch (error) {
    console.error("model call record failed", error);
  }
}

function sameSecret(value: string | null, secret: string | undefined): boolean {
  if (!value?.startsWith("Bearer ") || !secret) return false;
  const supplied = Buffer.from(value.slice(7));
  const expected = Buffer.from(secret);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function phoneJid(value: string): string {
  const user = value.split("@", 1)[0]?.split(/[.:]/, 1)[0] ?? "";
  return user ? `${user}@s.whatsapp.net` : "";
}

function validJob(value: unknown): value is ReplyJobRequest {
  if (!value || typeof value !== "object") return false;
  const job = value as Record<string, unknown>;
  return ["organizationId", "instanceId", "groupJid", "waMessageId"].every((key) => typeof job[key] === "string" && job[key] !== "");
}

export async function POST(request: Request) {
  if (!sameSecret(request.headers.get("authorization"), process.env.REPLY_CALLBACK_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!validJob(body)) return NextResponse.json({ error: "invalid reply job" }, { status: 400 });

  const db = await getDb();
  const organization = await db.collection<{ config?: { autoReplyAuthorizedJids?: unknown } }>(COLLECTIONS.organizations).findOne(
    { _id: body.organizationId as never },
    { projection: { _id: 0, "config.autoReplyAuthorizedJids": 1 } },
  );
  const authorizedJids = Array.isArray(organization?.config?.autoReplyAuthorizedJids)
    ? organization.config.autoReplyAuthorizedJids.filter((jid): jid is string => typeof jid === "string").map(phoneJid).filter(Boolean)
    : [];
  if (authorizedJids.length === 0) return NextResponse.json({ error: "automatic replies are disabled" }, { status: 503 });
  const group = await db.collection(COLLECTIONS.groups).findOne(
    { organizationId: body.organizationId, instanceId: body.instanceId, groupJid: body.groupJid },
    { projection: { _id: 0, "config.assigned": 1, "config.whitelisted": 1 } },
  );
  if (group?.config?.assigned !== true || group.config.whitelisted !== true) {
    return NextResponse.json({ error: "group is not eligible for automatic replies" }, { status: 409 });
  }

  const message = await db.collection(COLLECTIONS.messages).findOne<{ senderJid?: string; text?: string }>(
    { organizationId: body.organizationId, instanceId: body.instanceId, groupJid: body.groupJid, waMessageId: body.waMessageId, fromMe: false },
    { projection: { _id: 0, senderJid: 1, text: 1 } },
  );
  if (!message || !authorizedJids.includes(phoneJid(message.senderJid ?? "")) || !message.text?.trim()) {
    return NextResponse.json({ error: "authorized mention source was not found" }, { status: 404 });
  }

  const history = await db
    .collection<{ senderJid?: string; text?: string; timestamp?: Date }>(COLLECTIONS.messages)
    .find(
      { organizationId: body.organizationId, instanceId: body.instanceId, groupJid: body.groupJid, text: { $type: "string", $ne: "" } },
      { projection: { _id: 0, senderJid: 1, text: 1, timestamp: 1 } },
    )
    .sort({ timestamp: -1 })
    .limit(20)
    .toArray();

  const startedAt = Date.now();
  let reply: GeneratedReply | null = null;
  try {
    reply = await generateGroupReply({
      prompt: message.text,
      history: history
        .filter((row) => row.senderJid && row.text && row.timestamp instanceof Date)
        .map((row) => ({ senderJid: row.senderJid!, text: row.text!, timestamp: row.timestamp! }))
        .reverse(),
    });
  } catch (error) {
    console.error("automatic reply generation failed", error);
  }

  // One row per model call, on success and on failure alike (§10): a failed call
  // is what the console's token figures and success rate are made of, so it is
  // recorded before the answer is decided. Recording is best-effort — a
  // statistics write must not turn a call the provider already made into a
  // second one — and a config with no model has no model to name.
  await recordCall(db, {
    organizationId: body.organizationId,
    instanceId: body.instanceId,
    groupJid: body.groupJid,
    kind: "assistant",
    model: reply?.model ?? replyModelConfig()?.model ?? "",
    status: reply ? "ok" : "error",
    latencyMs: Date.now() - startedAt,
    usage: reply?.usage ?? NO_TOKEN_USAGE,
    createdAt: new Date(),
  });
  if (!reply) return NextResponse.json({ error: "automatic reply generation failed" }, { status: 502 });

  try {
    const send = await createAutomaticSend(db, {
      organizationId: body.organizationId,
      instanceId: body.instanceId,
      groupJid: body.groupJid,
      text: reply.text,
      idempotencyKey: `owner-mention:${body.instanceId}:${body.waMessageId}`,
      replyToMessageId: body.waMessageId,
    });
    return NextResponse.json({ send }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("automatic reply send creation failed", error);
    return NextResponse.json({ error: "automatic reply generation failed" }, { status: 502 });
  }
}
