import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { issueSession } from "../../../server/auth/session";
import { closeDb } from "../../../server/mongo";
import { insertGroup, insertInstance } from "../../../server/repos/test-helpers";
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

  test("rejects an unauthenticated request", async () => {
    session.token = "";
    await expect(GET()).rejects.toThrow(/unauthorized/);
  });

  test("rejects a forged session cookie instead of trusting its presence", async () => {
    session.token = "eyJzdWIiOiJvd25lciIsImVtYWlsIjoiYXR0YWNrZXJAaG9zdCJ9.forged";
    await expect(GET()).rejects.toThrow(/unauthorized/);
  });
});
