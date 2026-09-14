import {
  InstanceListSchema,
  InstanceSnapshotSchema,
  InstanceStatusSchema,
  type InstanceSnapshot,
  type PairingMode,
} from "@butler/shared";
import { z } from "zod";
import { BffRequestError, readJson, resourceKey, scopeLabels, UNREADABLE_BODY, type StreamFrame } from "../../../resource";
import type { Scope } from "../../types";

/**
 * The instances workspace's read model and its one write seam
 * (docs/ui-decision.md §2.3, §4.2 R-V4, §4.5 R-X1; draft §6.5, §7.3).
 *
 * Both addresses this workspace serves read the same §6.5 control plane: the
 * list is `GET /api/instances`, which the BFF proxies to the worker and parses
 * here, so a drift between the Go structs and this build fails as a declared
 * error instead of as `undefined` fields on screen. `POST /api/instances` is the
 * write, and its answer is the new instance's pairing snapshot — the state the
 * operator then pairs, not a created-ok.
 *
 * The one live patch is applied here too. The BFF's `instance.updated` frame
 * carries the stored row (label, runtime status, the group-sync summary), which
 * is a *subset* of a snapshot: a frame moves the fields it carries and leaves
 * the pairing material, the phone number and the timestamps as the last read
 * left them, so a status change cannot blank the QR an operator is scanning.
 */

/** The instances workspace's one declared read (§2.1: one descriptor ⇒ one cache entry). */
export const INSTANCES_ALL = "instances.all";

/**
 * What a read or a patch has just learned about an instance is what the shell's
 * header would otherwise show as a raw id: the scope-label store is the one
 * place a scope's name lives, and the reads and the patches that learn it write
 * it (R-V4). A blank label teaches nothing (`scopeLabels.write` refuses one), and
 * an untaught scope keeps the address's own fallback.
 */
function rememberLabels(instances: readonly InstanceSnapshot[]): void {
  for (const instance of instances) {
    scopeLabels.write({ kind: "instance", instanceId: instance.id }, instance.label);
  }
}

/** Every instance of this deployment, with its live session state (§6.5). */
export async function readInstances(): Promise<readonly InstanceSnapshot[]> {
  const parsed = InstanceListSchema.safeParse(await readJson("/api/instances"));
  if (!parsed.success) throw new BffRequestError(UNREADABLE_BODY);
  rememberLabels(parsed.data.instances);
  return parsed.data.instances;
}

/** What `POST /api/instances` accepts (§6.5). */
export interface CreateInstanceInput {
  label: string;
  mode: PairingMode;
  /** Required by the worker for `code` pairing; refused locally without one. */
  phoneNumber?: string;
}

/**
 * Create the row and begin pairing. The answer is the instance's pairing
 * snapshot, so what the operator sees next is the state the worker is actually
 * in rather than a create that was assumed to have worked.
 */
export async function createInstance(input: CreateInstanceInput): Promise<InstanceSnapshot> {
  const body: Record<string, unknown> = { label: input.label.trim(), mode: input.mode };
  // `omitempty` on the worker's side: a QR instance never carries a number.
  if (input.mode === "code" && input.phoneNumber !== undefined && input.phoneNumber.trim() !== "") {
    body.phoneNumber = input.phoneNumber.trim();
  }

  const parsed = InstanceSnapshotSchema.safeParse(
    await readJson("/api/instances", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  if (!parsed.success) throw new BffRequestError(UNREADABLE_BODY);
  scopeLabels.write({ kind: "instance", instanceId: parsed.data.id }, parsed.data.label);
  return parsed.data;
}

/** The cache key of the one read, for a caller that has to patch or refresh it. */
export function instancesKey(scope: Scope): string {
  return resourceKey(INSTANCES_ALL, scope);
}

/**
 * The `instance.updated` frame the BFF publishes for the `instances` collection
 * (`app/api/stream/route.ts`), as this view reads it: the stored row, which is
 * what a list row and the instance page both show. It is parsed here rather than
 * trusted, so a frame whose status vocabulary has drifted is dropped instead of
 * putting a string this build does not know into a badge.
 */
const InstanceFrameSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  status: z.enum(InstanceStatusSchema.options),
});

/** One parsed frame, as the merge below reads it. */
export type InstanceFrame = z.infer<typeof InstanceFrameSchema>;

/**
 * One row after one frame. A frame that carries no label is not a rename — the
 * worker always stores one, so an empty field is a frame about something else —
 * and the pairing material, the phone number and the timestamps are left as the
 * last read left them, so a status change cannot blank the QR an operator is
 * scanning.
 */
function mergeFrame(row: InstanceSnapshot, patch: InstanceFrame): InstanceSnapshot {
  // A frame that moves nothing returns the row it was given, so the cache's
  // identity comparison sees a no-op and no subscriber renders (R-V1).
  const label = patch.label === "" ? row.label : patch.label;
  if (label === row.label && patch.status === row.status) return row;
  return { ...row, label, status: patch.status };
}

/**
 * One snapshot after one frame, for the instance page's own read. A frame about
 * another instance is not this instance's, and changes nothing (R-V5).
 */
export function applySnapshotFrame(snapshot: InstanceSnapshot, frame: StreamFrame): InstanceSnapshot {
  const parsed = InstanceFrameSchema.safeParse(frame.data);
  if (!parsed.success) return snapshot;
  scopeLabels.write({ kind: "instance", instanceId: parsed.data.id }, parsed.data.label);
  if (snapshot.id !== parsed.data.id) return snapshot;
  return mergeFrame(snapshot, parsed.data);
}

/**
 * One frame against the list, in one pass (R-V1, R-V4). A row the frame does not
 * name is left alone, and the rows are never reordered: a status change is a
 * patch to the row's own cell, not a new list.
 */
export function applyInstanceFrame(
  data: readonly InstanceSnapshot[],
  frame: StreamFrame,
): readonly InstanceSnapshot[] {
  const parsed = InstanceFrameSchema.safeParse(frame.data);
  if (!parsed.success) return data;
  const patch = parsed.data;
  scopeLabels.write({ kind: "instance", instanceId: patch.id }, patch.label);

  let moved = false;
  const instances = data.map((row) => {
    if (row.id !== patch.id) return row;
    const next = mergeFrame(row, patch);
    moved = moved || next !== row;
    return next;
  });
  return moved ? instances : data;
}

/**
 * A created instance, moved into the list the operator is looking at. It is
 * appended in place rather than re-read: the snapshot is the worker's own
 * answer, so the row is the row the server holds, and the panel refreshes the
 * list behind it (R-V3, silent) so the server's own order is restored.
 */
export function applyCreatedInstance(
  data: readonly InstanceSnapshot[],
  created: InstanceSnapshot,
): readonly InstanceSnapshot[] {
  if (data.some((row) => row.id === created.id)) return data;
  return [...data, created];
}
