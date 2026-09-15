import { timingSafeEqual } from "node:crypto";
import type { ToolSet } from "ai";
import { ObjectId } from "mongodb";
import { NextResponse } from "next/server";
import { COLLECTIONS } from "../../../../server/collections";
import { getDb } from "../../../../server/mongo";
import type { Db } from "mongodb";
import { NO_TOKEN_USAGE, writeAiCall, type AiCallRow } from "../../../../server/repos/ai-calls";
import { createAutomaticSendUnderRunLease, createHumanReviewSendUnderRunLease, type ChatKind } from "../../../../server/repos/sends";
import { decideAction, normalizeShortId, type ActionDecision, type PendingActionDecision } from "../../../../server/repos/pending-actions";
import { generateGroupReply, replyModelConfig, type GeneratedReply } from "../../../../server/replies/generate";
import { sourceLinksOf, type WhatsAppOutputCode } from "../../../../server/ai/sanitize-whatsapp";
import { groupToolSet, mediaToolSet, tokenResultBudget } from "../../../../server/mcp/agent-tools";
import { connectGroupTools } from "../../../../server/mcp/group-tools";
import { connectMediaTools, type ToolChatContext } from "../../../../server/mcp/media-tools";
import { authorizedJidsOf, normalizeAuthorizedJid } from "../../../../server/authorized-jids";
import {
  AGENT_REPLY_HEARTBEAT_MS,
  agentReplyIdempotencyKey,
  assembleReplyPrompt,
  claimAgentReplyRun,
  classifyReplyFailure,
  failAgentReplyRun,
  reconcileAgentReplySend,
  recallMemory,
  renewAgentReplyLease,
  selectTokenCounter,
  type ReplyContextMessage,
} from "../../../../server/memory/recall";

export const runtime = "nodejs";

interface ReplyJobRequest {
  organizationId: string;
  instanceId: string;
  groupJid: string;
  waMessageId: string;
  /**
   * `false` marks a direct message, whose `groupJid` is the owner's chat JID
   * rather than a group. Absent means a group: that is every callback the worker
   * sent before it learned about direct messages.
   */
  isGroup?: boolean;
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

function validJob(value: unknown): value is ReplyJobRequest {
  if (!value || typeof value !== "object") return false;
  const job = value as Record<string, unknown>;
  if (!["organizationId", "instanceId", "groupJid", "waMessageId"].every((key) => typeof job[key] === "string" && job[key] !== "")) return false;
  return job.isGroup === undefined || typeof job.isGroup === "boolean";
}

/** `approve <shortId>` or `reject <shortId>`, the only thing a direct chat can command. */
interface ApprovalCommand {
  decision: PendingActionDecision;
  shortId: string;
}

/**
 * The one command a direct chat carries: an owner's decision on a staged action.
 * Case and the spaces around it belong to the owner, not to the syntax — the
 * short id is normalized the same way `decideAction` normalizes it. Anything
 * else, including a bare `approve`, is an ordinary question for the model.
 */
function approvalCommand(text: string): ApprovalCommand | null {
  const match = /^\s*(approve|reject)\s+(\S+)\s*$/i.exec(text);
  if (!match?.[1] || !match[2]) return null;
  return { decision: match[1].toLowerCase() === "approve" ? "approve" : "reject", shortId: match[2] };
}

/**
 * What the owner is told back. A decided action is named by its canonical short
 * id and its own summary — the sentence written when it was staged — and a
 * reference that decided nothing says so, rather than answering the question
 * with a model that cannot see the action queue.
 */
function decisionReply(command: ApprovalCommand, result: ActionDecision): string {
  if ("kind" in result) {
    return result.kind === "not_found"
      ? `No staged action matches ${normalizeShortId(command.shortId)}.`
      : `${normalizeShortId(command.shortId)} has already been decided.`;
  }
  return `${command.decision === "approve" ? "Approved" : "Rejected"} ${result.shortId}: ${result.summary}`;
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
  const authorizedJids = authorizedJidsOf(organization?.config?.autoReplyAuthorizedJids);
  if (authorizedJids.length === 0) return NextResponse.json({ error: "automatic replies are disabled" }, { status: 503 });

  // The chat the answer goes back to, and therefore the question this job is
  // asked before anything else: a group job must name a group this instance is
  // assigned and whitelisted for, while a direct one has no group at all — the
  // owner list below is its entire gate.
  const chatKind: ChatKind = body.isGroup === false ? "user" : "group";
  if (chatKind === "group") {
    const group = await db.collection(COLLECTIONS.groups).findOne(
      { organizationId: body.organizationId, instanceId: body.instanceId, groupJid: body.groupJid },
      { projection: { _id: 0, "config.assigned": 1, "config.whitelisted": 1 } },
    );
    if (group?.config?.assigned !== true || group.config.whitelisted !== true) {
      return NextResponse.json({ error: "group is not eligible for automatic replies" }, { status: 409 });
    }
  }

  const message = await db.collection(COLLECTIONS.messages).findOne<{ senderJid?: string; text?: string }>(
    { organizationId: body.organizationId, instanceId: body.instanceId, groupJid: body.groupJid, waMessageId: body.waMessageId, fromMe: false },
    { projection: { _id: 0, senderJid: 1, text: 1 } },
  );
  // The canonical sender: the same JID form the owner list holds, which is what
  // `decideAction` records as the decider of a command from this chat.
  const ownerJid = normalizeAuthorizedJid(message?.senderJid ?? "") ?? "";
  if (!message || !authorizedJids.includes(ownerJid) || !message.text?.trim()) {
    return NextResponse.json({ error: "authorized mention source was not found" }, { status: 404 });
  }

  // The recent conversation, newest-first so the window keeps what just happened.
  // An attachment-only message is part of that conversation even though it has no
  // text: it is selected and described, never dropped, because a reply that
  // cannot see the file it was asked about is the wrong answer.
  const history = await db
    .collection<{
      waMessageId?: string;
      senderJid?: string;
      pushName?: string;
      text?: string;
      timestamp?: Date;
      media?: { status?: string; kind?: string; fileName?: string | null };
    }>(COLLECTIONS.messages)
    .find(
      {
        organizationId: body.organizationId,
        instanceId: body.instanceId,
        groupJid: body.groupJid,
        $or: [
          { text: { $type: "string", $ne: "" } },
          { "media.kind": { $type: "string", $ne: "" } },
        ],
      },
      {
        projection: {
          _id: 0,
          waMessageId: 1,
          senderJid: 1,
          pushName: 1,
          text: 1,
          timestamp: 1,
          "media.kind": 1,
          "media.fileName": 1,
        },
      },
    )
    .sort({ timestamp: -1 })
    .limit(20)
    .toArray();
  // What the assistant itself said is not in `messages`: an outgoing message is a
  // send row, and the capture only ever writes what arrives. Left out, the model
  // reads a monologue of the owner's requests with no record of its own answers —
  // it cannot follow "and check that" or "the group I asked about", because from
  // where it sits nothing was ever said back. So the window is the chat's inbound
  // messages merged with the sends that actually went out, read together in the
  // order they happened.
  const said = await db
    .collection<{ text?: string; scheduledFor?: Date; createdAt?: Date }>(COLLECTIONS.sendRequests)
    .find(
      { organizationId: body.organizationId, instanceId: body.instanceId, groupJid: body.groupJid, status: "sent" },
      { projection: { _id: 0, text: 1, scheduledFor: 1, createdAt: 1 } },
    )
    .sort({ scheduledFor: -1 })
    .limit(20)
    .toArray();
  // Both sides, in the order they happened: what arrived, and what the assistant
  // said back. The window is the newest twenty lines of that conversation, taken
  // after the merge rather than from each source separately — otherwise a chat
  // where the assistant answered everything would carry twenty incoming messages
  // and not one of its own answers.
  type IncomingLine = {
    senderJid: string;
    senderName: string | null;
    text: string;
    waMessageId: string | null;
    kind: string | null;
    fileName: string | null;
  };
  const merged: ({ at: Date; incoming: IncomingLine } | { at: Date; outgoing: string })[] = [];
  for (const row of history) {
    if (row.timestamp instanceof Date && typeof row.senderJid === "string") {
      merged.push({
        at: row.timestamp,
        incoming: {
          senderJid: row.senderJid,
          senderName: typeof row.pushName === "string" && row.pushName.trim() !== "" ? row.pushName : null,
          text: typeof row.text === "string" ? row.text : "",
          waMessageId: typeof row.waMessageId === "string" ? row.waMessageId : null,
          kind: typeof row.media?.kind === "string" && row.media.kind !== "" ? row.media.kind : null,
          fileName: row.media?.fileName ?? null,
        },
      });
    }
  }
  for (const row of said) {
    const at = row.scheduledFor ?? row.createdAt;
    // An outgoing message is a line the assistant said, and only text is stored:
    // there is nothing in the send table to read an attachment from.
    if (at instanceof Date && typeof row.text === "string" && row.text !== "") {
      merged.push({ at, outgoing: row.text });
    }
  }
  merged.sort((left, right) => right.at.getTime() - left.at.getTime());

  // The prompt reads oldest-first, because a conversation is read in the order it
  // happened.
  const contextMessages: ReplyContextMessage[] = merged
    .slice(0, 20)
    .reverse()
    .map((entry) =>
      "outgoing" in entry
        ? {
            senderJid: body.groupJid,
            senderName: "Assistant",
            text: entry.outgoing,
            timestamp: entry.at,
            waMessageId: null,
            attachment: null,
          }
        : {
            senderJid: entry.incoming.senderJid,
            // The name the group sees, when WhatsApp told us one.
            senderName: entry.incoming.senderName,
            text: entry.incoming.text,
            timestamp: entry.at,
            // Named so the reply can read it: a media tool is addressed by message id.
            waMessageId: entry.incoming.waMessageId,
            attachment:
              entry.incoming.kind === null ? null : { kind: entry.incoming.kind, fileName: entry.incoming.fileName },
          },
    );

  const scope = { organizationId: body.organizationId, instanceId: body.instanceId, groupJid: body.groupJid, waMessageId: body.waMessageId };
  // The key names the chat too: the send table is unique on
  // `{organizationId, idempotencyKey}`, so one instance's identical message id in
  // two chats must not collapse into one send.
  const idempotencyKey = agentReplyIdempotencyKey(scope);
  const replay = (send: unknown) => NextResponse.json({ send, replay: true }, { status: 200, headers: { "cache-control": "no-store" } });
  const accepted = () => NextResponse.json({ status: "accepted" }, { status: 202, headers: { "cache-control": "no-store" } });

  // Reconcile before any fresh model call: if this job already has a send, an
  // ambiguous earlier completion is finalised here and replayed, never re-run.
  const existing = await reconcileAgentReplySend(db, scope, idempotencyKey);
  if (existing) return replay(existing);

  const claim = await claimAgentReplyRun(db, scope);
  if (claim.kind === "completed") {
    const send = await reconcileAgentReplySend(db, scope, idempotencyKey);
    if (!send) return NextResponse.json({ error: "completed reply run has no send" }, { status: 500 });
    return replay(send);
  }
  if (claim.kind === "live") return accepted();
  if (claim.kind === "dead") return NextResponse.json({ error: "automatic reply run is dead" }, { status: 502 });
  const { run, token } = claim;

  /**
   * Closes the claimed run with one automatic send addressed to this job's own
   * chat, in the same lease-guarded transaction the model answer uses. The
   * command acknowledgement and the generated reply differ only in the text and
   * in the memory provenance they carry.
   */
  const completeWithSend = async (text: string, memory: { batchIds: ObjectId[]; factIds: ObjectId[] }): Promise<NextResponse> => {
    try {
      const completed = await createAutomaticSendUnderRunLease(db, {
        runId: run._id,
        leaseToken: token,
        organizationId: body.organizationId,
        instanceId: body.instanceId,
        groupJid: body.groupJid,
        chatKind,
        waMessageId: body.waMessageId,
        text,
        idempotencyKey,
        replyToMessageId: body.waMessageId,
        memoryBatchIds: memory.batchIds,
        memoryFactIds: memory.factIds,
      });
      if (completed.kind === "completed") return NextResponse.json({ send: completed.send }, { status: 201, headers: { "cache-control": "no-store" } });
      // The lease expired or was reclaimed: no send was created by this holder.
      const reconciled = await reconcileAgentReplySend(db, scope, idempotencyKey);
      return reconciled ? replay(reconciled) : accepted();
    } catch (error) {
      console.error("automatic reply send creation failed", error);
      // An ambiguous commit may have created the send; reconcile before treating
      // it as failed so a retry never produces a second send or model call.
      const reconciled = await reconcileAgentReplySend(db, scope, idempotencyKey);
      if (reconciled) return replay(reconciled);
      await failAgentReplyRun(db, run, token, { code: "completion_ambiguous", terminal: false });
      return NextResponse.json({ error: "automatic reply generation failed" }, { status: 502 });
    }
  };

  // A direct chat carries commands as well as questions. An approval is decided
  // here and answered from the action's own row, so the model is never asked
  // what happened to an action it cannot see — and a reference that decided
  // nothing is answered honestly for the same reason.
  if (chatKind === "user") {
    const command = approvalCommand(message.text);
    if (command) {
      const decision = await decideAction(db, {
        organizationId: body.organizationId,
        shortId: command.shortId,
        decision: command.decision,
        decidedBy: ownerJid,
        // Where the decision arrived from: a forwarded direct message.
        ip: "worker",
      });
      return completeWithSend(decisionReply(command, decision), { batchIds: [], factIds: [] });
    }
  }

  // A request whose size cannot be counted is never sent. AI_TOKENIZER must name
  // a counter *this process has registered*: the bundled one is registered at
  // startup (`instrumentation.ts` → `server/memory/tokenizer.ts`), and being an
  // `upper_bound` with a multiplier is what lets it be selected at all. An
  // unset, unknown, or foreign id keeps automatic replies fail-closed here,
  // before recall and before any provider call.
  const counter = selectTokenCounter({ tokenizer: replyModelConfig()?.tokenizer });
  if (!counter) {
    await failAgentReplyRun(db, run, token, { code: "token_counter_unavailable", terminal: true });
    return NextResponse.json(
      { error: "automatic replies require a token counter registered for AI_TOKENIZER; none is available for this model" },
      { status: 502 },
    );
  }

  // The lease is asserted again immediately before recall: if another holder
  // reclaimed the run, this callback stops without recalling or generating.
  if ((await renewAgentReplyLease(db, run, token)).kind === "lost") return accepted();

  const recall = await recallMemory(db, scope, message.text);
  const assembled = assembleReplyPrompt({
    counter,
    chatKind,
    currentRequest: message.text,
    messages: contextMessages,
    recall,
  });
  if (!assembled.ok) {
    await failAgentReplyRun(db, run, token, { code: assembled.code, terminal: true });
    return NextResponse.json({ error: "automatic reply prompt exceeded the token ceiling" }, { status: 502 });
  }

  if ((await renewAgentReplyLease(db, run, token)).kind === "lost") return accepted();

  // The reply job's verified identity, and nothing the model can name: the media
  // tools are bound to exactly this tenant, instance, group, and owner set.
  // The chat the tools may act on. `body.groupJid` is the chat in both shapes:
  // the group for a group job, the owner's own JID for a direct one. Only a
  // group job has a group to act on, so a direct chat gets `groupJid: null` and
  // its group tools must name a monitored group explicitly.
  const chatContext: ToolChatContext = {
    organizationId: body.organizationId,
    instanceId: body.instanceId,
    chatKind,
    chatJid: body.groupJid,
    groupJid: chatKind === "group" ? body.groupJid : null,
    authorizedJids,
  };
  // Every absolute URL that literally occurs in the scoped evidence — the
  // assembled prompt is that evidence — is what an answer may cite. Media tool
  // results add their own as they return, so the model can reuse a link the
  // group itself supplied and never one it invented.
  const sourceLinks = sourceLinksOf([assembled.system, assembled.prompt]);

  const startedAt = Date.now();
  let reply: GeneratedReply | null = null;
  let rejection: WhatsAppOutputCode | null = null;
  let generationError: unknown = null;
  let leaseLost = false;
  const abort = new AbortController();
  // A bounded heartbeat keeps the lease live for the whole model call and
  // aborts it the moment another callback owns the run.
  const heartbeat = setInterval(() => {
    void renewAgentReplyLease(db, run, token)
      .then((renewed) => {
        if (renewed.kind === "lost") {
          leaseLost = true;
          abort.abort();
        }
      })
      .catch(() => {});
  }, AGENT_REPLY_HEARTBEAT_MS);
  // The in-process MCP sessions live exactly as long as one model call and are
  // always closed, whether the model answered, the provider failed, or the
  // lease was reclaimed mid-flight.
  let closeMedia: (() => Promise<void>) | null = null;
  let closeGroups: (() => Promise<void>) | null = null;
  try {
    // Both families spend one allowance: the reads, the stages and the media
    // reads of one reply share the reserve the prompt already accounted for, so
    // whatever a tool loop appends to the next model call stays inside the 180k
    // ceiling.
    const budget = tokenResultBudget(counter);
    const media = await connectMediaTools(chatContext);
    closeMedia = media.close;
    const tools: ToolSet = { ...(await mediaToolSet(media.client, sourceLinks, budget)) };
    // Group maintenance is offered in both shapes: a group job already knows its
    // group, and in a direct chat the owner can name one of the instance's
    // monitored groups, which the tool resolves before it acts.
    const groups = await connectGroupTools(chatContext);
    closeGroups = groups.close;
    Object.assign(tools, await groupToolSet(groups.client, sourceLinks, budget));
    const generated = await generateGroupReply({
      system: assembled.system,
      prompt: assembled.prompt,
      tools,
      sourceLinks,
      abortSignal: abort.signal,
    });
    if (generated.kind === "ok") reply = generated.reply;
    else rejection = generated.code;
  } catch (error) {
    generationError = error;
    console.error("automatic reply generation failed", error);
  } finally {
    await closeGroups?.();
    await closeMedia?.();
    clearInterval(heartbeat);
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
    status: reply !== null || rejection !== null ? "ok" : "error",
    latencyMs: Date.now() - startedAt,
    usage: reply?.usage ?? NO_TOKEN_USAGE,
    createdAt: new Date(),
  });
  // A reclaimed run is not this holder's to fail or to send for; a later
  // callback reconciles it.
  if (leaseLost) return accepted();
  if (rejection) {
    // The deterministic gate refused the model's output, so no automatic send is
    // created from it. The refusal is audited as `reply.output.rejected` and a
    // fixed, server-authored apology is queued for human approval inside the
    // same run-lease transaction — no wider a boundary than the automatic path.
    try {
      const review = await createHumanReviewSendUnderRunLease(db, {
        runId: run._id,
        leaseToken: token,
        organizationId: body.organizationId,
        instanceId: body.instanceId,
        groupJid: body.groupJid,
        chatKind,
        waMessageId: body.waMessageId,
        idempotencyKey,
        replyToMessageId: body.waMessageId,
        reason: rejection,
      });
      if (review.kind === "completed") {
        return NextResponse.json({ send: review.send, review: true }, { status: 200, headers: { "cache-control": "no-store" } });
      }
      // The lease expired or was reclaimed: this holder created nothing.
      const reconciled = await reconcileAgentReplySend(db, scope, idempotencyKey);
      return reconciled ? replay(reconciled) : accepted();
    } catch (error) {
      console.error("human-review send creation failed", error);
      // An ambiguous commit may have created the send; reconcile before treating
      // it as failed so a retry never produces a second send or model call.
      const reconciled = await reconcileAgentReplySend(db, scope, idempotencyKey);
      if (reconciled) return replay(reconciled);
      await failAgentReplyRun(db, run, token, { code: "completion_ambiguous", terminal: false });
      return NextResponse.json({ error: "automatic reply generation failed" }, { status: 502 });
    }
  }
  if (!reply) {
    await failAgentReplyRun(db, run, token, generationError ? classifyReplyFailure(generationError) : { code: "model_unavailable", terminal: false });
    return NextResponse.json({ error: "automatic reply generation failed" }, { status: 502 });
  }

  return completeWithSend(reply.text, {
    batchIds: assembled.provenance.batchIds.map((id) => new ObjectId(id)),
    factIds: assembled.provenance.factIds.map((id) => new ObjectId(id)),
  });
}
