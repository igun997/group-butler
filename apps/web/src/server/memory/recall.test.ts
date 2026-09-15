import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import { COLLECTIONS } from "../collections";
import { createIndexes } from "../bootstrap";
import { closeDb, getDb } from "../mongo";
import {
  accountTokens,
  AGENT_REPLY_MAX_ATTEMPTS,
  agentReplyIdempotencyKey,
  agentReplyRetryDelayMs,
  assembleReplyPrompt,
  BYTE_UPPER_BOUND_COUNTER,
  BYTE_UPPER_BOUND_COUNTER_ID,
  claimAgentReplyRun,
  classifyReplyFailure,
  clipToTokens,
  factSearchTerms,
  failAgentReplyRun,
  normalizeFactText,
  recallMemory,
  reconcileAgentReplySend,
  registerTokenCounter,
  renewAgentReplyLease,
  REPLY_OUTPUT_RESERVE_TOKENS,
  REPLY_PROMPT_CEILING,
  REPLY_SEGMENT_MAX,
  REPLY_STRUCTURAL_RESERVE_TOKENS,
  REPLY_TOOL_LOOP_HISTORY_RESERVE_TOKENS,
  REPLY_TOOL_RESERVE_TOKENS,
  REPLY_TOOL_RESULT_RESERVE_TOKENS,
  selectTokenCounter,
  type MemoryFactKind,
  type RecallScope,
  type TokenCounter,
} from "./recall";

let replSet: MongoMemoryReplSet;

const scope: RecallScope = { organizationId: "org-a", instanceId: "inst-a", groupJid: "group-a@g.us" };
const sameInstanceOtherGroup: RecallScope = { ...scope, groupJid: "group-z@g.us" };
const foreignScope: RecallScope = { organizationId: "org-b", instanceId: "inst-b", groupJid: "group-b@g.us" };
/** The key the reply route derives for `scope`'s own owner mention. */
const mentionKey = agentReplyIdempotencyKey({ ...scope, waMessageId: "m1" });
const now = new Date("2026-09-15T00:00:00Z");
const days = (count: number) => new Date(now.getTime() - count * 24 * 60 * 60 * 1000);

async function insertFact(
  target: RecallScope,
  input: {
    kind: MemoryFactKind;
    text: string;
    occurredAt: Date | null;
    batchId?: ObjectId;
    confidence?: "stated" | "inferred";
    sourceWaMessageIds?: string[];
  },
): Promise<{ id: ObjectId; batchId: ObjectId }> {
  const db = await getDb();
  const batchId = input.batchId ?? new ObjectId();
  const inserted = await db.collection(COLLECTIONS.memoryFacts).insertOne({
    ...target,
    batchId,
    summaryId: new ObjectId(),
    kind: input.kind,
    text: input.text,
    textSearch: normalizeFactText(input.text),
    subject: null,
    confidence: input.confidence ?? "stated",
    occurredAt: input.occurredAt,
    sourceWaMessageIds: input.sourceWaMessageIds ?? ["m1"],
    createdAt: input.occurredAt ?? now,
  });
  return { id: inserted.insertedId, batchId };
}

async function insertSummary(target: RecallScope, batchId: ObjectId, to: Date, summary: string): Promise<ObjectId> {
  const db = await getDb();
  const inserted = await db.collection(COLLECTIONS.memorySummaries).insertOne({
    ...target,
    batchId,
    schemaVersion: 1,
    period: { from: new Date(to.getTime() - 60_000), to },
    source: { count: 2, messageIds: ["m1", "m2"] },
    summary,
    topics: ["deployment"],
    decisions: [],
    commitments: [],
    openQuestions: [],
    actionItems: [],
    safety: { containsUntrustedInstructions: false, redactions: 0 },
    createdAt: to,
  });
  return inserted.insertedId;
}

async function insertSend(organizationId: string) {
  const db = await getDb();
  const _id = new ObjectId();
  await db.collection(COLLECTIONS.sendRequests).insertOne({
    _id,
    id: "send-1",
    organizationId,
    instanceId: "inst-a",
    groupJid: "group-a@g.us",
    text: "reply",
    idempotencyKey: mentionKey,
    status: "approved",
    scheduledFor: now,
    approval: { state: "approved", approvedBy: "owner", approvedAt: now },
    provenance: { source: "owner_mention", replyToMessageId: "m1" },
    dispatch: { attempts: 0, lockedAt: null, lockedBy: null, waMessageId: null, errorClass: null },
    createdAt: now,
    updatedAt: now,
  });
  return _id;
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGODB_URI = replSet.getUri();
  process.env.MONGODB_DB = "memory_recall_test";
  await closeDb();
  await createIndexes(await getDb());
});
beforeEach(async () => {
  const db = await getDb();
  await Promise.all(
    [COLLECTIONS.memorySummaries, COLLECTIONS.memoryFacts, COLLECTIONS.agentReplyRuns, COLLECTIONS.sendRequests, COLLECTIONS.messages].map((name) =>
      db.collection(name).deleteMany({}),
    ),
  );
});
afterAll(async () => {
  await closeDb();
  await replSet.stop();
});

describe("scoped recall", () => {
  test("returns only the target tenant, instance, and group", async () => {
    const db = await getDb();
    const batchId = new ObjectId();
    await insertFact(scope, { kind: "decision", text: "Deploy Friday", occurredAt: days(1), batchId, sourceWaMessageIds: ["m1"] });
    await insertSummary(scope, batchId, days(1), "Deployment agreed.");
    await insertFact(sameInstanceOtherGroup, { kind: "decision", text: "Deploy Friday", occurredAt: days(1) });
    await insertSummary(sameInstanceOtherGroup, new ObjectId(), days(1), "Deployment agreed.");
    await insertFact(foreignScope, { kind: "decision", text: "Deploy Friday", occurredAt: days(1) });
    await insertSummary(foreignScope, new ObjectId(), days(1), "Deployment agreed.");

    const recalled = await recallMemory(db, scope, "deploy friday", now);

    expect(recalled.summaries).toHaveLength(1);
    expect(recalled.summaries[0]).toMatchObject({ batchId: batchId.toHexString(), sourceWaMessageIds: ["m1", "m2"] });
    expect(recalled.facts).toHaveLength(1);
    expect(recalled.facts[0]).toMatchObject({ batchId: batchId.toHexString(), text: "Deploy Friday", sourceWaMessageIds: ["m1"] });
  });

  test("recalls the most recent summaries newest first, capped at eight", async () => {
    const db = await getDb();
    for (let index = 0; index < 10; index += 1) {
      await insertSummary(scope, new ObjectId(), days(index), `Summary ${index}`);
    }

    const recalled = await recallMemory(db, scope, "?!?", now);

    expect(recalled.summaries).toHaveLength(8);
    expect(recalled.summaries.map((summary) => summary.summary)).toEqual([
      "Summary 0", "Summary 1", "Summary 2", "Summary 3", "Summary 4", "Summary 5", "Summary 6", "Summary 7",
    ]);
  });

  test("ranks by the documented formula deterministically", async () => {
    const db = await getDb();
    await insertFact(scope, { kind: "decision", text: "Decision now", occurredAt: now });
    await insertFact(scope, { kind: "action_item", text: "Action half window", occurredAt: days(15) });
    await insertFact(scope, { kind: "fact", text: "Stale fact", occurredAt: days(90) });

    const recalled = await recallMemory(db, scope, "?!?", now);

    expect(recalled.facts.map((fact) => fact.text)).toEqual(["Decision now", "Action half window", "Stale fact"]);
    expect(recalled.facts[0]!.score).toBeCloseTo(0.25 + 0.2, 6);
    expect(recalled.facts[1]!.score).toBeCloseTo(0.5 * 0.25 + 0.7 * 0.2, 6);
    expect(recalled.facts[2]!.score).toBeCloseTo(0.5 * 0.2, 6);
  });

  test("a text match outranks a merely recent fact", async () => {
    const db = await getDb();
    const matched = await insertFact(scope, { kind: "fact", text: "Deploy Friday", occurredAt: days(90) });
    await insertFact(scope, { kind: "decision", text: "Unrelated decision", occurredAt: now });

    const recalled = await recallMemory(db, scope, "deploy friday", now);

    expect(recalled.facts[0]!.factId).toBe(matched.id.toHexString());
    expect(recalled.facts[0]!.textScore).toBeGreaterThan(0);
    expect(recalled.facts[1]!.textScore).toBe(0);
  });

  test("deduplicates by fact id and then by normalized text", async () => {
    const db = await getDb();
    await insertFact(scope, { kind: "commitment", text: "Deploy   Friday", occurredAt: now });
    await insertFact(scope, { kind: "commitment", text: "deploy friday", occurredAt: now });

    const recalled = await recallMemory(db, scope, "deploy friday", now);

    expect(recalled.facts).toHaveLength(1);
    expect(normalizeFactText(recalled.facts[0]!.text)).toBe("deploy friday");
  });

  test("no relevant memory is a valid, empty result", async () => {
    const db = await getDb();
    await expect(recallMemory(db, scope, "nothing matches this at all", now)).resolves.toEqual({ summaries: [], facts: [] });
  });

  test("strips search operators from the owner request", () => {
    expect(factSearchTerms('"deploy" -friday +x a')).toBe("deploy friday");
    expect(factSearchTerms("?!?")).toBe("");
  });
});

describe("reply prompt assembly", () => {
  const message = (text: string, minutes: number) => ({
    senderJid: "628990000002@s.whatsapp.net",
    text,
    timestamp: new Date(now.getTime() + minutes * 60_000),
  });

  test("accounts conservatively by UTF-8 byte length", () => {
    expect(accountTokens("hello")).toBe(5);
    expect(accountTokens("é")).toBe(2);
    expect(accountTokens("😀")).toBe(4);
  });

  test("truncates tool results before any recall content", () => {
    const assembled = assembleReplyPrompt({
      counter: BYTE_UPPER_BOUND_COUNTER,
      chatKind: "group",
      currentRequest: "@butler status?",
      messages: [message("deploy finished", -5), message("@butler status?", 0)],
      recall: {
        summaries: [{ summaryId: "s1", batchId: "b1", period: { from: days(1), to: now }, summary: "Deployment agreed.", topics: [], sourceWaMessageIds: ["m1"] }],
        facts: [{ factId: "f1", batchId: "b1", kind: "decision", text: "Deploy Friday", subject: null, confidence: "stated", occurredAt: now, createdAt: now, sourceWaMessageIds: ["m1"], textScore: 1, score: 1 }],
      },
      toolResults: Array.from({ length: 5 }, (_, index) => ({ name: `media_${index}`, content: "x".repeat(100_000) })),
    });

    if (!assembled.ok) throw new Error("expected assembly to succeed");
    expect(assembled.truncated.tools).toBe(true);
    expect(assembled.dropped.tools).toBe(5);
    expect(assembled.included.facts).toBe(1);
    expect(assembled.included.summaries).toBe(1);
    expect(assembled.included.messages).toBe(2);
    expect(assembled.accountedTokens).toBeLessThanOrEqual(REPLY_PROMPT_CEILING);
  });

  test("clips the request to its cap, trims every segment, and stays under the ceiling", () => {
    const assembled = assembleReplyPrompt({
      counter: BYTE_UPPER_BOUND_COUNTER,
      chatKind: "group",
      currentRequest: "r".repeat(REPLY_SEGMENT_MAX.request + 10_000),
      messages: Array.from({ length: 40 }, (_, index) => message("m".repeat(1_000), index)),
      recall: {
        summaries: Array.from({ length: 20 }, (_, index) => ({
          summaryId: `s${index}`,
          batchId: "b1",
          period: { from: days(index + 1), to: days(index) },
          summary: "y".repeat(2_000),
          topics: [],
          sourceWaMessageIds: ["m1"],
        })),
        facts: Array.from({ length: 40 }, (_, index) => ({
          factId: `f${index}`,
          batchId: "b1",
          kind: "fact" as const,
          text: "z".repeat(1_000),
          subject: null,
          confidence: "stated" as const,
          occurredAt: now,
          createdAt: now,
          sourceWaMessageIds: ["m1"],
          textScore: 0,
          score: 0,
        })),
      },
      toolResults: [{ name: "media_0", content: "t".repeat(REPLY_SEGMENT_MAX.tools + 5_000) }],
    });

    if (!assembled.ok) throw new Error("expected assembly to succeed");
    // The system prompt is the assembler's own per-chat constant, so what can
    // exceed its cap here is the request and each content segment.
    expect(assembled.truncated).toEqual({ system: false, request: true, messages: true, summaries: true, facts: true, tools: true });
    expect(accountTokens(assembled.system)).toBeLessThanOrEqual(REPLY_SEGMENT_MAX.system);
    expect(assembled.prompt).toContain("r".repeat(REPLY_SEGMENT_MAX.request));
    expect(assembled.dropped.tools).toBe(1);
    expect(assembled.dropped.messages).toBeGreaterThan(0);
    expect(assembled.dropped.summaries).toBeGreaterThan(0);
    expect(assembled.dropped.facts).toBeGreaterThan(0);
    expect(assembled.accountedTokens).toBeLessThanOrEqual(REPLY_PROMPT_CEILING);
  });

  test("writes a direct-chat prompt for a direct-chat job", () => {
    const assembled = assembleReplyPrompt({
      counter: BYTE_UPPER_BOUND_COUNTER,
      chatKind: "user",
      currentRequest: "what is the status?",
      messages: [],
      recall: { summaries: [], facts: [] },
    });

    if (!assembled.ok) throw new Error("expected assembly to succeed");
    expect(assembled.system).toContain("butler");
    // The chat is one-to-one. It may work on the groups the instance monitors —
    // listing them, reading one, changing one — but those are groups it names,
    // never the chat it is speaking in, and it is never addressed as the group's
    // butler while it is talking to the owner alone.
    expect(assembled.system).toContain("one-to-one");
    expect(assembled.system).not.toContain("You are the group's butler");
    expect(assembled.system).toContain("every call names the group it is about");
    // And it is told what it may do by itself, so it cannot promise an approval
    // queue for a change it is allowed to make.
    expect(assembled.system).toContain("yours to make");
    expect(assembled.system).toContain("are proposals");
  });

  test("shows each speaker as a name or plain digits, never as a raw identifier", () => {
    const assembled = assembleReplyPrompt({
      counter: BYTE_UPPER_BOUND_COUNTER,
      chatKind: "group",
      currentRequest: "@butler status?",
      messages: [
        { senderJid: "628990000002:5@s.whatsapp.net", senderName: "Fajar", text: "deploy sudah selesai", timestamp: new Date("2026-09-15T08:20:00Z") },
        { senderJid: "239959873196218:67@lid", text: "terima kasih", timestamp: new Date("2026-09-15T08:21:00Z") },
      ],
      recall: { summaries: [], facts: [] },
    });

    if (!assembled.ok) throw new Error("expected assembly to succeed");
    // The name is shown when one is known; otherwise the digits alone.
    expect(assembled.prompt).toContain("Fajar: deploy sudah selesai");
    expect(assembled.prompt).toContain("239959873196218: terima kasih");
    // A reader gets a date, not the instant the capture stored.
    expect(assembled.prompt).toContain("15 Sept 2026, 08:20");
    expect(assembled.prompt).not.toContain("2026-09-15T08:20:00.000Z");
    // Neither device suffix nor either addressing domain reaches the model.
    expect(assembled.prompt).not.toContain("628990000002:5");
    expect(assembled.prompt).not.toContain("239959873196218:67");
    expect(assembled.prompt).not.toContain("@lid");
    expect(assembled.prompt).not.toContain("@s.whatsapp.net");
  });

  test("says what kind of attachment a message carries, and that it can be read", () => {
    const assembled = assembleReplyPrompt({
      counter: BYTE_UPPER_BOUND_COUNTER,
      chatKind: "user",
      currentRequest: "apa isi lampiran itu?",
      messages: [
        {
          senderJid: "628990000001@s.whatsapp.net",
          senderName: "Owner",
          text: "laporan minggu ini",
          timestamp: now,
          attachment: { kind: "document", fileName: "laporan.csv" },
        },
      ],
      recall: { summaries: [], facts: [] },
    });

    if (!assembled.ok) throw new Error("expected assembly to succeed");
    expect(assembled.prompt).toContain("document");
    expect(assembled.prompt).toContain("laporan.csv");
    expect(assembled.prompt).toContain("read with the media tools");
  });

  test("carries the language, name, and attachment rules in both prompts", () => {
    for (const chatKind of ["group", "user"] as const) {
      const assembled = assembleReplyPrompt({
        counter: BYTE_UPPER_BOUND_COUNTER,
        chatKind,
        currentRequest: "status?",
        messages: [],
        recall: { summaries: [], facts: [] },
      });

      if (!assembled.ok) throw new Error("expected assembly to succeed");
      expect(assembled.system).toMatch(/answer in the language the owner wrote to you in/i);
      expect(assembled.system).toMatch(/never print an internal WhatsApp identifier/i);
      expect(assembled.system).toMatch(/never say you cannot see or read an attachment/i);
    }
  });

  test("carries no raw WhatsApp identifier anywhere for a realistic request", () => {
    const assembled = assembleReplyPrompt({
      counter: BYTE_UPPER_BOUND_COUNTER,
      chatKind: "group",
      currentRequest: "@1730922213397 tolong rangkum percakapan ini",
      messages: [
        {
          senderJid: "120363043000000000@g.us",
          senderName: "Fajar",
          text: "deploy sudah selesai",
          timestamp: new Date("2026-09-15T08:20:58Z"),
          attachment: { kind: "image" },
        },
        { senderJid: "239959873196218:67@lid", text: "kirim laporannya", timestamp: new Date("2026-09-15T08:21:30Z") },
        { senderJid: "628990000002:5@s.whatsapp.net", text: "baik", timestamp: new Date("2026-09-15T08:22:00Z") },
      ],
      recall: {
        summaries: [{ summaryId: "s1", batchId: "b1", period: { from: days(1), to: now }, summary: "Deployment agreed.", topics: [], sourceWaMessageIds: ["m1"] }],
        facts: [{ factId: "f1", batchId: "b1", kind: "decision", text: "Deploy Friday", subject: null, confidence: "stated", occurredAt: now, createdAt: now, sourceWaMessageIds: ["m1"], textScore: 1, score: 1 }],
      },
      toolResults: [{ name: "media_get_image", content: "image/jpeg" }],
    });

    if (!assembled.ok) throw new Error("expected assembly to succeed");
    const everything = `${assembled.system}\n${assembled.prompt}`;
    expect(everything).not.toContain("@lid");
    expect(everything).not.toContain("@s.whatsapp.net");
    expect(everything).not.toContain("@g.us");
  });

  test("accounts the tool-loop follow-up history with every other reserve inside the ceiling", () => {
    expect(REPLY_OUTPUT_RESERVE_TOKENS).toBe(16_000);
    expect(REPLY_TOOL_RESERVE_TOKENS).toBe(8_000);
    expect(REPLY_TOOL_RESULT_RESERVE_TOKENS).toBe(32_000);
    expect(REPLY_STRUCTURAL_RESERVE_TOKENS).toBe(15_000);
    // One full output per step of the tool loop: a loop that uses all three steps
    // leaves three assistant turns in the closing request.
    expect(REPLY_TOOL_LOOP_HISTORY_RESERVE_TOKENS).toBe(48_000);
    const assembled = assembleReplyPrompt({
      counter: BYTE_UPPER_BOUND_COUNTER,
      chatKind: "group",
      currentRequest: "@butler status?",
      messages: [],
      recall: { summaries: [], facts: [] },
    });

    if (!assembled.ok) throw new Error("expected assembly to succeed");
    expect(assembled.tokenizerId).toBe(BYTE_UPPER_BOUND_COUNTER_ID);
    expect(assembled.reserveTokens).toBe(119_000);
    expect(assembled.accountedTokens).toBe(assembled.inputTokens + assembled.reserveTokens);
    expect(assembled.accountedTokens).toBeLessThanOrEqual(REPLY_PROMPT_CEILING);
  });

  /**
   * The largest request the provider can be shown includes the original prompt,
   * the tool schemas, the aggregate tool results, every generation the loop made,
   * and the answer it is being asked for. This bound uses only declared reserves,
   * never provider-reported usage.
   */
  test("reserves the worst possible tool-loop follow-up under the ceiling", () => {
    const contentAtMaximum =
      REPLY_SEGMENT_MAX.system +
      REPLY_SEGMENT_MAX.request +
      REPLY_SEGMENT_MAX.messages +
      REPLY_SEGMENT_MAX.summaries +
      REPLY_SEGMENT_MAX.facts;
    const worstFollowUp =
      contentAtMaximum +
      REPLY_TOOL_RESERVE_TOKENS +
      REPLY_TOOL_RESULT_RESERVE_TOKENS +
      REPLY_STRUCTURAL_RESERVE_TOKENS +
      REPLY_OUTPUT_RESERVE_TOKENS +
      REPLY_TOOL_LOOP_HISTORY_RESERVE_TOKENS;

    expect(worstFollowUp).toBe(178_000);
    expect(worstFollowUp).toBeLessThanOrEqual(REPLY_PROMPT_CEILING);
  });

  test("reports no relevant saved context when recall is empty", () => {
    const assembled = assembleReplyPrompt({
      counter: BYTE_UPPER_BOUND_COUNTER,
      chatKind: "group",
      currentRequest: "@butler status?",
      messages: [],
      recall: { summaries: [], facts: [] },
    });

    if (!assembled.ok) throw new Error("expected assembly to succeed");
    expect(assembled.hasMemory).toBe(false);
    expect(assembled.prompt).toContain("no relevant saved context");
    expect(assembled.provenance).toEqual({ summaryIds: [], factIds: [], batchIds: [] });
  });

  test("carries compact provenance for every included item", () => {
    const assembled = assembleReplyPrompt({
      counter: BYTE_UPPER_BOUND_COUNTER,
      chatKind: "group",
      currentRequest: "@butler status?",
      messages: [],
      recall: {
        summaries: [{ summaryId: "s1", batchId: "b1", period: { from: days(1), to: now }, summary: "Agreed.", topics: [], sourceWaMessageIds: ["m1"] }],
        facts: [{ factId: "f1", batchId: "b2", kind: "commitment", text: "Deploy Friday", subject: null, confidence: "stated", occurredAt: now, createdAt: now, sourceWaMessageIds: ["m2"], textScore: 1, score: 1 }],
      },
    });

    if (!assembled.ok) throw new Error("expected assembly to succeed");
    expect(assembled.provenance.summaryIds).toEqual(["s1"]);
    expect(assembled.provenance.factIds).toEqual(["f1"]);
    expect(assembled.provenance.batchIds.sort()).toEqual(["b1", "b2"]);
    expect(assembled.prompt).toContain("batch b1");
    expect(assembled.prompt).toContain("source m2");
  });
});

describe("token counter selection", () => {
  test("fails closed when no tokenizer is configured", () => {
    expect(selectTokenCounter({})).toBeNull();
    expect(selectTokenCounter({ tokenizer: "" })).toBeNull();
    expect(selectTokenCounter({ tokenizer: "   " })).toBeNull();
  });

  test("fails closed for a configured tokenizer that no counter implements", () => {
    expect(selectTokenCounter({ tokenizer: "o200k_base" })).toBeNull();
  });

  test("does not select the byte counter implicitly", () => {
    expect(selectTokenCounter({ tokenizer: BYTE_UPPER_BOUND_COUNTER_ID })).toBeNull();
    expect(BYTE_UPPER_BOUND_COUNTER.kind).toBe("upper_bound");
    expect(BYTE_UPPER_BOUND_COUNTER.note).toMatch(/upper bound/i);
    expect(BYTE_UPPER_BOUND_COUNTER.count("hello")).toBe(5);
  });

  test("selects a registered upper-bound counter, whose multiplier is what bounds it", () => {
    registerTokenCounter({ id: "test-upper-bound", kind: "upper_bound", note: "test", count: accountTokens, multiplier: 1.5 });
    const counter = selectTokenCounter({ tokenizer: "test-upper-bound" });
    expect(counter).toMatchObject({ id: "test-upper-bound", kind: "upper_bound", multiplier: 1.5 });
    expect(counter?.count("hello")).toBe(5);
  });

  test("uses a registered exact counter for its configured id", () => {
    registerTokenCounter({ id: "test-exact", kind: "exact", note: "test", count: (value) => Array.from(value).length });
    const counter = selectTokenCounter({ tokenizer: "test-exact" });
    expect(counter).toMatchObject({ id: "test-exact", kind: "exact" });
    expect(counter?.count("abcd")).toBe(4);
  });

  test("scales every accounting figure by the counter's multiplier", () => {
    const exact: TokenCounter = { id: "test-raw", kind: "exact", note: "test", count: (value) => value.length };
    const bound: TokenCounter = { id: "test-doubled", kind: "upper_bound", note: "test", count: (value) => value.length, multiplier: 2 };
    const input = {
      chatKind: "group" as const,
      currentRequest: "@butler status?",
      messages: [],
      recall: { summaries: [], facts: [] },
    };
    const raw = assembleReplyPrompt({ ...input, counter: exact });
    const doubled = assembleReplyPrompt({ ...input, counter: bound });

    if (!raw.ok || !doubled.ok) throw new Error("expected assembly to succeed");
    expect(raw.inputTokens).toBeGreaterThan(0);
    // Nothing is clipped at these sizes, so the multiplier alone explains the gap.
    expect(doubled.inputTokens).toBe(raw.inputTokens * 2);
    // Reserves are already in the counter's unit and are never scaled again.
    expect(doubled.reserveTokens).toBe(raw.reserveTokens);
    expect(doubled.accountedTokens).toBe(doubled.inputTokens + doubled.reserveTokens);
  });

  test("charges clipToTokens in the counter's own accounted unit", () => {
    registerTokenCounter({ id: "test-tripled", kind: "upper_bound", note: "test", count: (value) => value.length, multiplier: 3 });
    const counter = selectTokenCounter({ tokenizer: "test-tripled" });
    if (!counter) throw new Error("expected the counter to be selected");
    expect(clipToTokens(counter, "abcdef", 7)).toEqual({ text: "ab", used: 6, clipped: true });
  });
});

describe("reply run idempotency key", () => {
  const start = { instanceId: "inst-a", groupJid: "group-a@g.us", waMessageId: "m1" };

  test("names the instance, group, and message, and encodes their separators", () => {
    expect(agentReplyIdempotencyKey(start)).toBe("owner-mention:inst-a:group-a%40g.us:m1");
    expect(agentReplyIdempotencyKey({ ...start, waMessageId: "a:b" })).toBe("owner-mention:inst-a:group-a%40g.us:a%3Ab");
  });

  test("keeps the same message id in two groups of one instance distinct", () => {
    const other = agentReplyIdempotencyKey({ ...start, groupJid: "group-z@g.us" });
    expect(other).not.toBe(agentReplyIdempotencyKey(start));
    // A component that merely moved its `:` across a boundary cannot collide.
    expect(agentReplyIdempotencyKey({ instanceId: "a:b", groupJid: "c@g.us", waMessageId: "m" })).not.toBe(
      agentReplyIdempotencyKey({ instanceId: "a", groupJid: "b:c@g.us", waMessageId: "m" }),
    );
  });
});

describe("reply run policy", () => {
  const runScope = { ...scope, waMessageId: "m1" };

  test("claims a fresh two-minute lease once, and reports a live lease", async () => {
    const db = await getDb();
    const first = await claimAgentReplyRun(db, runScope, now);
    expect(first.kind).toBe("claimed");
    if (first.kind !== "claimed") return;
    expect(first.run.attempts).toBe(1);
    expect(first.run.lease?.expiresAt.getTime()).toBe(now.getTime() + 120_000);

    const second = await claimAgentReplyRun(db, runScope, now);
    expect(second.kind).toBe("live");
    expect(second.run.attempts).toBe(1);
    expect(second.run.lease?.token).toBe(first.token);
  });

  test("reclaims an expired lease and never reclaims a dead run", async () => {
    const db = await getDb();
    const first = await claimAgentReplyRun(db, runScope, now);
    if (first.kind !== "claimed") throw new Error("expected claim");

    const reclaimed = await claimAgentReplyRun(db, runScope, new Date(now.getTime() + 121_000));
    expect(reclaimed.kind).toBe("claimed");
    if (reclaimed.kind !== "claimed") return;
    expect(reclaimed.run.attempts).toBe(2);
    expect(reclaimed.token).not.toBe(first.token);

    await failAgentReplyRun(db, reclaimed.run, reclaimed.token, { code: "model_rejected", terminal: true }, now);
    const after = await claimAgentReplyRun(db, runScope, new Date(now.getTime() + 24 * 60 * 60 * 1000));
    expect(after.kind).toBe("dead");
  });

  test("a retryable failure retries only after its deterministic backoff", async () => {
    const db = await getDb();
    const claimed = await claimAgentReplyRun(db, runScope, now);
    if (claimed.kind !== "claimed") throw new Error("expected claim");
    await failAgentReplyRun(db, claimed.run, claimed.token, { code: "provider_503", terminal: false }, now);
    const backoff = agentReplyRetryDelayMs(claimed.run._id, 1);

    const tooEarly = await claimAgentReplyRun(db, runScope, new Date(now.getTime() + backoff - 1_000));
    expect(tooEarly.kind).toBe("live");
    const later = await claimAgentReplyRun(db, runScope, new Date(now.getTime() + backoff + 1_000));
    expect(later.kind).toBe("claimed");
    if (later.kind !== "claimed") return;
    expect(later.run.attempts).toBe(2);
  });

  test("goes dead after five retryable attempts", async () => {
    const db = await getDb();
    const claimed = await claimAgentReplyRun(db, runScope, now);
    if (claimed.kind !== "claimed") throw new Error("expected claim");
    let run = claimed.run;
    let token = claimed.token;
    let at = now;

    for (let attempt = 1; attempt < AGENT_REPLY_MAX_ATTEMPTS; attempt += 1) {
      await failAgentReplyRun(db, run, token, { code: "provider_503", terminal: false }, at);
      at = new Date(at.getTime() + agentReplyRetryDelayMs(run._id, attempt) + 1_000);
      const next = await claimAgentReplyRun(db, runScope, at);
      expect(next.kind).toBe("claimed");
      if (next.kind !== "claimed") throw new Error("expected reclaim");
      run = next.run;
      token = next.token;
    }
    expect(run.attempts).toBe(AGENT_REPLY_MAX_ATTEMPTS);

    await failAgentReplyRun(db, run, token, { code: "provider_503", terminal: false }, at);
    const dead = await claimAgentReplyRun(db, runScope, new Date(at.getTime() + 24 * 60 * 60 * 1000));
    expect(dead.kind).toBe("dead");
  });

  /**
   * A run can only be reclaimed while it has attempts left. A `failed` row that
   * is due but already at the cap is closed atomically instead, so no caller can
   * ever hand it a sixth attempt.
   */
  test("a due failed run at the attempt cap is marked dead, not reclaimed", async () => {
    const db = await getDb();
    await db.collection(COLLECTIONS.agentReplyRuns).insertOne({
      ...runScope,
      state: "failed",
      lease: null,
      attempts: AGENT_REPLY_MAX_ATTEMPTS,
      nextAttemptAt: new Date(now.getTime() - 1_000),
      sendRequestId: null,
      memoryBatchIds: [],
      memoryFactIds: [],
      failure: { code: "provider_503", at: now },
      createdAt: now,
      completedAt: null,
      updatedAt: now,
    });

    const claim = await claimAgentReplyRun(db, runScope, now);

    expect(claim.kind).toBe("dead");
    const run = await db
      .collection<{ state: string; attempts: number; failure: { code: string } | null; lease: unknown }>(COLLECTIONS.agentReplyRuns)
      .findOne({ waMessageId: "m1" });
    expect(run).toMatchObject({ state: "dead", attempts: AGENT_REPLY_MAX_ATTEMPTS, failure: { code: "attempts_exhausted" }, lease: null });
  });

  test("a failed run below the cap is still reclaimed when its backoff is due", async () => {
    const db = await getDb();
    await db.collection(COLLECTIONS.agentReplyRuns).insertOne({
      ...runScope,
      state: "failed",
      lease: null,
      attempts: AGENT_REPLY_MAX_ATTEMPTS - 1,
      nextAttemptAt: new Date(now.getTime() - 1_000),
      sendRequestId: null,
      memoryBatchIds: [],
      memoryFactIds: [],
      failure: { code: "provider_503", at: now },
      createdAt: now,
      completedAt: null,
      updatedAt: now,
    });

    const claim = await claimAgentReplyRun(db, runScope, now);

    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;
    expect(claim.run.attempts).toBe(AGENT_REPLY_MAX_ATTEMPTS);
  });

  /**
   * A holder whose lease has expired has already lost the run: its late failure
   * must not fail the run another callback now owns, nor schedule a backoff for it.
   */
  test("an expired holder cannot fail the run or write a backoff", async () => {
    const db = await getDb();
    const claimed = await claimAgentReplyRun(db, runScope, now);
    if (claimed.kind !== "claimed") throw new Error("expected claim");
    const afterExpiry = new Date(claimed.run.lease!.expiresAt.getTime() + 1_000);

    await failAgentReplyRun(db, claimed.run, claimed.token, { code: "provider_503", terminal: false }, afterExpiry);

    const run = await db
      .collection<{ state: string; nextAttemptAt: Date | null; failure: { code: string } | null; lease: { token: string } | null }>(
        COLLECTIONS.agentReplyRuns,
      )
      .findOne({ _id: claimed.run._id });
    expect(run).toMatchObject({ state: "processing", nextAttemptAt: null, failure: null });
    expect(run?.lease?.token).toBe(claimed.token);

    // The run is still the expired holder's to reclaim by a later callback, and
    // the refused failure left it looking exactly like an abandoned claim.
    const reclaimed = await claimAgentReplyRun(db, runScope, afterExpiry);
    expect(reclaimed.kind).toBe("claimed");
  });

  test("jitter is deterministic per run and attempt, and bounded to ±20%", () => {
    const id = new ObjectId();
    expect(agentReplyRetryDelayMs(id, 1)).toBe(agentReplyRetryDelayMs(id, 1));
    expect(agentReplyRetryDelayMs(id, 1)).not.toBe(agentReplyRetryDelayMs(new ObjectId(), 1));
    expect(agentReplyRetryDelayMs(id, 1)).toBeGreaterThanOrEqual(5 * 60_000 * 0.8);
    expect(agentReplyRetryDelayMs(id, 1)).toBeLessThanOrEqual(5 * 60_000 * 1.2);
    expect(agentReplyRetryDelayMs(id, 8)).toBeLessThanOrEqual(6 * 60 * 60_000 * 1.2);
  });

  /** The SDK's own error object for a response body that failed its schema. */
  const protocolFailure = () => {
    const error = new Error("Type validation failed: Value: {}. Error message: Invalid input: expected array, received undefined");
    (error as unknown as Record<symbol, unknown>)[Symbol.for("vercel.ai.error.AI_TypeValidationError")] = true;
    return error;
  };

  test("classifies retryable provider trouble apart from terminal refusals", () => {
    expect(classifyReplyFailure({ statusCode: 503 })).toEqual({ code: "provider_503", terminal: false });
    expect(classifyReplyFailure({ statusCode: 429 })).toEqual({ code: "provider_429", terminal: false });
    expect(classifyReplyFailure({ statusCode: 400 })).toEqual({ code: "provider_400", terminal: true });
    expect(classifyReplyFailure(new SyntaxError("bad json"))).toEqual({ code: "invalid_model_output", terminal: true });
    // The gateway's 200-with-an-error-envelope: the SDK raises its own
    // response-validation error, which is not the model's output and must not be
    // closed as if the model had produced something unusable.
    expect(classifyReplyFailure(protocolFailure())).toEqual({ code: "provider_protocol", terminal: false });
    expect(classifyReplyFailure(new Error("model returned unsafe automatic reply: unsafe_link"))).toEqual({
      code: "model_rejected",
      terminal: true,
    });
    expect(classifyReplyFailure(new Error("socket hang up"))).toEqual({ code: "model_unavailable", terminal: false });
  });

  test("reconciles an existing send by idempotency key without another model call", async () => {
    const db = await getDb();
    const claimed = await claimAgentReplyRun(db, runScope, now);
    if (claimed.kind !== "claimed") throw new Error("expected claim");
    const sendId = await insertSend(scope.organizationId);

    const reconciled = await reconcileAgentReplySend(db, runScope, mentionKey);

    expect(reconciled).toMatchObject({ id: "send-1" });
    const run = await db.collection(COLLECTIONS.agentReplyRuns).findOne<{ state: string; sendRequestId: ObjectId }>({ waMessageId: "m1" });
    expect(run?.state).toBe("complete");
    expect(run?.sendRequestId.equals(sendId)).toBe(true);
  });

  test("the fifth expired lease becomes dead instead of being reclaimed", async () => {
    const db = await getDb();
    let at = now;
    const first = await claimAgentReplyRun(db, runScope, at);
    if (first.kind !== "claimed") throw new Error("expected claim");

    for (let attempt = 2; attempt <= AGENT_REPLY_MAX_ATTEMPTS; attempt += 1) {
      at = new Date(at.getTime() + 121_000);
      const next = await claimAgentReplyRun(db, runScope, at);
      expect(next.kind).toBe("claimed");
      if (next.kind !== "claimed") throw new Error("expected reclaim");
      expect(next.run.attempts).toBe(attempt);
    }

    at = new Date(at.getTime() + 121_000);
    const exhausted = await claimAgentReplyRun(db, runScope, at);
    expect(exhausted.kind).toBe("dead");
    if (exhausted.kind !== "dead") return;
    expect(exhausted.run.failure?.code).toBe("lease_exhausted");
  });

  test("renewAgentReplyLease reports lost once another holder owns the run", async () => {
    const db = await getDb();
    const claimed = await claimAgentReplyRun(db, runScope, now);
    if (claimed.kind !== "claimed") throw new Error("expected claim");
    expect((await renewAgentReplyLease(db, claimed.run, claimed.token, now)).kind).toBe("live");

    await db.collection(COLLECTIONS.agentReplyRuns).updateOne({ _id: claimed.run._id }, { $set: { "lease.token": "someone-else" } });

    expect((await renewAgentReplyLease(db, claimed.run, claimed.token, now)).kind).toBe("lost");
  });

  test("an expired lease cannot be renewed or resurrected by the old token", async () => {
    const db = await getDb();
    const claimed = await claimAgentReplyRun(db, runScope, now);
    if (claimed.kind !== "claimed") throw new Error("expected claim");
    const originalExpiry = claimed.run.lease!.expiresAt.getTime();
    const afterExpiry = new Date(originalExpiry + 1_000);

    expect((await renewAgentReplyLease(db, claimed.run, claimed.token, afterExpiry)).kind).toBe("lost");

    const run = await db.collection<{ state: string; lease: { token: string; expiresAt: Date } }>(COLLECTIONS.agentReplyRuns).findOne({ _id: claimed.run._id });
    expect(run?.state).toBe("processing");
    expect(run?.lease.expiresAt.getTime()).toBe(originalExpiry);
    expect(await db.collection(COLLECTIONS.sendRequests).countDocuments({})).toBe(0);
  });

  test("reconcile ignores same-key sends from another scope or source", async () => {
    const db = await getDb();
    const claimed = await claimAgentReplyRun(db, runScope, now);
    if (claimed.kind !== "claimed") throw new Error("expected claim");
    // `uniq_send_idempotency` allows one send per organization+key, so the wrong
    // variants are exercised one at a time.
    const wrongSends = [
      {
        _id: new ObjectId(),
        id: "wrong-group",
        organizationId: scope.organizationId,
        instanceId: scope.instanceId,
        groupJid: "another@g.us",
        idempotencyKey: mentionKey,
        replyToMessageId: "m1",
        provenance: { source: "owner_mention", replyToMessageId: "m1" },
      },
      {
        _id: new ObjectId(),
        id: "wrong-reply",
        organizationId: scope.organizationId,
        instanceId: scope.instanceId,
        groupJid: scope.groupJid,
        idempotencyKey: mentionKey,
        replyToMessageId: "other-message",
        provenance: { source: "owner_mention", replyToMessageId: "other-message" },
      },
      {
        _id: new ObjectId(),
        id: "not-automatic",
        organizationId: scope.organizationId,
        instanceId: scope.instanceId,
        groupJid: scope.groupJid,
        idempotencyKey: mentionKey,
        replyToMessageId: "m1",
        provenance: { source: "manual" },
      },
    ];

    for (const wrong of wrongSends) {
      await db.collection(COLLECTIONS.sendRequests).deleteMany({});
      await db.collection(COLLECTIONS.sendRequests).insertOne(wrong);
      expect(await reconcileAgentReplySend(db, runScope, mentionKey)).toBeNull();
    }
    const run = await db.collection<{ state: string }>(COLLECTIONS.agentReplyRuns).findOne({ waMessageId: "m1" });
    expect(run?.state).toBe("processing");
  });
});
