import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { COLLECTIONS } from "../collections";
import { closeDb, getDb } from "../mongo";
import { getInstanceRuntime, instanceInOrg, listInstances } from "./instances";
import { insertInstance } from "./test-helpers";

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  vi.stubEnv("MONGODB_URI", replSet.getUri());
  vi.stubEnv("MONGODB_DB", "butler_instances_test");
});

beforeEach(async () => {
  await closeDb();
  const db = await getDb();
  await db.collection(COLLECTIONS.instances).deleteMany({});
});

afterAll(async () => {
  await closeDb();
  await replSet.stop();
  vi.unstubAllEnvs();
});

/**
 * Removing an instance is a soft delete: the worker stamps `deletedAt` and keeps
 * the row, because the captured history and the audit trail still point at it
 * (`manager.go` deletes exactly this way, and filters `deletedAt: nil` when it
 * reads). Every console read has to read the row the same way, or a removed
 * instance keeps sitting in the list and its workspace keeps opening.
 */
describe("soft-deleted instances", () => {
  test("are not listed", async () => {
    const db = await getDb();
    await insertInstance("org_default", "inst_live", "Live bot");
    await insertInstance("org_default", "inst_gone", "Removed bot");
    await db
      .collection(COLLECTIONS.instances)
      .updateOne({ _id: "inst_gone" as never }, { $set: { deletedAt: new Date() } });

    const listed = await listInstances(db, "org_default");

    expect(listed.map((row) => row.id)).toEqual(["inst_live"]);
  });

  test("do not belong to the organisation any more", async () => {
    const db = await getDb();
    await insertInstance("org_default", "inst_live", "Live bot");
    await insertInstance("org_default", "inst_gone", "Removed bot");
    await db
      .collection(COLLECTIONS.instances)
      .updateOne({ _id: "inst_gone" as never }, { $set: { deletedAt: new Date() } });

    expect(await instanceInOrg(db, "org_default", "inst_live")).toBe(true);
    expect(await instanceInOrg(db, "org_default", "inst_gone")).toBe(false);
  });

  test("have no runtime summary to show", async () => {
    const db = await getDb();
    await insertInstance("org_default", "inst_gone", "Removed bot");
    await db
      .collection(COLLECTIONS.instances)
      .updateOne(
        { _id: "inst_gone" as never },
        { $set: { deletedAt: new Date(), "runtime.status": "connected" } },
      );

    expect(await getInstanceRuntime(db, "org_default", "inst_gone")).toBeNull();
  });

  test("a live instance is still read as live", async () => {
    const db = await getDb();
    await insertInstance("org_default", "inst_live", "Live bot");

    expect((await listInstances(db, "org_default")).map((row) => row.id)).toEqual(["inst_live"]);
    expect(await instanceInOrg(db, "org_default", "inst_live")).toBe(true);
    expect(await getInstanceRuntime(db, "org_default", "inst_live")).not.toBeNull();
  });
});
