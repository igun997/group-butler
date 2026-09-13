import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { COLLECTIONS } from "../../../../../server/collections";
import { UnauthorizedError } from "../../../../../server/auth/owner";
import { issueSession } from "../../../../../server/auth/session";
import { closeDb, getDb } from "../../../../../server/mongo";
import { insertGroup } from "../../../../../server/repos/test-helpers";
import { GET } from "./route";

/**
 * `requireOwner()` reads the request-scoped `next/headers` cookie store, which
 * cannot run outside a request. The holder lets each case choose the cookie the
 * handler sees: a valid session, nothing, or a forgery.
 */
const session = vi.hoisted(() => ({ token: "" as string }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (session.token ? { value: session.token } : undefined) }),
}));

const ownerToken = () => issueSession({ email: "owner@local", organizationId: "org_default" });

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  vi.stubEnv("MONGODB_URI", replSet.getUri());
  vi.stubEnv("MONGODB_DB", "butler_readmodel_test");
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

function getGroups(instanceId: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/instances/${instanceId}/groups`), {
    params: Promise.resolve({ id: instanceId }),
  });
}

describe("GET /api/instances/[id]/groups", () => {
  test("returns every group with its ID and current name", async () => {
    await insertGroup({
      organizationId: "org_default",
      instanceId: "inst_1",
      groupJid: "120363043123456789@g.us",
      subject: "Ops Team",
      subjectSource: "event",
    });
    await insertGroup({
      organizationId: "org_default",
      instanceId: "inst_1",
      groupJid: "120363043999999999@g.us",
      subject: "",
      subjectSource: "fallback",
    });

    const res = await getGroups("inst_1");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.instanceId).toBe("inst_1");
    expect(body.groups).toHaveLength(2);

    const byJid = Object.fromEntries(body.groups.map((g: { groupJid: string }) => [g.groupJid, g]));
    expect(byJid["120363043123456789@g.us"]).toMatchObject({
      groupJid: "120363043123456789@g.us",
      name: "Ops Team",
      nameSource: "event",
      participantCount: 12,
      state: "active",
      assigned: false,
      whitelisted: false,
      messageCount: 0,
      subjectHistoryCount: 0,
      nameSetAt: null,
      nameSetBy: null,
      lastActivityAt: null,
    });
    // The never-blank rule (§7.5): a group WhatsApp has not named yet still has
    // a usable cell, labelled as a fallback rather than served empty.
    expect(byJid["120363043999999999@g.us"]).toMatchObject({
      name: "(unnamed group) 120363043999999999",
      nameSource: "fallback",
    });
  });

  test("never returns another organisation's groups", async () => {
    await insertGroup({
      organizationId: "org_other",
      instanceId: "inst_1",
      groupJid: "120363043777777777@g.us",
      subject: "Secret",
      subjectSource: "sync",
    });

    const res = await getGroups("inst_1");
    const body = await res.json();

    expect(body.groups.map((g: { groupJid: string }) => g.groupJid)).not.toContain("120363043777777777@g.us");
  });

  test("orders assigned groups first, then the most recent activity (§7.5)", async () => {
    await insertGroup({
      organizationId: "org_default",
      instanceId: "inst_2",
      groupJid: "100000000000000001@g.us",
      subject: "Unassigned recent",
      subjectSource: "sync",
    });
    await insertGroup({
      organizationId: "org_default",
      instanceId: "inst_2",
      groupJid: "100000000000000002@g.us",
      subject: "Assigned idle",
      subjectSource: "sync",
    });
    await insertGroup({
      organizationId: "org_default",
      instanceId: "inst_2",
      groupJid: "100000000000000003@g.us",
      subject: "Unassigned idle",
      subjectSource: "sync",
    });
    const groups = (await getDb()).collection(COLLECTIONS.groups);
    await groups.updateOne(
      { organizationId: "org_default", instanceId: "inst_2", groupJid: "100000000000000002@g.us" },
      { $set: { "config.assigned": true } },
    );
    await groups.updateOne(
      { organizationId: "org_default", instanceId: "inst_2", groupJid: "100000000000000001@g.us" },
      { $set: { "observed.lastActivityAt": new Date("2026-09-13T09:00:00Z") } },
    );

    const body = await (await getGroups("inst_2")).json();

    expect(body.groups.map((g: { groupJid: string }) => g.groupJid)).toEqual([
      "100000000000000002@g.us",
      "100000000000000001@g.us",
      "100000000000000003@g.us",
    ]);
  });

  test("answers 401 for a request with no session", async () => {
    session.token = "";
    const res = await getGroups("inst_1");
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  test("answers 401 for a forged session cookie instead of trusting its presence", async () => {
    session.token = "eyJzdWIiOiJvd25lciIsImVtYWlsIjoiYXR0YWNrZXJAaG9zdCJ9.forged";
    const res = await getGroups("inst_1");
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  test("lets an unexpected failure surface instead of masking it as 401", async () => {
    vi.stubEnv("MONGODB_URI", "mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=250");
    await closeDb();
    try {
      const error = await getGroups("inst_1").catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(UnauthorizedError);
    } finally {
      await closeDb();
      vi.stubEnv("MONGODB_URI", replSet.getUri());
    }
  });
});
