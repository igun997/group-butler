import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { COLLECTIONS } from "./collections";
import { loadScheduler, loadUsage, type Loaded, type LoopReport, type UsageDay } from "./console";
import { closeDb, getDb } from "./mongo";
import { jsonAnswer, withStubWorker } from "./worker/test-helpers";

/**
 * The operations page's two reads as the page sees them: a value or a reason,
 * never a throw. The loops half is the worker's answer and the usage half is
 * MongoDB's, which is what lets one section render while the other says why it
 * cannot (§10, the operations slice's decision 1).
 */

const loops: LoopReport[] = [
  { name: "group-sync", intervalMs: 1_800_000, lastRunAt: "2026-09-14T10:00:00.123Z", lastError: "", runs: 3 },
];

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  process.env.MONGODB_DB = "butler_console_test";
});

afterAll(async () => {
  await closeDb();
  await mongo.stop();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loadScheduler", () => {
  test("reads the worker's loops as a value", async () => {
    await withStubWorker(jsonAnswer(200, { loops }), async () => {
      const loaded: Loaded<LoopReport[]> = await loadScheduler();

      expect(loaded).toEqual({ ok: true, data: loops });
    });
  });

  test("a worker that cannot be reached is a reason the section can show", async () => {
    await withStubWorker(jsonAnswer(200, { loops }), async () => {
      // The stub is up, so the address is valid; breaking it then points the
      // BFF at a port nothing answers on.
      vi.stubEnv("WORKER_URL", "http://127.0.0.1:1");

      const loaded = await loadScheduler();

      expect(loaded.ok).toBe(false);
      if (!loaded.ok) expect(loaded.error).toBe("the WhatsApp service did not answer");
    });
  });
});

describe("loadUsage", () => {
  test("reads today's counters and calls, with no worker involved", async () => {
    const db = await getDb();
    const day = new Date().toISOString().slice(0, 10);
    await db.collection(COLLECTIONS.instances).deleteMany({});
    await db.collection(COLLECTIONS.statsDaily).deleteMany({});
    await db.collection(COLLECTIONS.instances).insertOne({ _id: "inst_1" as never, organizationId: "org_default", label: "Ops bot", deletedAt: null });
    await db.collection(COLLECTIONS.statsDaily).insertOne({
      organizationId: "org_default", day, instanceId: "inst_1", groupJid: "group_a@g.us", counters: { messagesIn: 7 },
    });

    // No worker stub at all: this read must not depend on one.
    const loaded: Loaded<UsageDay> = await loadUsage("org_default");

    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.data.day).toBe(day);
      expect(loaded.data.instances[0]).toMatchObject({ instanceId: "inst_1", label: "Ops bot", recorded: true });
      expect(loaded.data.instances[0]!.counters.messagesIn).toBe(7);
    }
  });
});
