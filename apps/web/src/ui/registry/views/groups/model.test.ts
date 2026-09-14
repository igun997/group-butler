import { afterEach, describe, expect, test, vi } from "vitest";
import { resourceCache, type StreamFrame } from "../../../resource";
import type { Scope } from "../../types";
import {
  GROUPS_ALL,
  GROUPS_INSTANCE,
  SUBJECT_HISTORY_CAP,
  applyGroupRow,
  groupUpdate,
  groupsKey,
  invalidateGroupsReads,
  readAllGroups,
  readInstanceGroups,
  setGroupConfig,
  syncInstanceGroups,
  syncSummaryLine,
  type GroupRow,
} from "./model";

/**
 * The groups read model (docs/ui-decision.md §4.2 R-V1/R-V2/R-V4, §4.5 R-X1;
 * draft §7.5, §6.6.6).
 *
 * What is asserted is what the panel and the cache depend on: the address each
 * read uses, the code a failure carries, the row a write returns, and the exact
 * terms of one live frame — including the two the spec calls out, a frame that
 * carries no name, and a fallback name that resolves when a real one arrives.
 */

const INSTANCE: Scope = { kind: "instance", instanceId: "inst_1" };
const GLOBAL: Scope = { kind: "global" };

const HISTORY = [
  { name: "Ops", at: "2026-09-01T08:00:00.000Z", by: "4915112345678" },
  { name: "Team", at: null, by: null },
];

const ROW: GroupRow = {
  groupJid: "120363043123456789@g.us",
  name: "Ops Team",
  nameSource: "sync",
  nameSetAt: "2026-09-13T08:12:00Z",
  nameSetBy: "4915112345678",
  participantCount: 12,
  state: "active",
  assigned: false,
  whitelisted: false,
  lastActivityAt: "2026-09-14T07:00:00Z",
  messageCount: 340,
  subjectHistory: HISTORY,
};

const FALLBACK: GroupRow = {
  ...ROW,
  name: "(unnamed group) 120363043123456789",
  nameSource: "fallback",
  nameSetAt: null,
  nameSetBy: null,
  subjectHistory: [],
};

const SUMMARY = {
  ok: true,
  instanceId: "inst_1",
  durationMs: 412,
  source: "manual",
  total: 12,
  added: 1,
  subjectUpdated: 2,
  metadataUpdated: 0,
  markedLeft: 0,
  subjectRejected: 0,
  unchanged: 9,
};

/** One request as the test's fetch stub saw it. */
interface Seen {
  url: string;
  method: string;
  body: unknown;
}

interface Answer {
  status?: number;
  body: unknown;
  json?: boolean;
}

/**
 * Install a fetch that answers by address, and record what was asked. Nothing
 * here reaches a server: the point is the request this module makes and what it
 * does with the answer.
 */
function stubFetch(answers: readonly Answer[]): Seen[] {
  const seen: Seen[] = [];
  let index = 0;
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    seen.push({
      url: String(input),
      method: init.method ?? "GET",
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const answer = answers[Math.min(index, answers.length - 1)]!;
    index += 1;
    return new Response(answer.json === false ? String(answer.body) : JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  return seen;
}

/** The code a rejected call carries; the error map is what turns it into copy. */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code ?? "no code";
  }
  return "resolved";
}

/** Seed the cache with the read a scope mounts, as `useResource` would. */
function seed(scope: Scope, rows: readonly GroupRow[], syncedAt: string | null = null): void {
  const key = groupsKey(scope);
  const id = scope.kind === "instance" ? GROUPS_INSTANCE : GROUPS_ALL;
  const write = resourceCache.begin(key, id);
  resourceCache.resolve(write, { groups: rows, syncedAt });
}

function frame(data: unknown): StreamFrame {
  return { id: "1", type: "group.updated", data };
}

const RENAMED = {
  type: "group.updated",
  instanceId: "inst_1",
  groupJid: ROW.groupJid,
  changes: ["subject"],
  name: "Ops Team 2",
  previousName: "Ops Team",
  nameSetAt: "2026-09-14T09:00:00Z",
  state: "active",
  occurredAt: "2026-09-14T09:00:01Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
  resourceCache.clear();
});

describe("the two group reads (§7.5, R11)", () => {
  test("the global address reads the cross-instance route", async () => {
    const seen = stubFetch([{ body: { groups: [{ ...ROW, instanceId: "inst_1", instanceLabel: "Ops" }] } }]);

    const data = await readAllGroups();

    expect(seen[0]).toMatchObject({ url: "/api/groups", method: "GET" });
    expect(data.groups[0]).toMatchObject({ instanceId: "inst_1", instanceLabel: "Ops" });
    expect(data.syncedAt).toBeNull();
  });

  test("the instance address reads that instance's route, percent-encoding the id", async () => {
    const seen = stubFetch([{ body: { instanceId: "inst/1", syncedAt: "2026-09-14T07:00:00Z", groups: [ROW] } }]);

    const data = await readInstanceGroups(INSTANCE);

    expect(seen[0]!.url).toBe("/api/instances/inst_1/groups");
    expect(data.syncedAt).toBe("2026-09-14T07:00:00Z");
    await expect(readInstanceGroups({ kind: "instance", instanceId: "a/b" })).resolves.toBeTruthy();
    expect(seen[1]!.url).toBe("/api/instances/a%2Fb/groups");
  });

  test("a name the read model already filled in is passed through, never blanked", async () => {
    stubFetch([{ body: { groups: [FALLBACK] } }]);

    const data = await readAllGroups();

    expect(data.groups[0]!.name).toBe("(unnamed group) 120363043123456789");
    expect(data.groups[0]!.nameSource).toBe("fallback");
  });

  test("the server's own code survives a failure, and nothing else does", async () => {
    stubFetch([{ status: 502, body: { error: "the WhatsApp service is unreachable", code: "worker_unreachable" } }]);

    expect(await codeOf(readAllGroups())).toBe("worker_unreachable");
  });

  test("a row this build cannot read is a decode failure, not a guessed row", async () => {
    stubFetch([{ body: { groups: [{ ...ROW, state: "syncing" }] } }]);

    expect(await codeOf(readAllGroups())).toBe("decode_error");
  });

  test("an answer that is not JSON is a decode failure", async () => {
    stubFetch([{ body: "<html>not json</html>", json: false }]);

    expect(await codeOf(readAllGroups())).toBe("decode_error");
  });
});

describe("assign and whitelist writes (P5)", () => {
  test("writes only the field that changed, at the group's own address, naming the instance", async () => {
    const seen = stubFetch([{ body: { group: { ...ROW, assigned: true } } }]);

    const row = await setGroupConfig({
      groupJid: "120363043123456789@g.us",
      instanceId: "inst_1",
      patch: { assigned: true },
    });

    expect(seen[0]!.url).toBe("/api/groups/120363043123456789%40g.us");
    expect(seen[0]!.method).toBe("PATCH");
    expect(seen[0]!.body).toEqual({ assigned: true, instanceId: "inst_1" });
    expect(row.assigned).toBe(true);
  });

  test("the row that comes back is the server's, not the value that was asked for", async () => {
    stubFetch([{ body: { group: { ...ROW, whitelisted: false } } }]);

    const row = await setGroupConfig({ groupJid: ROW.groupJid, patch: { whitelisted: true } });

    expect(row.whitelisted).toBe(false);
  });

  test("a refused write keeps the server's code", async () => {
    stubFetch([{ status: 409, body: { error: "same id on two instances", code: "invalid_request" } }]);

    expect(await codeOf(setGroupConfig({ groupJid: ROW.groupJid, patch: { assigned: true } }))).toBe("invalid_request");
  });
});

describe("Sync now (R-L5)", () => {
  test("posts to the instance's sync route and answers with the worker's own summary", async () => {
    const seen = stubFetch([{ body: SUMMARY }]);

    const summary = await syncInstanceGroups(INSTANCE);

    expect(seen[0]).toEqual({ url: "/api/instances/inst_1/groups/sync", method: "POST", body: undefined });
    expect(summary).toEqual(SUMMARY);
    expect(syncSummaryLine(summary)).toBe("12 groups read, 1 added, 2 renamed, 0 left");
  });

  test("a summary that reports failure is raised, never reported as a success", async () => {
    stubFetch([{ body: { ...SUMMARY, ok: false } }]);

    expect(await codeOf(syncInstanceGroups(INSTANCE))).toBe("group_sync_failed");
  });

  test("a worker failure keeps the code the dashboard explains", async () => {
    stubFetch([{ status: 409, body: { error: "no live session", code: "instance_offline" } }]);

    expect(await codeOf(syncInstanceGroups(INSTANCE))).toBe("instance_offline");
  });
});

describe("a server-returned row lands in the mounted read (R-V2)", () => {
  test("the write's answer replaces the row and keeps the instance the global read added", () => {
    seed(GLOBAL, [{ ...ROW, instanceId: "inst_1", instanceLabel: "Ops" }]);

    applyGroupRow(GLOBAL, { ...ROW, assigned: true }, "inst_1");

    const data = resourceCache.read<{ groups: readonly GroupRow[] }>(groupsKey(GLOBAL))!.data!;
    expect(data.groups[0]).toMatchObject({ assigned: true, instanceId: "inst_1", instanceLabel: "Ops" });
  });

  test("a row this read does not hold leaves it untouched", () => {
    seed(INSTANCE, [ROW]);
    const before = resourceCache.read(groupsKey(INSTANCE))!.data;

    applyGroupRow(INSTANCE, { ...FALLBACK, groupJid: "999@g.us" }, "inst_1");

    expect(resourceCache.read(groupsKey(INSTANCE))!.data).toBe(before);
  });

  test("a sync marks both reads stale, so a mounted one re-reads silently (R-V3)", () => {
    seed(INSTANCE, [ROW]);
    seed(GLOBAL, [{ ...ROW, instanceId: "inst_1", instanceLabel: "Ops" }]);

    invalidateGroupsReads();

    expect(resourceCache.read(groupsKey(INSTANCE))!.stale).toBe(true);
    expect(resourceCache.read(groupsKey(GLOBAL))!.stale).toBe(true);
  });
});

describe("one group.updated frame (R-V1, R-V2, R-V4)", () => {
  test("a rename moves the row in place and states the rename for the header and the scope", () => {
    const before = { groups: [ROW], syncedAt: null };

    const update = groupUpdate(before, frame(RENAMED), INSTANCE);

    expect(update.data.groups[0]).toMatchObject({
      name: "Ops Team 2",
      nameSource: "event",
      nameSetAt: "2026-09-14T09:00:00Z",
      // The name that was on screen becomes the newest entry, with the stamp and
      // the setter it had; the ring keeps its own tail.
      subjectHistory: [
        { name: "Ops Team", at: "2026-09-13T08:12:00Z", by: "4915112345678" },
        ...HISTORY,
      ],
    });
    expect(update.renamed).toEqual({
      scope: { kind: "group", instanceId: "inst_1", groupJid: ROW.groupJid },
      groupJid: ROW.groupJid,
      name: "Ops Team 2",
      previousName: "Ops Team",
      occurredAt: "2026-09-14T09:00:01Z",
    });
    // The previous renamer is not this rename's: the event names nobody.
    expect(update.data.groups[0]!.nameSetBy).toBeNull();
    // R-V1: identity is unchanged, so React keeps the row and its focus.
    expect(update.data.groups[0]!.groupJid).toBe(before.groups[0]!.groupJid);
  });

  test("a frame that carries no name is not a rename: the name on screen stays", () => {
    const before = { groups: [FALLBACK], syncedAt: null };

    const update = groupUpdate(before, frame({ ...RENAMED, name: "", previousName: null, changes: ["subject"] }), INSTANCE);

    // The worker never stores an empty subject, so this is "no name observed".
    expect(update.data.groups[0]).toMatchObject({
      name: FALLBACK.name,
      nameSource: "fallback",
      subjectHistory: [],
    });
    expect(update.renamed).toBeNull();
  });

  test("a fallback name resolves when a real one arrives", () => {
    const update = groupUpdate({ groups: [FALLBACK], syncedAt: null }, frame(RENAMED), INSTANCE);

    expect(update.data.groups[0]).toMatchObject({ name: "Ops Team 2", nameSource: "event", subjectHistory: [] });
  });

  test("a frame that moved nothing keeps the same value, so nothing re-renders", () => {
    const before = { groups: [ROW], syncedAt: null };

    // The group is not in this read, and the frame names it anyway.
    const update = groupUpdate(before, frame({ ...RENAMED, groupJid: "999@g.us" }), INSTANCE);

    expect(update.data).toBe(before);
    expect(update.renamed?.name).toBe("Ops Team 2");
  });

  test("a state change alone moves the state and leaves the name's provenance alone", () => {
    const update = groupUpdate({ groups: [ROW], syncedAt: null }, frame({ ...RENAMED, changes: ["state"], state: "left" }), INSTANCE);

    expect(update.data.groups[0]).toMatchObject({
      state: "left",
      name: "Ops Team",
      nameSource: "sync",
      nameSetBy: "4915112345678",
      subjectHistory: HISTORY,
    });
    expect(update.renamed).toBeNull();
  });

  test("another instance's frame cannot move a row that shares its ID (R-V5)", () => {
    const before = { groups: [{ ...ROW, instanceId: "inst_1", instanceLabel: "Ops" }], syncedAt: null };

    const update = groupUpdate(before, frame({ ...RENAMED, instanceId: "inst_2" }), GLOBAL);

    // inst_1's row is untouched, and the rename is stated for the group it
    // actually happened to: inst_2's, which the global address also shows.
    expect(update.data).toBe(before);
    expect(update.renamed).toMatchObject({
      groupJid: ROW.groupJid,
      name: "Ops Team 2",
      scope: { kind: "group", instanceId: "inst_2", groupJid: ROW.groupJid },
    });
  });

  test("a frame for another instance is not this scope's at all", () => {
    const before = { groups: [ROW], syncedAt: null };

    const update = groupUpdate(before, frame({ ...RENAMED, instanceId: "inst_2" }), INSTANCE);

    expect(update.data).toBe(before);
    expect(update.renamed).toBeNull();
  });

  test("a frame nobody understands changes nothing", () => {
    const before = { groups: [ROW], syncedAt: null };

    expect(groupUpdate(before, frame({ type: "group.updated" }), INSTANCE).data).toBe(before);
  });

  test("the ring keeps its tail when it is full, so the newest rename is still shown", () => {
    const full = {
      ...ROW,
      subjectHistory: Array.from({ length: SUBJECT_HISTORY_CAP }, (_, index) => ({
        name: `Old ${index}`,
        at: null,
        by: null,
      })),
    };

    const update = groupUpdate({ groups: [full], syncedAt: null }, frame(RENAMED), INSTANCE);

    const history = update.data.groups[0]!.subjectHistory;
    expect(history).toHaveLength(SUBJECT_HISTORY_CAP);
    expect(history[0]).toEqual({ name: "Ops Team", at: ROW.nameSetAt, by: ROW.nameSetBy });
    expect(history.at(-1)).toEqual({ name: `Old ${SUBJECT_HISTORY_CAP - 2}`, at: null, by: null });
  });

  test("a replayed rename does not push the same entry twice", () => {
    const already = { ...ROW, subjectHistory: [{ name: ROW.name, at: ROW.nameSetAt, by: ROW.nameSetBy }, ...HISTORY] };
    const counted = { ...already, subjectHistoryCount: already.subjectHistory.length };

    const update = groupUpdate({ groups: [already], syncedAt: null }, frame(RENAMED), INSTANCE);

    expect(update.data.groups[0]!.subjectHistory).toBe(counted.subjectHistory);
  });
});
