import { MongoClient, type Db, type IndexDescription } from "mongodb";
import { COLLECTIONS } from "./collections";
import { mongoConfig } from "./mongo";

/**
 * The canonical index set of docs/architecture-draft.md §5.1 — one writer of
 * indexes for the whole database. The worker creates a small named subset of
 * these at boot (`apps/worker/mongo.go`); this is the full set, and the index
 * names are a contract (routes and tests cite them).
 */
export const INDEXES: Record<string, IndexDescription[]> = {
  [COLLECTIONS.organizations]: [
    { name: "org_name", key: { organizationId: 1, name: 1 } },
  ],
  [COLLECTIONS.instances]: [
    {
      name: "org_label",
      key: { organizationId: 1, label: 1 },
      unique: true,
      // A soft-deleted instance releases its label for reuse.
      partialFilterExpression: { deletedAt: null },
    },
    { name: "instance_status", key: { organizationId: 1, "runtime.status": 1 } },
    // Soft-delete scans ("what is still live for this org").
    { name: "instance_deleted", key: { organizationId: 1, deletedAt: 1 } },
  ],
  [COLLECTIONS.pairingSessions]: [
    // Transient pairing material lives outside `instances` precisely so this
    // TTL can never delete an instance document.
    { name: "pairing_ttl", key: { expiresAt: 1 }, expireAfterSeconds: 0 },
  ],
  [COLLECTIONS.groups]: [
    { name: "uniq_group", key: { organizationId: 1, instanceId: 1, groupJid: 1 }, unique: true },
    { name: "group_activity", key: { organizationId: 1, "config.assigned": 1, "observed.lastActivityAt": -1 } },
    { name: "group_by_jid", key: { organizationId: 1, groupJid: 1 } },
    { name: "group_name_search", key: { organizationId: 1, instanceId: 1, "observed.subjectSearch": 1 } },
    { name: "group_reconcile", key: { organizationId: 1, "observed.state": 1, "observed.lastSyncedAt": -1 } },
  ],
  [COLLECTIONS.messages]: [
    // Idempotent ingest: a redelivered message cannot be stored twice.
    { name: "uniq_message", key: { organizationId: 1, instanceId: 1, waMessageId: 1 }, unique: true },
    { name: "group_stream", key: { organizationId: 1, instanceId: 1, groupJid: 1, timestamp: -1 } },
    { name: "media_status", key: { organizationId: 1, "media.status": 1, timestamp: -1 } },
    { name: "sender_stream", key: { organizationId: 1, senderJid: 1, timestamp: -1 } },
    // The cross-instance stream's keyset order (`/api/messages`): tenant
    // equality, then the exact `(timestamp, waMessageId, instanceId)`
    // descending order the cursor walks. `instanceId` is last because
    // `waMessageId` is only unique within an instance — without it two
    // instances' equal timestamp+id would tie and the cursor could lose one.
    { name: "messages_stream", key: { organizationId: 1, timestamp: -1, waMessageId: -1, instanceId: -1 } },
    // The per-group stream's keyset order (`/api/groups/[id]/messages`): the
    // three equality terms first, then the same descending pair. The instance
    // is an equality term here, so it is already constant for the sort.
    {
      name: "messages_group_stream",
      key: { organizationId: 1, instanceId: 1, groupJid: 1, timestamp: -1, waMessageId: -1 },
    },
    // Type-ahead: an anchored prefix over the case-folded `textSearch` is a
    // tenant-scoped range scan on this index rather than a collection scan.
    { name: "messages_typeahead", key: { organizationId: 1, textSearch: 1 } },
    {
      name: "messages_text",
      key: { text: "text", rawSearch: "text", "media.fileName": "text" },
      weights: { text: 10, rawSearch: 3, "media.fileName": 2 },
      // Messages are not prose in one language; stemming would corrupt JIDs,
      // phone numbers and command names (R4).
      default_language: "none",
    },
  ],
  [COLLECTIONS.sendRequests]: [
    { name: "uniq_send_idempotency", key: { organizationId: 1, idempotencyKey: 1 }, unique: true },
    { name: "send_due", key: { status: 1, scheduledFor: 1 } },
    { name: "send_by_instance", key: { organizationId: 1, instanceId: 1, createdAt: -1 } },
    { name: "send_by_group", key: { organizationId: 1, groupJid: 1, createdAt: -1 } },
  ],
  [COLLECTIONS.aiCalls]: [
    { name: "ai_recent", key: { organizationId: 1, createdAt: -1 } },
    { name: "ai_by_instance", key: { organizationId: 1, instanceId: 1, createdAt: -1 } },
    { name: "ai_by_model", key: { organizationId: 1, model: 1, createdAt: -1 } },
  ],
  [COLLECTIONS.statsDaily]: [
    { name: "stats_unique", key: { organizationId: 1, day: 1, instanceId: 1, groupJid: 1 }, unique: true },
  ],
  [COLLECTIONS.auditLog]: [
    { name: "audit_recent", key: { organizationId: 1, createdAt: -1 } },
  ],
};

/** `createIndexes` is the driver's `createIndexes`, so re-running is a no-op. */
export async function createIndexes(db: Db): Promise<void> {
  for (const [collection, indexes] of Object.entries(INDEXES)) {
    await db.collection(collection).createIndexes(indexes);
  }
}

/** §5.1 `organizations` is the only seeded document with a name. */
export const ORG_DEFAULT_ID = "org_default";

interface OrganizationDoc {
  _id: string;
  name: string;
  createdAt: Date;
}

interface AppSettingsDoc {
  _id: string;
  ai: { model: string; maxTokensPerDay: number };
  retention: { messagesDays: number };
  ui: { timezone: string };
}

/**
 * `appSettings` defaults, read at call time so a CLI or a test can set the
 * environment immediately before seeding. `TZ` is the process timezone Node
 * already understands; there is no separate UI timezone variable.
 */
export function appSettingsDefaults() {
  return {
    ai: {
      model: process.env.AI_MODEL ?? "",
      maxTokensPerDay: envInt("AI_MAX_TOKENS_PER_DAY", 200_000),
    },
    retention: { messagesDays: envInt("RETENTION_MESSAGES_DAYS", 0) },
    ui: { timezone: process.env.TZ ?? "UTC" },
  };
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * `$setOnInsert` only: bootstrap must be safe to re-run against a database the
 * owner has already configured, and must never overwrite a stored setting.
 */
export async function seedDefaults(db: Db, organizationId = ORG_DEFAULT_ID): Promise<void> {
  const now = new Date();
  await db.collection<OrganizationDoc>(COLLECTIONS.organizations).updateOne(
    { _id: organizationId },
    { $setOnInsert: { name: "Default", createdAt: now } },
    { upsert: true },
  );
  await db.collection<AppSettingsDoc>(COLLECTIONS.appSettings).updateOne(
    { _id: organizationId },
    { $setOnInsert: appSettingsDefaults() },
    { upsert: true },
  );
}

/** Creates the full canonical index set, then seeds the two default documents. */
export async function runBootstrap(opts: { uri?: string; dbName?: string } = {}): Promise<void> {
  const { uri, dbName } = mongoConfig(opts);
  const organizationId = process.env.ORGANIZATION_ID ?? ORG_DEFAULT_ID;

  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db(dbName);
    await createIndexes(db);
    await seedDefaults(db, organizationId);
    console.log(
      `bootstrap: ${dbName} — ${Object.keys(INDEXES).length} collections indexed, ` +
        `${organizationId} seeded (organization + appSettings)`,
    );
  } finally {
    await client.close();
  }
}

// `bun run src/server/bootstrap.ts` works as well as the `bootstrap` package
// script; under Next this is false and nothing happens.
if (import.meta.main) await runBootstrap();
