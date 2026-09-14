import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { UnauthorizedError } from "../../../server/auth/owner";
import { issueSession } from "../../../server/auth/session";
import { closeDb } from "../../../server/mongo";
import { insertGroup, insertInstance } from "../../../server/repos/test-helpers";
import { SUBJECT_HISTORY_MAX } from "../../../server/repos/groups";
import { GET } from "./route";

/** Same request-scoped cookie seam as the per-instance group route test. */
const session = vi.hoisted(() => ({ token: "" as string }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (session.token ? { value: session.token } : undefined) }),
}));

const ownerToken = () => issueSession({ email: "owner@local", organizationId: "org_default" });

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  vi.stubEnv("MONGODB_URI", replSet.getUri());
  vi.stubEnv("MONGODB_DB", "butler_groups_test");
  vi.stubEnv("AUTH_SECRET", "test-secret-test-secret-test-secret");
  vi.stubEnv("ORGANIZATION_ID", "org_default");
});

beforeEach(() => {
  session.token = ownerToken();
});

afterAll(async () => {
  await closeDb();
  await replSet.stop();
  vi.unstubAllEnvs();
});

describe("GET /api/groups", () => {
  test("covers every instance in one list, each row labelled with its instance", async () => {
    await insertInstance("org_default", "inst_1", "Support bot");
    await insertInstance("org_default", "inst_2", "Sales bot");
    await insertGroup({
      organizationId: "org_default",
      instanceId: "inst_1",
      groupJid: "120363043123456789@g.us",
      subject: "Ops Team",
      subjectSource: "event",
    });
    await insertGroup({
      organizationId: "org_default",
      instanceId: "inst_2",
      groupJid: "120363043999999999@g.us",
      subject: "",
      subjectSource: "fallback",
    });

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    const byJid = Object.fromEntries(body.groups.map((g: { groupJid: string }) => [g.groupJid, g]));
    expect(byJid["120363043123456789@g.us"]).toMatchObject({
      instanceId: "inst_1",
      instanceLabel: "Support bot",
      name: "Ops Team",
      nameSource: "event",
    });
    expect(byJid["120363043999999999@g.us"]).toMatchObject({
      instanceId: "inst_2",
      instanceLabel: "Sales bot",
      name: "(unnamed group) 120363043999999999",
      nameSource: "fallback",
    });
  });

  test("never returns another organisation's groups", async () => {
    await insertInstance("org_other", "inst_9", "Someone else");
    await insertGroup({
      organizationId: "org_other",
      instanceId: "inst_9",
      groupJid: "120363043777777777@g.us",
      subject: "Secret",
      subjectSource: "sync",
    });

    const body = await (await GET()).json();

    expect(body.groups.map((g: { groupJid: string }) => g.groupJid)).not.toContain("120363043777777777@g.us");
  });

  test("exposes each group's capped rename ring, newest first", async () => {
    const long = Array.from({ length: 25 }, (_, index) => ({
      name: `Name ${index + 1}`,
      at: new Date(`2026-09-${String((index % 28) + 1).padStart(2, "0")}T08:00:00Z`),
      by: "4915112345678",
    }));
    await insertGroup({
      organizationId: "org_default",
      instanceId: "inst_3",
      groupJid: "120363046666666666@g.us",
      subject: "Current name",
      subjectSource: "event",
      subjectUpdatedAt: new Date("2026-09-14T08:00:00Z"),
      subjectSetBy: "4915000000000",
      subjectHistory: long,
    });

    const body = await (await GET()).json();
    const row = body.groups.find((g: { groupJid: string }) => g.groupJid === "120363046666666666@g.us");

    // The worker's cap, applied by the read model as well: a document holding
    // more than the ring keeps cannot put more than the ring into one answer.
    expect(row.subjectHistory).toHaveLength(SUBJECT_HISTORY_MAX);
    expect(row.subjectHistoryCount).toBe(SUBJECT_HISTORY_MAX);
    expect(row.subjectHistory[0]).toEqual({
      name: "Name 1",
      at: "2026-09-01T08:00:00.000Z",
      by: "4915112345678",
    });
    expect(row.subjectHistory.at(-1)).toMatchObject({ name: "Name 20" });
  });

  test("an entry with no stamp or no setter is stated as unknown, not as a date", async () => {
    await insertGroup({
      organizationId: "org_default",
      instanceId: "inst_4",
      groupJid: "120363047777777777@g.us",
      subject: "Current",
      subjectSource: "event",
      subjectHistory: [
        { name: "Earlier", at: new Date("0001-01-01T00:00:00Z"), by: "" },
        { name: "", at: new Date("2026-09-02T08:00:00Z"), by: "4915112345678" },
      ],
    });

    const body = await (await GET()).json();
    const row = body.groups.find((g: { groupJid: string }) => g.groupJid === "120363047777777777@g.us");

    // The zero stamp means "no stamp" and the name-less entry is not a rename,
    // so neither is rendered as a fact nobody observed.
    expect(row.subjectHistory).toEqual([{ name: "Earlier", at: null, by: null }]);
    expect(row.subjectHistoryCount).toBe(1);
  });

  test("answers 401 for a request with no session", async () => {
    session.token = "";
    const res = await GET();
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  test("answers 401 for a forged session cookie instead of trusting its presence", async () => {
    session.token = "eyJzdWIiOiJvd25lciIsImVtYWlsIjoiYXR0YWNrZXJAaG9zdCJ9.forged";
    const res = await GET();
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  test("lets an unexpected failure surface instead of masking it as 401", async () => {
    vi.stubEnv("MONGODB_URI", "mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=250");
    await closeDb();
    try {
      const error = await GET().catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(UnauthorizedError);
    } finally {
      await closeDb();
      vi.stubEnv("MONGODB_URI", replSet.getUri());
    }
  });
});
