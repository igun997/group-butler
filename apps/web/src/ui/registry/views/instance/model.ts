import { InstanceSnapshotSchema, type InstanceSnapshot } from "@butler/shared";
import { z } from "zod";
import { BffRequestError, readJson, resourceKey, scopeLabels, UNREADABLE_BODY } from "../../../resource";
import type { Scope } from "../../types";

/**
 * The instance page's read model and its writes (docs/ui-decision.md §2.3, §4.1
 * R-L5, §4.5; draft §6.5, §7.2, §7.3).
 *
 * Two reads, and the split between them is the point. The **snapshot** is the
 * worker's live control-plane state — pairing material included — so pairing,
 * connecting and failing are states this page can show as they happen. The
 * **configuration** is the dashboard's own stored data (§5.1 `instances.config`),
 * read straight from the BFF, so the assistant's scope stays readable and
 * editable while the instance's session is down; that is exactly when an
 * operator wants to narrow it.
 *
 * Every write answers with the state the server now holds: a pairing code is the
 * snapshot the worker returned, a whitelist edit is the list the BFF stored, and
 * a deletion is nothing at all — the row is gone, and this page navigates away
 * rather than rendering a guess about what happened.
 */

/** The instance page's two declared reads. */
export const INSTANCE_SNAPSHOT = "instance.snapshot";
export const INSTANCE_CONFIG = "instance.config";

/** One instance's live control-plane state, as `GET /api/instances/[id]` answers it. */
export async function readInstanceSnapshot(scope: Scope): Promise<InstanceSnapshot> {
  if (scope.kind !== "instance") throw new BffRequestError("invalid_request");
  const parsed = InstanceSnapshotSchema.safeParse(
    await readJson(`/api/instances/${encodeURIComponent(scope.instanceId)}`),
  );
  if (!parsed.success) throw new BffRequestError(UNREADABLE_BODY);
  scopeLabels.write({ kind: "instance", instanceId: parsed.data.id }, parsed.data.label);
  return parsed.data;
}

/**
 * The BFF-owned half of the instance (§5.1, §7.3): the allowlisted configuration
 * this build edits, of which there is exactly one field, because it is the one
 * field anything reads — the assistant's retrieval scope (§7.2).
 */
export interface InstanceConfig {
  instanceId: string;
  groupJidWhitelist: string[];
}

const ConfigSchema = z.object({
  instanceId: z.string().min(1),
  groupJidWhitelist: z.array(z.string()),
});

function parseConfig(body: unknown): InstanceConfig {
  const parsed = z.object({ config: ConfigSchema }).safeParse(body);
  if (!parsed.success) throw new BffRequestError(UNREADABLE_BODY);
  return parsed.data.config;
}

/** The stored configuration, read from the BFF without asking the worker anything. */
export async function readInstanceConfig(scope: Scope): Promise<InstanceConfig> {
  if (scope.kind !== "instance") throw new BffRequestError("invalid_request");
  return parseConfig(await readJson(`/api/instances/${encodeURIComponent(scope.instanceId)}/config`));
}

/**
 * Write the whitelist, and answer with what is stored — including the mirrored
 * `groups.config.whitelisted` rows, whose read is marked stale so a mounted group
 * table re-reads the flags it shows (R-V3: silently, with no skeleton).
 */
export async function writeWhitelist(scope: Scope, groupJidWhitelist: readonly string[]): Promise<InstanceConfig> {
  if (scope.kind !== "instance") throw new BffRequestError("invalid_request");
  return parseConfig(
    await readJson(`/api/instances/${encodeURIComponent(scope.instanceId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ groupJidWhitelist: [...groupJidWhitelist] }),
    }),
  );
}

/**
 * Ask the worker for a pairing code. The answer is the same snapshot shape the
 * read returns, so the code appears on the surface the operator is already
 * looking at rather than in a notification that disappears.
 */
export async function requestPairingCode(scope: Scope): Promise<InstanceSnapshot> {
  if (scope.kind !== "instance") throw new BffRequestError("invalid_request");
  const parsed = InstanceSnapshotSchema.safeParse(
    await readJson(`/api/instances/${encodeURIComponent(scope.instanceId)}/pairing-code`, { method: "POST" }),
  );
  if (!parsed.success) throw new BffRequestError(UNREADABLE_BODY);
  return parsed.data;
}

/**
 * Log the session out, delete the linked device and soft-delete the row — §6.5's
 * one unlinking action. It answers nothing, because there is nothing left to
 * show: the caller leaves the address.
 */
export async function deleteInstance(scope: Scope): Promise<void> {
  if (scope.kind !== "instance") throw new BffRequestError("invalid_request");
  await readJson(`/api/instances/${encodeURIComponent(scope.instanceId)}`, { method: "DELETE" });
}

/** The cache key of the snapshot read, for a write that has to patch it. */
export function snapshotKey(scope: Scope): string {
  return resourceKey(INSTANCE_SNAPSHOT, scope);
}

/** The cache key of the configuration read. */
export function configKey(scope: Scope): string {
  return resourceKey(INSTANCE_CONFIG, scope);
}

/**
 * One snapshot after one `instance.updated` frame, and the list's own version of
 * the same merge. Both live in the instances workspace's model
 * (`views/instances/model.ts`): one event, one parse, one rule about what it
 * moves, so the list and this page cannot disagree about a status change.
 */
export { applyInstanceFrame, applySnapshotFrame, type InstanceFrame } from "../instances/model";
