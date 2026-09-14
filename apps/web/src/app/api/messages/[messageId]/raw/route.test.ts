import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { COLLECTIONS } from "../../../../../server/collections";
import { issueSession } from "../../../../../server/auth/session";
import { closeDb, getDb } from "../../../../../server/mongo";
import { GET } from "./route";

/**
 * The raw-tree read (docs/architecture-draft.md §6.4, §11.5; docs/ui-decision.md
 * §2.2 invariant 7). A page never carries `raw.message`, so the viewer's own
 * request is the only way it is ever read — and this suite is about the two
 * things that request must keep: the tenant boundary (organisation *and*
 * instance, because `uniq_message` is only unique within an instance) and the
 * tree coming back as data, never as markup.
 */
const session = vi.hoisted(() => ({ token: "" as string }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (session.token ? { value: session.token } : undefined) }),
}));

const ownerToken = () => issueSession({ email: "owner@local", organizationId: "org_default" });

const TREE = {
  conversation: "deploy is green",
  imageMessage: { mimetype: "image/png", caption: "<img src=x onerror=alert(1)>" },
};

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  vi.stubEnv("MONGODB_URI", replSet.getUri());
  vi.stubEnv("MONGODB_DB", "butler_message_raw_test");
  vi.stubEnv("AUTH_SECRET", "test-secret-test-secret-test-secret");
  vi.stubEnv("ORGANIZATION_ID", "org_default");

  const db = await getDb();
  await db.collection(COLLECTIONS.messages).insertMany([
    {
      organizationId: "org_default",
      instanceId: "inst_1",
      groupJid: "target@g.us",
      waMessageId: "r1",
      raw: { message: TREE, truncated: true, bytes: 812 },
    },
    // The same message id in another instance of the same organisation.
    {
      organizationId: "org_default",
      instanceId: "inst_2",
      groupJid: "target@g.us",
      waMessageId: "r1",
      raw: { message: { conversation: "the other instance's tree" }, truncated: false, bytes: 40 },
    },
    { organizationId: "org_default", instanceId: "inst_1", groupJid: "target@g.us", waMessageId: "bare" },
    {
      organizationId: "org_other",
      instanceId: "inst_1",
      groupJid: "target@g.us",
      waMessageId: "foreign",
      raw: { message: TREE, truncated: false, bytes: 812 },
    },
  ]);
});

beforeEach(() => {
  session.token = ownerToken();
});

afterAll(async () => {
  await closeDb();
  await replSet.stop();
  vi.unstubAllEnvs();
});

function getRaw(messageId: string, query = "?instance=inst_1"): Promise<Response> {
  return GET(new Request(`http://localhost/api/messages/${messageId}/raw${query}`), {
    params: Promise.resolve({ messageId }),
  });
}

describe("GET /api/messages/[messageId]/raw", () => {
  test("returns the stored tree, its truncation flag and its size", async () => {
    const res = await getRaw("r1");

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ message: TREE, truncated: true, bytes: 812 });
  });

  test("requires the instance the message belongs to", async () => {
    const res = await getRaw("r1", "");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "instance_required" });
  });

  test("reads each instance's own tree when a waMessageId is shared", async () => {
    const other = await (await getRaw("r1", "?instance=inst_2")).json();
    expect(other.message).toEqual({ conversation: "the other instance's tree" });
    expect((await getRaw("r1", "?instance=inst_9")).status).toBe(404);
  });

  test("answers 404 where there is no tree, for another organisation, and for a message that is not here", async () => {
    expect((await getRaw("bare")).status).toBe(404);
    expect((await getRaw("foreign")).status).toBe(404);
    expect(await (await getRaw("nobody")).json()).toEqual({ error: "not_found" });
  });

  test("answers 401 for a request with no session", async () => {
    session.token = "";
    const res = await getRaw("r1");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });
});
