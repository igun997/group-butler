import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { COLLECTIONS } from "../../../server/collections";
import { issueSession } from "../../../server/auth/session";
import { closeDb, getDb } from "../../../server/mongo";
import { GET } from "./route";

/**
 * §7.4: one authenticated SSE channel, fed by change streams and filtered by
 * the session's organisation, with the resume token persisted so a reconnect
 * does not replay the day — and a 503 (not a silently idle connection) when the
 * deployment cannot run change streams, which is what the client's poll
 * fallback is for.
 *
 * The waits here are all *conditions* — a frame arriving, a cursor document
 * appearing — never fixed sleeps; a stream that never delivers fails on the
 * vitest test timeout rather than on a guessed duration.
 */

const session = vi.hoisted(() => ({ token: "", fail: false }));
vi.mock("next/headers", () => ({
  cookies: async () => {
    if (session.fail) throw new Error("boom");
    return { get: () => (session.token ? { value: session.token } : undefined) };
  },
}));

const ownerToken = () => issueSession({ email: "owner@local", organizationId: "org_default" });

interface Frame {
  id: string;
  event: string;
  data: unknown;
}

/** A frame is only parsable once its blank-line terminator has arrived. */
function parseFrames(text: string): Frame[] {
  const frames: Frame[] = [];
  for (const block of text.split("\n\n")) {
    let id = "";
    let event = "";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("id: ")) id = line.slice(4);
      else if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data = line.slice(6);
    }
    if (event && data) frames.push({ id, event, data: JSON.parse(data) });
  }
  return frames;
}

/** A frame's payload, read as the loose shape every patch shares. */
function payloadOf(frame: Frame): { groupJid?: string; instanceId?: string; name?: string } {
  return (frame.data ?? {}) as { groupJid?: string; instanceId?: string; name?: string };
}

/**
 * Read until a *specific* frame arrives, and return that frame. A fresh
 * connection may repeat the single most recent change (the anchor is
 * inclusive), so "the first frame" is not a stable thing to assert on.
 */
async function readFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  event: string,
  match: (frame: Frame) => boolean,
  label: string,
): Promise<{ text: string; frame: Frame }> {
  const matches = (text: string): boolean =>
    parseFrames(text).some((frame) => frame.event === event && match(frame));
  const text = await readUntil(reader, matches, label);
  const frame = parseFrames(text).find((candidate) => candidate.event === event && match(candidate));
  if (!frame) throw new Error(`no ${event} frame matched ${label}`);
  return { text, frame };
}

const forGroup = (groupJid: string) => (frame: Frame) => payloadOf(frame).groupJid === groupJid;
const forMessage = (waMessageId: string) => (frame: Frame) => (frame.data as { waMessageId?: string }).waMessageId === waMessageId;

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
  label: string,
): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`stream ended before ${label}; saw:\n${buffer}`);
    buffer += decoder.decode(value, { stream: true });
    if (predicate(buffer)) return buffer;
  }
}

/** Await a database condition on the event loop, never on a wall clock. */
async function until(check: () => Promise<boolean>, label: string, attempts = 2_000): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`condition never held: ${label}`);
}

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  // This suite is one of a dozen files that each start their own mongod, all in
  // parallel, on the same machine; the default WiredTiger cache reservation is
  // what makes the pile contend. A quarter gigabyte is ample for a fixture.
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    instanceOpts: [{ args: ["--wiredTigerCacheSizeGB", "0.25"] }],
  });
  vi.stubEnv("MONGODB_URI", replSet.getUri());
  vi.stubEnv("MONGODB_DB", "butler_stream_test");
  vi.stubEnv("AUTH_SECRET", "test-secret-test-secret-test-secret");
  vi.stubEnv("ORGANIZATION_ID", "org_default");
});

beforeEach(() => {
  session.token = ownerToken();
  session.fail = false;
});

afterAll(async () => {
  await closeDb();
  await replSet.stop();
  vi.unstubAllEnvs();
});

async function open(parameters = ""): Promise<{
  response: Response;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  close: () => void;
}> {
  const controller = new AbortController();
  const response = await GET(new Request(`http://localhost/api/stream${parameters}`, { signal: controller.signal }));
  const reader = response.body?.getReader();
  if (!reader) throw new Error("the stream route answered without a body");
  return { response, reader, close: () => controller.abort() };
}

/** A `groups` upsert is one tenant-scoped change of the shape §6.6.6 describes. */
async function touchGroup(groupJid: string, subject: string, organizationId = "org_default"): Promise<void> {
  const db = await getDb();
  await db.collection(COLLECTIONS.groups).updateOne(
    { organizationId, instanceId: "inst_1", groupJid },
    { $set: { "observed.subject": subject, "observed.state": "active" } },
    { upsert: true },
  );
}

describe("GET /api/stream authentication", () => {
  test("answers 401 for a request with no session", async () => {
    session.token = "";
    const response = await GET(new Request("http://localhost/api/stream"));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("answers 401 for a forged session instead of trusting its presence", async () => {
    session.token = "not-a-real-session";
    const response = await GET(new Request("http://localhost/api/stream"));
    expect(response.status).toBe(401);
  });

  test("lets an unexpected failure surface instead of masking it as 401", async () => {
    session.fail = true;
    await expect(GET(new Request("http://localhost/api/stream"))).rejects.toThrow("boom");
  });
});

describe("GET /api/stream change streams", () => {
  test("serves an event-stream and opens it before any change arrives", async () => {
    const { response, reader, close } = await open();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-store");
    await readUntil(reader, (text) => text.includes(": open"), "the opening comment");
    close();
  });

  test("publishes a normalized group.updated patch with a resume token", async () => {
    const { reader, close } = await open();
    await readUntil(reader, (text) => text.includes(": open"), "the opening comment");

    await touchGroup("120363043123456789@g.us", "Ops Team");

    const { frame } = await readFrame(reader, "group.updated", forGroup("120363043123456789@g.us"), "the group patch");
    expect(frame.id).toBeTruthy();
    expect(frame.data).toMatchObject({
      type: "group.updated",
      instanceId: "inst_1",
      groupJid: "120363043123456789@g.us",
      changes: ["subject", "state"],
      name: "Ops Team",
      state: "active",
    });
    close();
  });

  test("publishes one message row, and never the stored raw tree", async () => {
    const db = await getDb();
    const { reader, close } = await open();
    await readUntil(reader, (text) => text.includes(": open"), "the opening comment");

    await db.collection(COLLECTIONS.messages).insertOne({
      organizationId: "org_default",
      instanceId: "inst_1",
      groupJid: "120363043123456789@g.us",
      waMessageId: "wamid-1",
      senderJid: "628990000001@s.whatsapp.net",
      pushName: "Nadia",
      fromMe: false,
      timestamp: new Date("2026-09-13T10:00:00Z"),
      kind: "text",
      text: "deploy is green",
      media: { status: "none" },
      raw: { message: { secret: "must-not-leave-the-server" } },
    });

    const { frame } = await readFrame(reader, "message.created", forMessage("wamid-1"), "the message row");
    expect(frame.data).toMatchObject({
      waMessageId: "wamid-1",
      instanceId: "inst_1",
      groupJid: "120363043123456789@g.us",
      kind: "text",
      text: "deploy is green",
      timestamp: "2026-09-13T10:00:00.000Z",
    });
    expect(JSON.stringify(frame.data)).not.toContain("must-not-leave-the-server");
    close();
  });

  test("never publishes another organisation's change", async () => {
    const { reader, close } = await open();
    await readUntil(reader, (text) => text.includes(": open"), "the opening comment");

    await touchGroup("120360000000000000@g.us", "Foreign", "org_other");
    // A same-tenant change behind it proves the stream is alive, so the absence
    // above is the filter's decision rather than a slow connection.
    await touchGroup("120363049999999999@g.us", "Mine");

    const { text, frame } = await readFrame(
      reader,
      "group.updated",
      forGroup("120363049999999999@g.us"),
      "my own patch",
    );
    expect(frame.data).toMatchObject({ name: "Mine" });
    // The other tenant's change is never on the wire, not merely "not first".
    expect(JSON.stringify(parseFrames(text))).not.toContain("Foreign");
    expect(JSON.stringify(parseFrames(text))).not.toContain("120360000000000000");
    close();
  });
});

describe("GET /api/stream resume", () => {
  test("persists the resume token and resumes after it without replaying", async () => {
    const first = await open();
    await readUntil(first.reader, (text) => text.includes(": open"), "the opening comment");

    await touchGroup("120363040000000001@g.us", "First");
    const { frame: firstFrame } = await readFrame(
      first.reader,
      "group.updated",
      forGroup("120363040000000001@g.us"),
      "the first patch",
    );
    const token = firstFrame.id;
    expect(token).toBeTruthy();
    first.close();

    const db = await getDb();
    await until(
      async () =>
        (await db
          .collection<{ _id: string; organizationId?: string; resumeToken?: unknown }>(COLLECTIONS.streamCursors)
          .findOne({ _id: "sse:org_default" })) !== null,
      "the tenant's resume cursor to be persisted",
    );
    const stored = await db
      .collection<{ _id: string; organizationId?: string; resumeToken?: unknown }>(COLLECTIONS.streamCursors)
      .findOne({ _id: "sse:org_default" });
    // The cursor is the tenant's own row, not one shared by every organisation.
    expect(stored?.organizationId).toBe("org_default");
    expect(stored?.resumeToken).toBeTruthy();

    const resumed = await open(`?resume=${encodeURIComponent(token)}`);
    await readUntil(resumed.reader, (text) => text.includes(": open"), "the resumed opening comment");
    await touchGroup("120363040000000002@g.us", "Second");

    const { text: resumedText, frame: secondFrame } = await readFrame(
      resumed.reader,
      "group.updated",
      forGroup("120363040000000002@g.us"),
      "the second patch",
    );
    expect(secondFrame.data).toMatchObject({ name: "Second" });
    // The change the token named is not replayed.
    expect(JSON.stringify(parseFrames(resumedText))).not.toContain("120363040000000001");
    resumed.close();
  });

  test("a resume token this deployment never minted does not kill the stream", async () => {
    // An undecodable token is not a token: the connection must still open, and
    // still deliver what happens next.
    const { reader, close } = await open("?resume=bm90LWEtdG9rZW4");
    await readUntil(reader, (text) => text.includes(": open"), "the opening comment");

    await touchGroup("120363040000000003@g.us", "AfterBadToken");
    const { frame } = await readFrame(reader, "group.updated", forGroup("120363040000000003@g.us"), "a patch after the bad token");
    expect(frame.data).toMatchObject({ name: "AfterBadToken" });
    close();
  });

  test("a connection with no token of its own resumes from the tenant's cursor", async () => {
    const db = await getDb();
    await db.collection(COLLECTIONS.streamCursors).deleteMany({});

    const first = await open();
    await readUntil(first.reader, (text) => text.includes(": open"), "the opening comment");
    await touchGroup("120363040000000007@g.us", "DeliveredThenClosed");
    await readFrame(first.reader, "group.updated", forGroup("120363040000000007@g.us"), "the first connection's patch");
    first.close();
    await until(
      async () =>
        (await db
          .collection<{ _id: string }>(COLLECTIONS.streamCursors)
          .findOne({ _id: "sse:org_default" })) !== null,
      "the tenant's resume cursor to be persisted",
    );

    // The change lands while nothing is connected. A connection that started at
    // "now" would miss it; resuming from the persisted cursor catches it up.
    await touchGroup("120363040000000008@g.us", "WrittenWhileNobodyListened");

    const reopened = await open();
    const { frame } = await readFrame(
      reopened.reader,
      "group.updated",
      forGroup("120363040000000008@g.us"),
      "the catch-up patch",
    );
    expect(frame.data).toMatchObject({ name: "WrittenWhileNobodyListened" });
    reopened.close();
  });

  test("the client's own token wins over the tenant's persisted cursor", async () => {
    const db = await getDb();
    await db.collection(COLLECTIONS.streamCursors).deleteMany({});

    const first = await open();
    await readUntil(first.reader, (text) => text.includes(": open"), "the opening comment");
    await touchGroup("120363040000000009@g.us", "First");
    const { frame: firstFrame } = await readFrame(
      first.reader,
      "group.updated",
      forGroup("120363040000000009@g.us"),
      "the first patch",
    );
    const olderToken = firstFrame.id;

    // A second change moves the persisted cursor past the first token.
    await touchGroup("120363040000000010@g.us", "Second");
    await readFrame(first.reader, "group.updated", forGroup("120363040000000010@g.us"), "the second patch");
    first.close();
    await until(
      async () =>
        (await db
          .collection<{ _id: string }>(COLLECTIONS.streamCursors)
          .findOne({ _id: "sse:org_default" })) !== null,
      "the tenant's resume cursor to be persisted",
    );

    // Resuming from the *older* client token must replay the second change; a
    // connection that preferred the persisted cursor would start after it.
    const resumed = await open(`?resume=${encodeURIComponent(olderToken)}`);
    const { frame } = await readFrame(
      resumed.reader,
      "group.updated",
      forGroup("120363040000000010@g.us"),
      "the change the client token predates",
    );
    expect(frame.data).toMatchObject({ name: "Second" });
    resumed.close();
  });

  test("another tenant's cursor row is never consumed", async () => {
    const db = await getDb();
    await db.collection(COLLECTIONS.streamCursors).deleteMany({});

    const first = await open();
    await readUntil(first.reader, (text) => text.includes(": open"), "the opening comment");
    await touchGroup("120363040000000011@g.us", "BeforeTheOtherTenantRow");
    const { frame } = await readFrame(
      first.reader,
      "group.updated",
      forGroup("120363040000000011@g.us"),
      "the earlier patch",
    );
    first.close();

    // A cursor that points *before* that change, filed under another tenant.
    await db
      .collection<{ _id: string; organizationId?: string; resumeToken?: unknown; updatedAt?: Date }>(
        COLLECTIONS.streamCursors,
      )
      .insertOne({
        _id: "sse:org_other",
        organizationId: "org_other",
        resumeToken: JSON.parse(Buffer.from(frame.id, "base64url").toString("utf8")),
        updatedAt: new Date(),
      });

    const fresh = await open();
    await readUntil(fresh.reader, (text) => text.includes(": open"), "the fresh opening comment");
    await touchGroup("120363040000000012@g.us", "AfterTheOtherTenantRow");
    const { text } = await readFrame(
      fresh.reader,
      "group.updated",
      forGroup("120363040000000012@g.us"),
      "the fresh patch",
    );
    expect(JSON.stringify(parseFrames(text))).not.toContain("BeforeTheOtherTenantRow");
    fresh.close();
  });
});

describe("GET /api/stream polling fallback", () => {
  test("answers 503 stream_unavailable when the deployment cannot run change streams", async () => {
    const db = await getDb();
    // A standalone mongod answers `hello` with neither `setName` nor `isdbgrid`.
    const spy = vi.spyOn(db, "command").mockResolvedValue({ ok: 1 });
    const response = await GET(new Request("http://localhost/api/stream"));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "stream_unavailable" });
    expect(response.headers.get("content-type")).toContain("application/json");
    spy.mockRestore();
  });

  test("answers 503 stream_unavailable when the resume-cursor read fails", async () => {
    const db = await getDb();
    const realCollection = db.collection.bind(db);
    // The replica set is fine; only the cursor row cannot be read.
    const spy = vi.spyOn(db, "collection").mockImplementation(((name: string) =>
      new Proxy(realCollection(name as never) as object, {
        get: (target, property, receiver) =>
          property === "findOne" ? () => Promise.reject(new Error("cursor read failed")) : Reflect.get(target, property, receiver),
      })) as never);

    try {
      const response = await GET(new Request("http://localhost/api/stream"));
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: "stream_unavailable" });
      expect(response.headers.get("cache-control")).toBe("no-store");
    } finally {
      spy.mockRestore();
    }
  });

  test("answers 503 stream_unavailable when Mongo is unreachable", async () => {
    await closeDb();
    vi.stubEnv("MONGODB_URI", "mongodb://127.0.0.1:1/nope?serverSelectionTimeoutMS=250");
    try {
      const response = await GET(new Request("http://localhost/api/stream"));
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: "stream_unavailable" });
    } finally {
      vi.stubEnv("MONGODB_URI", replSet.getUri());
      await closeDb();
    }
  });
});
