import { z } from "zod";

/**
 * The worker↔BFF contract (docs/architecture-draft.md §6.7). The Go structs in
 * `apps/worker` are the reference for the wire shape; these zod schemas mirror
 * them so every BFF call parses the worker's JSON and contract drift fails
 * loudly instead of silently producing `undefined` fields.
 */

/** Group lifecycle state (`observed.state`, docs/architecture-draft.md §5.1). */
export const GroupStateSchema = z.enum(["active", "left", "deleted", "suspended"]);
export type GroupState = z.infer<typeof GroupStateSchema>;

/** Where the name came from: a sync snapshot, an event delta, or nothing yet. */
export const GroupNameSourceSchema = z.enum(["sync", "event", "fallback"]);

export const InstanceGroupSchema = z.object({
  groupJid: z.string().min(1),
  name: z.string(),
  nameSource: GroupNameSourceSchema,
  nameSetAt: z.string().nullable(),
  nameSetBy: z.string().nullable(),
  participantCount: z.number().int().nonnegative(),
  isAnnounce: z.boolean(),
  isLocked: z.boolean(),
  state: GroupStateSchema,
  lastActivityAt: z.string().nullable(),
  messageCount: z.number().int().nonnegative(),
  assigned: z.boolean(),
  whitelisted: z.boolean(),
});
export type InstanceGroup = z.infer<typeof InstanceGroupSchema>;

export const InstanceGroupListSchema = z.object({
  instanceId: z.string().min(1),
  syncedAt: z.string().nullable(),
  groups: z.array(InstanceGroupSchema),
});

export const GroupSyncSummarySchema = z.object({
  ok: z.boolean(),
  instanceId: z.string().min(1),
  durationMs: z.number().int().nonnegative(),
  source: z.enum(["connect", "timer", "manual", "event", "message"]),
  total: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  subjectUpdated: z.number().int().nonnegative(),
  metadataUpdated: z.number().int().nonnegative(),
  markedLeft: z.number().int().nonnegative(),
  subjectRejected: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
});
export type GroupSyncSummary = z.infer<typeof GroupSyncSummarySchema>;

/** `instances.runtime.status` — the session vocabulary of §5.1 (`apps/worker/manager.go`). */
export const InstanceStatusSchema = z.enum(["disconnected", "pairing", "connected", "logged_out", "error"]);
export type InstanceStatus = z.infer<typeof InstanceStatusSchema>;

/** The pairing modes `POST /instances` accepts (§6.5). */
export const PairingModeSchema = z.enum(["qr", "code"]);
export type PairingMode = z.infer<typeof PairingModeSchema>;

/**
 * One instance as the §6.5 control plane answers it — `POST /instances`,
 * `GET /instances/{id}` and the pairing-code route all return this. The worker
 * omits unset optional fields (`omitempty`) and exposes QR material only while
 * the instance is pairing, so those fields are optional here.
 */
export const InstanceSnapshotSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  mode: PairingModeSchema,
  status: InstanceStatusSchema,
  phoneNumber: z.string().optional(),
  botJid: z.string().optional(),
  botLid: z.string().optional(),
  pairingError: z.string().optional(),
  qr: z.string().optional(),
  pairingCode: z.string().optional(),
  connectedAt: z.string().optional(),
  lastSeenAt: z.string().optional(),
  createdAt: z.string(),
});
export type InstanceSnapshot = z.infer<typeof InstanceSnapshotSchema>;

/** `GET /instances` (§6.5). */
export const InstanceListSchema = z.object({ instances: z.array(InstanceSnapshotSchema) });
export type InstanceList = z.infer<typeof InstanceListSchema>;

export const GroupUpdatedEventSchema = z.object({
  type: z.literal("group.updated"),
  instanceId: z.string().min(1),
  groupJid: z.string().min(1),
  changes: z.array(z.enum(["subject", "topic", "announce", "locked", "state", "participants"])),
  name: z.string(),
  previousName: z.string().nullable(),
  nameSetAt: z.string().nullable(),
  state: GroupStateSchema,
  occurredAt: z.string(),
});
export type GroupUpdatedEvent = z.infer<typeof GroupUpdatedEventSchema>;
