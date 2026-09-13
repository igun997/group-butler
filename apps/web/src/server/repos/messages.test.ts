import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { COLLECTIONS } from "../collections";
import { closeDb, getDb } from "../mongo";
import {
  InvalidMessageCursorError,
  MESSAGE_MAX_LIMIT,
  encodeMessageCursor,
  messageMediaKey,
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
    },
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
      },
    });
  });
});

describe("messageMediaKey", () => {
  test("returns the stored key only for a message of the caller's organisation", async () => {
    expect(await messageMediaKey(await getDb(), "org_default", "m2")).toBe(
      "org/org_default/instance/inst_1/group/1203630431_g.us/2026/09/m2.bin",
    );
    expect(await messageMediaKey(await getDb(), "org_other", "m2")).toBeNull();
  });

  test("is null for a message with no media and for one that does not exist", async () => {
    expect(await messageMediaKey(await getDb(), "org_default", "m1")).toBeNull();
    expect(await messageMediaKey(await getDb(), "org_default", "missing")).toBeNull();
  });
});
