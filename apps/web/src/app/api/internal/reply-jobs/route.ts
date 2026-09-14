import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { COLLECTIONS } from "../../../../server/collections";
import { getDb } from "../../../../server/mongo";
import { createAutomaticSend } from "../../../../server/repos/sends";
import { generateGroupReply } from "../../../../server/replies/generate";

export const runtime = "nodejs";

interface ReplyJobRequest {
  organizationId: string;
  instanceId: string;
  groupJid: string;
  waMessageId: string;
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

  try {
    const text = await generateGroupReply({
      prompt: message.text,
      history: history
        .filter((row) => row.senderJid && row.text && row.timestamp instanceof Date)
        .map((row) => ({ senderJid: row.senderJid!, text: row.text!, timestamp: row.timestamp! }))
        .reverse(),
    });
    const send = await createAutomaticSend(db, {
      organizationId: body.organizationId,
      instanceId: body.instanceId,
      groupJid: body.groupJid,
      text,
      idempotencyKey: `owner-mention:${body.instanceId}:${body.waMessageId}`,
      replyToMessageId: body.waMessageId,
    });
    return NextResponse.json({ send }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("automatic reply generation failed", error);
    return NextResponse.json({ error: "automatic reply generation failed" }, { status: 502 });
  }
}
