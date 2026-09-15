import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { COLLECTIONS } from "../../../../server/collections";
import { issueSession } from "../../../../server/auth/session";
import { closeDb, getDb } from "../../../../server/mongo";
import { GET, PATCH } from "./route";

const session = vi.hoisted(() => ({ token: "" as string }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (session.token ? { value: session.token } : undefined) }),
}));

const ownerToken = () => issueSession({ email: "owner@local", organizationId: "org_default" });
let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  vi.stubEnv("MONGODB_URI", mongo.getUri());
  vi.stubEnv("MONGODB_DB", "butler_authorized_jids_route_test");
  vi.stubEnv("AUTH_SECRET", "test-secret-test-secret-test-secret");
});

beforeEach(async () => {
  session.token = ownerToken();
  await (await getDb()).collection(COLLECTIONS.organizations).deleteMany({});
});

afterAll(async () => {
  await closeDb();
  await mongo.stop();
  vi.unstubAllEnvs();
});

const patch = (body: unknown) =>
  PATCH(
    new Request("http://localhost/api/organizations/authorized-jids", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

describe("organization authorized JIDs", () => {
  test("canonicalizes phones and WhatsApp device JIDs before persisting the reply gate", async () => {
    const res = await patch({ authorizedJids: ["+62 899-0000-001", "628990000001:5@s.whatsapp.net", "628990000002@s.whatsapp.net"] });

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ authorizedJids: ["628990000001@s.whatsapp.net", "628990000002@s.whatsapp.net"] });
    expect(await (await getDb()).collection(COLLECTIONS.organizations).findOne({ _id: "org_default" as never })).toMatchObject({
      config: { autoReplyAuthorizedJids: ["628990000001@s.whatsapp.net", "628990000002@s.whatsapp.net"] },
    });
  });

  test("returns the canonical stored gate and allows an empty, disabled configuration", async () => {
    await (await getDb()).collection(COLLECTIONS.organizations).insertOne({
      _id: "org_default" as never,
      config: { autoReplyAuthorizedJids: ["628990000003:9@s.whatsapp.net", "not-a-jid"] },
    });

    expect(await (await GET()).json()).toEqual({ authorizedJids: ["628990000003@s.whatsapp.net"] });
    expect(await (await patch({ authorizedJids: [] })).json()).toEqual({ authorizedJids: [] });
  });

  test("refuses malformed, anonymous, and foreign writes", async () => {
    expect((await patch({ authorizedJids: ["not a phone"] })).status).toBe(400);
    session.token = "";
    expect((await patch({ authorizedJids: ["628990000001"] })).status).toBe(401);
  });
});
