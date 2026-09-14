import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { COLLECTIONS } from "../collections";
import { closeDb, getDb } from "../mongo";
import { createIndexes } from "../bootstrap";
import {
  InvalidMessageCursorError,
  MESSAGE_MAX_LIMIT,
  encodeMessageCursor,
  messageMediaKey,
  messageRawTree,
  nextMessageCursor,
  searchMessages,
} from "./messages";

/**
 * The `messages` shape the worker writes (§5.1, `apps/worker/ingest.go`): the
 * identity fields, the folded search text, and the flattened `media.*`
 * subdocument. Only fold-safe text is seeded — the search never reads
 * `raw.message`, which is the payload a projection must keep out of a page.
 */
const seed = [
  {
    organizationId: "org_default",
    instanceId: "inst_1",
    groupJid: "1203630431@g.us",
    waMessageId: "m1",
    senderJid: "628990000001@s.whatsapp.net",
    pushName: "Nadia",
    fromMe: false,
    kind: "text",
    text: "deploy is green",
    textSearch: "deploy is green",
    rawSearch: "deploy is green",
    timestamp: new Date("2026-09-13T10:00:00Z"),
    media: { status: "none" },
    links: [],
    mentions: [],
  },
  {
    organizationId: "org_default",
    instanceId: "inst_1",
    groupJid: "1203630431@g.us",
    waMessageId: "m2",
    senderJid: "628990000002@s.whatsapp.net",
    pushName: "Ravi",
    fromMe: false,
    kind: "document",
    text: "",
    textSearch: "",
    rawSearch: "invoice-2026.pdf",
    timestamp: new Date("2026-09-13T11:00:00Z"),
    media: {
      status: "unparsed",
      declaredType: "document",
      mime: "application/pdf",
      fileName: "invoice-2026.pdf",
      r2Key: "org/org_default/instance/inst_1/group/1203630431_g.us/2026/09/m2.bin",
      // R3/§6.3.4: bytes held but not consumable — the reason the dashboard says
      // instead of showing an empty slot.
      reason: "unsupported_type",
    },
    // The protobuf tree, truncated exactly as §6.4 stores it: never fetched by a
    // page, and read only by the raw viewer's own request.
    raw: { message: { conversation: "deploy is green", imageMessage: { mimetype: "image/png" } }, truncated: true, bytes: 812 },
    links: [],
    mentions: [],
  },
  {
    organizationId: "org_other",
    instanceId: "inst_1",
    groupJid: "1203630431@g.us",
    waMessageId: "m3",
    senderJid: "628990000003@s.whatsapp.net",
    pushName: "Other",
    fromMe: false,
    kind: "text",
    text: "deploy is green",
    textSearch: "deploy is green",
    rawSearch: "",
    timestamp: new Date("2026-09-13T12:00:00Z"),
    media: { status: "none" },
    links: [],
    mentions: [],
  },
  {
    organizationId: "org_default",
    instanceId: "inst_1",
    groupJid: "esc@g.us",
    waMessageId: "e1",
    senderJid: "628990000004@s.whatsapp.net",
    pushName: "Esc",
    fromMe: false,
    kind: "text",
    text: "a.b",
    textSearch: "a.b",
    rawSearch: "",
    timestamp: new Date("2026-09-13T07:00:00Z"),
    media: { status: "none" },
    links: [],
    mentions: [],
  },
  {
    organizationId: "org_default",
    instanceId: "inst_1",
    groupJid: "esc@g.us",
    waMessageId: "e2",
    senderJid: "628990000005@s.whatsapp.net",
    pushName: "Esc",
    fromMe: false,
    kind: "text",
    text: "axb",
    textSearch: "axb",
    rawSearch: "",
    timestamp: new Date("2026-09-13T07:01:00Z"),
    media: { status: "none" },
    links: [],
    mentions: [],
  },
  // The same `waMessageId` in two instances of one organisation: identity is
  // `(organizationId, instanceId, waMessageId)`, so a lookup that omits the
  // instance can select the wrong tenant's object.
  {
    organizationId: "org_default",
    instanceId: "inst_1",
    groupJid: "1203630431@g.us",
    waMessageId: "shared",
    senderJid: "628990000008@s.whatsapp.net",
    pushName: "Shared",
    fromMe: false,
    kind: "image",
    text: "",
    textSearch: "",
    rawSearch: "",
    timestamp: new Date("2026-09-13T05:00:00Z"),
    media: { status: "stored", r2Key: "org/org_default/instance/inst_1/group/g/2026/09/shared.bin" },
    links: [],
    mentions: [],
  },
  {
    organizationId: "org_default",
    instanceId: "inst_2",
    groupJid: "1203630431@g.us",
    waMessageId: "shared",
    senderJid: "628990000009@s.whatsapp.net",
    pushName: "Shared",
    fromMe: false,
    kind: "image",
    text: "",
    textSearch: "",
    rawSearch: "",
    timestamp: new Date("2026-09-13T05:00:00Z"),
    media: { status: "stored", r2Key: "org/org_default/instance/inst_2/group/g/2026/09/shared.bin" },
    links: [],
    mentions: [],
  },
  // A tie on `timestamp`: only the `waMessageId` half of the cursor keeps the
  // stream from repeating or skipping a row.
  ...[1, 2, 3].map((n) => ({
    organizationId: "org_default",
    instanceId: "inst_pg",
    groupJid: "pg@g.us",
    waMessageId: `p${n}`,
    senderJid: "628990000006@s.whatsapp.net",
    pushName: "Page",
    fromMe: false,
    kind: "text",
    text: "paginate",
    textSearch: "paginate",
    rawSearch: "",
    timestamp: new Date("2026-09-13T08:00:00Z"),
    media: { status: "none" },
    links: [],
    mentions: [],
  })),
  // One more than the cap, so `limit: 100000` proves the ceiling is applied.
  ...Array.from({ length: MESSAGE_MAX_LIMIT + 5 }, (_, i) => ({
    organizationId: "org_default",
    instanceId: "inst_cap",
    groupJid: "cap@g.us",
    waMessageId: `c${String(i).padStart(3, "0")}`,
    senderJid: "628990000007@s.whatsapp.net",
    pushName: "Cap",
    fromMe: false,
    kind: "text",
    text: "",
    textSearch: "",
    rawSearch: "",
    timestamp: new Date("2026-09-13T06:00:00Z"),
    media: { status: "none" },
    links: [],
    mentions: [],
  })),
];

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  process.env.MONGODB_DB = "butler_messages_test";
  await (await getDb()).collection(COLLECTIONS.messages).insertMany(seed);
  // The production index set, not a test stand-in: the text branch needs the
  // weighted `messages_text` index to run at all, and the cursor/sort contract
  // is only meaningful against the indexes the deployment actually creates.
  await createIndexes(await getDb());
});

afterAll(async () => {
  await closeDb();
  await mongo.stop();
});

describe("searchMessages", () => {
  test("finds messages by text and by raw media filename", async () => {
    const byText = await searchMessages(await getDb(), { organizationId: "org_default", query: "deploy" });
    expect(byText.map((m) => m.waMessageId)).toContain("m1");

    const byFilename = await searchMessages(await getDb(), { organizationId: "org_default", query: "invoice-2026" });
    expect(byFilename.map((m) => m.waMessageId)).toContain("m2");
  });

  test("never returns another organisation's messages", async () => {
    const rows = await searchMessages(await getDb(), { organizationId: "org_default", query: "deploy" });
    expect(rows.map((m) => m.waMessageId)).not.toContain("m3");
  });

  test("filters by media status (the 'could not read it' view)", async () => {
    const rows = await searchMessages(await getDb(), {
      organizationId: "org_default",
      query: "",
      mediaStatus: "unparsed",
    });
    expect(rows.map((m) => m.waMessageId)).toEqual(["m2"]);
  });

  test("treats metacharacters in the query as literal text, not a regex", async () => {
    const rows = await searchMessages(await getDb(), { organizationId: "org_default", query: "a.b" });
    expect(rows.map((m) => m.waMessageId)).toContain("e1");
    expect(rows.map((m) => m.waMessageId)).not.toContain("e2");
  });

  test("caps the page at the hard ceiling however large a limit is asked for", async () => {
    const rows = await searchMessages(await getDb(), {
      organizationId: "org_default",
      groupJid: "cap@g.us",
      query: "",
      limit: 100_000,
    });
    expect(rows).toHaveLength(MESSAGE_MAX_LIMIT);
    expect(MESSAGE_MAX_LIMIT).toBe(200);
  });

  test("pages a timestamp tie without repeating or skipping a row", async () => {
    const first = await searchMessages(await getDb(), {
      organizationId: "org_default",
      groupJid: "pg@g.us",
      query: "",
      limit: 1,
    });
    expect(first.map((m) => m.waMessageId)).toEqual(["p3"]);

    const second = await searchMessages(await getDb(), {
      organizationId: "org_default",
      groupJid: "pg@g.us",
      query: "",
      limit: 1,
      cursor: encodeMessageCursor(first[0]!),
    });
    expect(second.map((m) => m.waMessageId)).toEqual(["p2"]);

    const third = await searchMessages(await getDb(), {
      organizationId: "org_default",
      groupJid: "pg@g.us",
      query: "",
      limit: 1,
      cursor: encodeMessageCursor(second[0]!),
    });
    expect(third.map((m) => m.waMessageId)).toEqual(["p1"]);

    // A full page can promise another one; the page after the last row is
    // empty and mints no further cursor. No row repeats and none is skipped.
    const lastCursor = nextMessageCursor(third, 1);
    expect(lastCursor).not.toBeNull();
    const fourth = await searchMessages(await getDb(), {
      organizationId: "org_default",
      groupJid: "pg@g.us",
      query: "",
      limit: 1,
      cursor: lastCursor!,
    });
    expect(fourth).toEqual([]);
  });

  test("walks every page of a free-text query, returning a doubly-matched row once", async () => {
    // `paginate` matches the text index and the type-ahead prefix at once; the
    // branches are unioned, so each row must appear exactly once across pages.
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 6; page += 1) {
      const rows = await searchMessages(await getDb(), {
        organizationId: "org_default",
        groupJid: "pg@g.us",
        query: "paginate",
        limit: 1,
        cursor,
      });
      if (rows.length === 0) break;
      seen.push(rows[0]!.waMessageId);
      cursor = nextMessageCursor(rows, 1) ?? undefined;
      if (!cursor) break;
    }
    expect(seen).toEqual(["p3", "p2", "p1"]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  test("walks a cross-instance tie without losing or repeating a row", async () => {
    // `inst_1/shared` and `inst_2/shared` share a timestamp *and* a message id,
    // which `uniq_message` only makes unique within an instance. A keyset that
    // stopped at `(timestamp, waMessageId)` would return one and drop the other.
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 8; page += 1) {
      const rows = await searchMessages(await getDb(), {
        organizationId: "org_default",
        groupJid: "1203630431@g.us",
        query: "",
        limit: 1,
        cursor,
      });
      if (rows.length === 0) break;
      seen.push(`${rows[0]!.instanceId}/${rows[0]!.waMessageId}`);
      cursor = nextMessageCursor(rows, 1) ?? undefined;
      if (!cursor) break;
    }

    expect(seen).toEqual([
      "inst_1/m2",
      "inst_1/m1",
      "inst_2/shared",
      "inst_1/shared",
    ]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  test("refuses a cursor minted before the instance was part of the key", async () => {
    const legacy = Buffer.from(JSON.stringify(["2026-09-13T10:00:00.000Z", "m1"]), "utf8").toString("base64url");
    await expect(
      searchMessages(await getDb(), { organizationId: "org_default", query: "", cursor: legacy }),
    ).rejects.toBeInstanceOf(InvalidMessageCursorError);
  });

  test("never doubles a row that both search branches match", async () => {
    const rows = await searchMessages(await getDb(), { organizationId: "org_default", query: "deploy" });
    expect(rows.filter((m) => m.waMessageId === "m1")).toHaveLength(1);
  });

  test("refuses a cursor it did not mint instead of silently starting over", async () => {
    await expect(
      searchMessages(await getDb(), { organizationId: "org_default", query: "", cursor: "not-a-cursor" }),
    ).rejects.toBeInstanceOf(InvalidMessageCursorError);
  });

  test("returns the wire row, and never the raw payload a page must not carry", async () => {
    const [row] = await searchMessages(await getDb(), {
      organizationId: "org_default",
      instanceId: "inst_1",
      query: "invoice-2026",
    });
    expect(row).toEqual({
      waMessageId: "m2",
      instanceId: "inst_1",
      groupJid: "1203630431@g.us",
      senderJid: "628990000002@s.whatsapp.net",
      pushName: "Ravi",
      fromMe: false,
      timestamp: "2026-09-13T11:00:00.000Z",
      kind: "document",
      text: "",
      media: {
        status: "unparsed",
        declaredType: "document",
        r2Key: "org/org_default/instance/inst_1/group/1203630431_g.us/2026/09/m2.bin",
        mime: "application/pdf",
        fileName: "invoice-2026.pdf",
        reason: "unsupported_type",
      },
    });
  });

  test("reads a media row with no recorded reason as no reason at all", async () => {
    const [row] = await searchMessages(await getDb(), {
      organizationId: "org_default",
      instanceId: "inst_1",
      groupJid: "1203630431@g.us",
      query: "deploy",
      kinds: ["text"],
    });
    expect(row?.media).toEqual({
      status: "none",
      declaredType: null,
      r2Key: null,
      mime: null,
      fileName: null,
      reason: null,
    });
  });

  test("narrows a page to several kinds at once, and to one", async () => {
    const both = await searchMessages(await getDb(), {
      organizationId: "org_default",
      groupJid: "1203630431@g.us",
      query: "",
      kinds: ["document", "image"],
    });
    expect(both.map((m) => m.waMessageId).sort()).toEqual(["m2", "shared", "shared"]);

    const one = await searchMessages(await getDb(), {
      organizationId: "org_default",
      groupJid: "1203630431@g.us",
      query: "",
      kinds: ["document"],
    });
    expect(one.map((m) => m.waMessageId)).toEqual(["m2"]);

    // An empty list is not a filter: it selects nothing to exclude, so the page
    // is the unfiltered one rather than an empty answer.
    const unfiltered = await searchMessages(await getDb(), {
      organizationId: "org_default",
      groupJid: "pg@g.us",
      query: "",
      kinds: [],
    });
    expect(unfiltered).toHaveLength(3);
  });
});

describe("messageRawTree", () => {
  test("returns the stored tree, its truncation flag and its size", async () => {
    expect(await messageRawTree(await getDb(), "org_default", "inst_1", "m2")).toEqual({
      message: { conversation: "deploy is green", imageMessage: { mimetype: "image/png" } },
      truncated: true,
      bytes: 812,
    });
  });

  test("is null for another organisation, another instance, and a message with no tree", async () => {
    expect(await messageRawTree(await getDb(), "org_other", "inst_1", "m2")).toBeNull();
    expect(await messageRawTree(await getDb(), "org_default", "inst_2", "m2")).toBeNull();
    expect(await messageRawTree(await getDb(), "org_default", "inst_1", "m1")).toBeNull();
  });
});

describe("messageMediaKey", () => {
  test("returns the stored key only for a message of the caller's organisation", async () => {
    expect(await messageMediaKey(await getDb(), "org_default", "inst_1", "m2")).toBe(
      "org/org_default/instance/inst_1/group/1203630431_g.us/2026/09/m2.bin",
    );
    expect(await messageMediaKey(await getDb(), "org_other", "inst_1", "m2")).toBeNull();
  });

  test("is null for a message with no media and for one that does not exist", async () => {
    expect(await messageMediaKey(await getDb(), "org_default", "inst_1", "m1")).toBeNull();
    expect(await messageMediaKey(await getDb(), "org_default", "inst_1", "missing")).toBeNull();
  });

  test("resolves the same waMessageId to each instance's own object", async () => {
    expect(await messageMediaKey(await getDb(), "org_default", "inst_1", "shared")).toBe(
      "org/org_default/instance/inst_1/group/g/2026/09/shared.bin",
    );
    expect(await messageMediaKey(await getDb(), "org_default", "inst_2", "shared")).toBe(
      "org/org_default/instance/inst_2/group/g/2026/09/shared.bin",
    );
    expect(await messageMediaKey(await getDb(), "org_default", "inst_9", "shared")).toBeNull();
  });
});

/** `executionStats.nReturned` of an explain result, or -1 when unavailable. */
function nReturned(explained: unknown): number {
  if (explained && typeof explained === "object" && "executionStats" in explained) {
    const stats = (explained as { executionStats?: unknown }).executionStats;
    if (stats && typeof stats === "object" && "nReturned" in stats) {
      const value = (stats as { nReturned?: unknown }).nReturned;
      return typeof value === "number" ? value : -1;
    }
  }
  return -1;
}

/**
 * The plan the planner actually chose. The whole explain document also carries
 * `rejectedPlans`, which routinely contain the very sort or collection scan the
 * chosen plan avoided — so every plan assertion reads this, not the whole blob.
 */
function winningPlan(explained: unknown): string {
  if (explained && typeof explained === "object" && "queryPlanner" in explained) {
    const planner = (explained as { queryPlanner?: unknown }).queryPlanner;
    if (planner && typeof planner === "object" && "winningPlan" in planner) {
      return JSON.stringify((planner as { winningPlan?: unknown }).winningPlan);
    }
  }
  return JSON.stringify(explained);
}

/**
 * The index contract behind the query the repository issues. Each case runs the
 * exact filter, sort and limit the repository uses against the production index
 * set, and reads the planner's answer plus the execution counters: a rename, a
 * dropped key or an unbounded sort is a failing test, not a silent regression.
 */
describe("message search index contract", () => {
  const keyset = { timestamp: -1, waMessageId: -1, instanceId: -1 } as const;

  test("the tenant-filtered stream is served from the keyset index, with no sort stage", async () => {
    const messages = (await getDb()).collection(COLLECTIONS.messages);
    // Unhinted: this is what the real query gets, not what a hint forces.
    const explained = await messages
      .find({ organizationId: "org_default" })
      .sort(keyset)
      .limit(5)
      .explain("executionStats");
    const plan = winningPlan(explained);

    expect(plan).toContain("messages_stream");
    expect(plan).not.toContain('"stage":"SORT"');
    expect(plan).not.toContain("COLLSCAN");
    expect(nReturned(explained)).toBeLessThanOrEqual(5);

    // The index can also serve the order when the planner is told to use it,
    // which is what makes the `instanceId` key load-bearing rather than luck.
    const hinted = winningPlan(
      await messages
        .find({ organizationId: "org_default" })
        .sort(keyset)
        .limit(5)
        .hint("messages_stream")
        .explain("queryPlanner"),
    );
    expect(hinted).toContain("messages_stream");
    expect(hinted).not.toContain('"stage":"SORT"');
  });

  test("the group stream is served from its keyset index, with no sort stage", async () => {
    const messages = (await getDb()).collection(COLLECTIONS.messages);
    const explained = await messages
      .find({ organizationId: "org_default", instanceId: "inst_pg", groupJid: "pg@g.us" })
      .sort(keyset)
      .limit(5)
      .explain("executionStats");
    const plan = winningPlan(explained);

    expect(plan).toContain("messages_group_stream");
    expect(plan).not.toContain('"stage":"SORT"');
    expect(plan).not.toContain("COLLSCAN");
    expect(nReturned(explained)).toBeLessThanOrEqual(5);
  });

  test("free text uses the weighted text index and a page-bounded top-k sort", async () => {
    const limit = 3;
    const explained = await (await getDb())
      .collection(COLLECTIONS.messages)
      .find({ organizationId: "org_default", $text: { $search: "deploy" } })
      .sort(keyset)
      .limit(limit)
      .explain("executionStats");
    const plan = winningPlan(explained);

    expect(plan).toContain("messages_text");
    expect(plan).toContain("TEXT_MATCH");
    expect(plan).not.toContain("COLLSCAN");
    // The text index holds matches in score order, so the newest page costs a
    // top-k sort — bounded to the page (`limitAmount`), never the whole match
    // set, and the cursor's keyset keeps the returned rows to the page size.
    expect(plan).toContain('"stage":"SORT"');
    expect(plan).toContain(`"limitAmount":${limit}`);
    expect(nReturned(explained)).toBeLessThanOrEqual(limit);
  });

  test("type-ahead stays on an index and returns at most one page", async () => {
    const messages = (await getDb()).collection(COLLECTIONS.messages);
    const explained = await messages
      .find({ organizationId: "org_default", textSearch: /^deploy/ })
      .sort(keyset)
      .limit(3)
      .explain("executionStats");
    const plan = winningPlan(explained);

    expect(plan).not.toContain("COLLSCAN");
    expect(plan).toMatch(/messages_typeahead|messages_stream/);
    expect(nReturned(explained)).toBeLessThanOrEqual(3);

    // The prefix index can serve the filter on its own, which is why the
    // branch is never a collection scan even when the planner prefers the
    // already-ordered stream index.
    const hinted = winningPlan(
      await messages
        .find({ organizationId: "org_default", textSearch: /^deploy/ })
        .sort(keyset)
        .limit(3)
        .hint("messages_typeahead")
        .explain("queryPlanner"),
    );
    expect(hinted).toContain("messages_typeahead");
    expect(hinted).toContain("IXSCAN");
  });

  test("the production index set carries the cursor and tenant keys", async () => {
    const names = (await (await getDb()).collection(COLLECTIONS.messages).indexes()).map((index) => index.name ?? "");
    expect(names).toEqual(
      expect.arrayContaining([
        "messages_text",
        "messages_stream",
        "messages_group_stream",
        "messages_typeahead",
      ]),
    );
  });
});
