import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { recordAuthEvent } from "./audit";
import { COLLECTIONS } from "../collections";
import { closeDb, getDb } from "../mongo";

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
});

beforeEach(async () => {
  await closeDb();
  process.env.MONGODB_URI = mongo.getUri();
  process.env.MONGODB_DB = "butler_audit_test";
  await (await getDb()).collection(COLLECTIONS.auditLog).deleteMany({});
});

afterEach(async () => {
  await closeDb();
});

describe("recordAuthEvent", () => {
  test("writes the auditLog row the data model describes", async () => {
    await recordAuthEvent({
      organizationId: "org_default",
      action: "auth.login.succeeded",
      ip: "198.51.100.7",
      email: "owner@local",
    });

    const rows = await (await getDb()).collection(COLLECTIONS.auditLog).find({}).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      _id: expect.anything(),
      organizationId: "org_default",
      actor: "owner",
      action: "auth.login.succeeded",
      target: { type: "owner", id: "owner@local" },
      meta: {},
      ip: "198.51.100.7",
      createdAt: expect.any(Date),
    });
  });

  test("carries the refusal reason in meta and never a raw password", async () => {
    await recordAuthEvent({
      organizationId: "org_default",
      action: "auth.login.failed",
      reason: "invalid_credentials",
      ip: "direct",
      email: "someone@else",
    });

    const row = (await (await getDb()).collection(COLLECTIONS.auditLog).findOne({}))!;
    expect(row.meta).toEqual({ reason: "invalid_credentials" });
    expect(JSON.stringify(row)).not.toMatch(/password/i);
  });

  test("truncates a submitted address instead of storing it whole", async () => {
    await recordAuthEvent({
      organizationId: "org_default",
      action: "auth.login.failed",
      reason: "invalid_credentials",
      ip: "direct",
      email: `${"a".repeat(5_000)}@example.test`,
    });

    const row = (await (await getDb()).collection(COLLECTIONS.auditLog).findOne({}))!;
    expect((row.target as { id: string }).id).toHaveLength(254);
  });

  /**
   * The callers fail closed, so this rejection is the whole mechanism that turns
   * an unreachable database into a 503 instead of an unaudited login. It must
   * also be bounded: a login cannot wait out the driver's server selection.
   */
  test("rejects, within its deadline, when the database cannot be reached", async () => {
    process.env.MONGODB_URI = "mongodb://127.0.0.1:1";
    await closeDb();

    const startedAt = performance.now();
    await expect(
      recordAuthEvent({ organizationId: "org_default", action: "auth.login.failed", ip: "direct", email: "" }),
    ).rejects.toThrow();
    const elapsed = performance.now() - startedAt;

    expect(elapsed).toBeGreaterThan(500);
    expect(elapsed).toBeLessThan(5_000);
  });
});
