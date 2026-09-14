import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GroupUpdatedEventSchema,
  GroupSyncSummarySchema,
  InstanceGroupListSchema,
  InstanceListSchema,
  InstanceSnapshotSchema,
  SchedulerReportSchema,
} from "../src/worker-contract";
// Imported through the package entry point, exactly as a consumer (the BFF)
// does: this is what proves the contract is actually re-exported from ../src/index.
import * as shared from "../src/index";
import type { GroupSyncSummary, GroupUpdatedEvent, InstanceGroup, InstanceSnapshot } from "../src/index";

const read = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, "../testdata", name), "utf8"));

describe("worker contract schemas", () => {
  test("parses a real groups list payload", () => {
    const parsed = InstanceGroupListSchema.parse(read("groups-list.json"));
    expect(parsed.groups).toHaveLength(2);
    expect(parsed.groups[0]!.groupJid).toBe("120363043123456789@g.us");
    expect(parsed.groups[0]!.name).toBe("Ops Team");
    expect(parsed.groups[1]!.nameSource).toBe("fallback");
  });

  test("rejects a group row without a groupJid", () => {
    expect(() => InstanceGroupListSchema.parse({ instanceId: "i", groups: [{ name: "x" }] })).toThrow();
  });

  test("parses the sync summary", () => {
    const parsed = GroupSyncSummarySchema.parse(read("groups-sync-summary.json"));
    expect(parsed.total).toBe(12);
    expect(parsed.markedLeft).toBe(1);
    expect(parsed.subjectRejected).toBe(0);
  });

  test("parses a group.updated event", () => {
    const parsed = GroupUpdatedEventSchema.parse(read("group-updated-event.json"));
    expect(parsed.changes).toEqual(["subject"]);
    expect(parsed.previousName).toBe("Support");
  });

  test("parses a real instances list payload", () => {
    const parsed = InstanceListSchema.parse(read("instances-list.json"));
    expect(parsed.instances).toHaveLength(2);
    expect(parsed.instances[0]!.id).toBe("J9tZtOgQ8o5eIr0Amygb2");
    expect(parsed.instances[0]!.status).toBe("pairing");
    expect(parsed.instances[1]!.connectedAt).toBe("2026-09-12T09:30:00Z");
  });

  test("parses one instance snapshot, pairing material included", () => {
    const parsed = InstanceSnapshotSchema.parse(read("instance-snapshot.json"));
    expect(parsed.status).toBe("connected");
    expect(parsed.botLid).toBe("100000000000001@lid");
    // The worker omits pairing material outside a pairing session (omitempty).
    expect(parsed.qr).toBeUndefined();
    expect(parsed.pairingCode).toBeUndefined();
  });

  test("parses the scheduler report, a never-run loop included", () => {
    const parsed = SchedulerReportSchema.parse(read("scheduler-loops.json"));
    expect(parsed.loops).toHaveLength(2);
    expect(parsed.loops[0]).toMatchObject({ name: "group-sync", intervalMs: 1_800_000, runs: 3, lastError: "" });
    // A loop that has not finished a pass reports `null`, not the zero time.
    expect(parsed.loops[1]!.lastRunAt).toBeNull();
    expect(parsed.loops[1]!.lastError).toBe("the WhatsApp service did not answer");
  });
});

describe("worker contract: discrimination and boundaries", () => {
  test("the event union is discriminated by its literal type", () => {
    const event = read("group-updated-event.json");
    expect(() => GroupUpdatedEventSchema.parse({ ...event, type: "group.deleted" })).toThrow();
    expect(() => GroupUpdatedEventSchema.parse({ ...event, type: "unknown" })).toThrow();
  });

  test("rejects enum members outside the documented vocabulary", () => {
    const group = read("groups-list.json").groups[0];
    expect(() => InstanceGroupListSchema.parse({ instanceId: "i", groups: [{ ...group, state: "archived" }] })).toThrow();
    expect(() => InstanceGroupListSchema.parse({ instanceId: "i", groups: [{ ...group, nameSource: "manual" }] })).toThrow();
    expect(() => GroupSyncSummarySchema.parse({ ...read("groups-sync-summary.json"), source: "boot" })).toThrow();
  });

  test("rejects negative counters and count-like fields that are not integers", () => {
    const group = read("groups-list.json").groups[0];
    expect(() => InstanceGroupListSchema.parse({ instanceId: "i", groups: [{ ...group, messageCount: -1 }] })).toThrow();
    expect(() => InstanceGroupListSchema.parse({ instanceId: "i", groups: [{ ...group, participantCount: 2.5 }] })).toThrow();
    expect(() => GroupSyncSummarySchema.parse({ ...read("groups-sync-summary.json"), added: -2 })).toThrow();
  });

  test("rejects payloads missing the instance identity", () => {
    expect(() => InstanceGroupListSchema.parse({ groups: [] })).toThrow();
    expect(() => GroupSyncSummarySchema.parse({ ...read("groups-sync-summary.json"), instanceId: "" })).toThrow();
  });

  test("rejects an instance whose status or pairing mode is outside the vocabulary", () => {
    const instance = read("instance-snapshot.json");
    expect(() => InstanceSnapshotSchema.parse({ ...instance, status: "syncing" })).toThrow();
    expect(() => InstanceSnapshotSchema.parse({ ...instance, mode: "sms" })).toThrow();
    expect(() => InstanceSnapshotSchema.parse({ ...instance, id: "" })).toThrow();
    expect(() => InstanceListSchema.parse({ instances: [{ ...instance, status: "unknown" }] })).toThrow();
  });
});

describe("worker contract: the package entry point", () => {
  test("re-exports the schemas and their inferred types", () => {
    const groups: InstanceGroup[] = shared.InstanceGroupListSchema.parse(read("groups-list.json")).groups;
    const summary: GroupSyncSummary = shared.GroupSyncSummarySchema.parse(read("groups-sync-summary.json"));
    const event: GroupUpdatedEvent = shared.GroupUpdatedEventSchema.parse(read("group-updated-event.json"));
    const instance: InstanceSnapshot = shared.InstanceSnapshotSchema.parse(read("instance-snapshot.json"));

    expect(groups[0]!.groupJid).toBe("120363043123456789@g.us");
    expect(summary.source).toBe("manual");
    expect(event.type).toBe("group.updated");
    expect(instance.label).toBe("Ops bot");
  });
});
