import { getDb } from "../mongo";
import { COLLECTIONS } from "../collections";

/**
 * Fixture writers for the group read-model tests. They seed a group the way the
 * two writers would between them (§5.1, T8): the worker-owned `observed.*` fields
 * and the BFF-owned default `config.*`, never overwriting an existing document's
 * counters.
 */
export async function insertGroup(input: {
  organizationId: string;
  instanceId: string;
  groupJid: string;
  subject: string;
  subjectSource: string;
}): Promise<void> {
  const db = await getDb();
  await db.collection(COLLECTIONS.groups).updateOne(
    { organizationId: input.organizationId, instanceId: input.instanceId, groupJid: input.groupJid },
    {
      $set: {
        "observed.subject": input.subject,
        "observed.subjectSearch": input.subject.toLowerCase(),
        "observed.subjectSource": input.subjectSource,
        "observed.state": "active",
        "observed.participantCount": 12,
      },
      $setOnInsert: {
        organizationId: input.organizationId,
        instanceId: input.instanceId,
        groupJid: input.groupJid,
        config: { assigned: false, whitelisted: false, active: true, notes: "", tags: [] },
        createdAt: new Date(),
      },
    },
    { upsert: true },
  );
}

export async function insertInstance(organizationId: string, instanceId: string, label: string): Promise<void> {
  const db = await getDb();
  await db.collection(COLLECTIONS.instances).updateOne(
    { _id: instanceId as never },
    { $set: { organizationId, label }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true },
  );
}
