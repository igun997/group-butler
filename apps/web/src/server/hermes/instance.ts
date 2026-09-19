import type { InstanceSnapshot, InstanceStatus } from "@butler/shared";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { InstanceDoc } from "../repos/instances";
import { stampIso } from "../repos/instances";
import { readHermesPairing, type HermesPairingStatus } from "./pairing";

/**
 * What Hermes reports about the account it owns, read from the state file its
 * gateway maintains. The worker used to own this field and no longer holds a
 * session, so without this the console shows whatever was written last — which is
 * how it comes to say "logged out" about an account that is connected.
 *
 * The file is optional: a deployment that does not share Hermes's data directory
 * simply has no live status, and the instance's own row is the fallback.
 */
function gatewayStatus(root: string | undefined): InstanceStatus | null {
  if (!root) return null;
  const path = join(root, "gateway_state.json");
  if (!existsSync(path)) return null;
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as {
      gateway_state?: string;
      platforms?: Record<string, { state?: string; error_code?: string }>;
    };
    const whatsapp = state.platforms?.whatsapp;
    const platform = whatsapp?.state;
    if (platform === "connected") return "connected";
    if (platform === "connecting" || platform === "reconnecting") return "pairing";
    // An unpaired account is reported as a fatal gateway state, because the gateway
    // exits rather than run without WhatsApp — but it is the ordinary state of a
    // deployment nobody has scanned yet, not a fault. Hermes names the reason, so it
    // can be told apart from a genuine failure instead of showing "Error" on every
    // freshly created instance.
    if (whatsapp?.error_code === "whatsapp_not_paired") return "disconnected";
    if (platform === "fatal" || platform === "error") return "error";
    if (state.gateway_state !== "running") return "disconnected";
    return "disconnected";
  } catch {
    return null;
  }
}

/**
 * One instance as the console's pairing screen reads it, with Hermes standing
 * where the worker used to.
 *
 * The stored row still owns everything that outlives a pairing: the label, when
 * it was created, and the last identity Hermes reported. What changes is where
 * live pairing material comes from — a wizard the BFF is driving rather than a
 * worker session — so this overlays that and leaves the row's own facts alone.
 */

/** The five statuses the console branches on. Anything unrecognised is "not linked". */
const STATUSES: readonly InstanceStatus[] = ["disconnected", "pairing", "connected", "logged_out", "error"];

function storedStatus(value: string | undefined): InstanceStatus {
  return STATUSES.find((status) => status === value) ?? "disconnected";
}

/**
 * The pairing overlay, or nothing when no pairing is in flight. A finished
 * pairing is reported as such for the rest of the process's life so the screen
 * can settle on the connected state instead of falling back to the stale stored
 * row the moment the wizard exits.
 */
function overlay(pairing: HermesPairingStatus | null): { status: InstanceStatus; qr?: string; pairingError?: string } | null {
  if (pairing === null) return null;
  if (pairing.state === "paired") return { status: "connected" };
  if (pairing.state === "failed") {
    return { status: "error", pairingError: pairing.message ?? "Pairing did not finish." };
  }
  return { status: "pairing", qr: pairing.qr ?? undefined };
}

/**
 * The snapshot shape `GET /api/instances/[id]`, `POST .../pair` and
 * `POST .../check` all answer with, so the console polls one shape through the
 * whole flow.
 *
 * `mode` is always "qr": Hermes pairs by scanning only, and reporting "code"
 * would offer the console a button whose every press fails.
 */
export function hermesInstanceSnapshot(doc: InstanceDoc, pairing: HermesPairingStatus | null = readHermesPairing()): InstanceSnapshot {
  const runtime = doc.runtime ?? {};
  const live = overlay(pairing);
  // A pairing in flight is the most current thing there is; failing that, what
  // Hermes says about the account; only then the row's last recorded status.
  const status = live?.status ?? gatewayStatus(process.env.HERMES_DATA_DIR) ?? storedStatus(runtime.status);
  const snapshot: InstanceSnapshot = {
    id: doc._id,
    label: doc.label ?? "",
    mode: "qr",
    status,
    createdAt: stampIso(doc.createdAt) ?? new Date().toISOString(),
  };
  if (runtime.phoneNumber) snapshot.phoneNumber = runtime.phoneNumber;
  if (runtime.botJid) snapshot.botJid = runtime.botJid;
  if (runtime.botLid) snapshot.botLid = runtime.botLid;
  const connectedAt = stampIso(runtime.connectedAt);
  if (connectedAt !== null) snapshot.connectedAt = connectedAt;
  const lastSeenAt = stampIso(runtime.lastSeenAt);
  if (lastSeenAt !== null) snapshot.lastSeenAt = lastSeenAt;
  if (live?.qr !== undefined) snapshot.qr = live.qr;
  if (live?.pairingError !== undefined) snapshot.pairingError = live.pairingError;
  return snapshot;
}
