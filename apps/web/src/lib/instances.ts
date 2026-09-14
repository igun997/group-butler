import type { InstanceSnapshot, InstanceStatus } from "@butler/shared";

/**
 * What the pairing panel shows, derived from one worker snapshot.
 *
 * The worker owns this lifecycle (it is the process holding the WhatsApp socket),
 * so nothing here invents a state: each kind is a reading of what the snapshot
 * already says. Client components import this module, so it must stay free of
 * server-only imports.
 */
export type PairingStage =
  /** A QR to scan. The payload is the worker's data URL, shown as-is. */
  | { kind: "scan"; qr: string }
  /** A code to type on the phone. */
  | { kind: "code"; code: string }
  /** Pairing has begun and the worker has not produced a payload yet. */
  | { kind: "waiting" }
  | { kind: "connected"; identity: InstanceIdentity }
  | { kind: "stopped"; tone: "failure" | "idle"; reason: string };

export type InstanceIdentity = {
  phoneNumber: string;
  botJid: string;
  botLid: string;
  connectedAt: string;
  lastSeenAt: string;
};

/**
 * Only a pairing instance is worth asking about again. Every other status is
 * either finished (connected), finished badly (logged_out, error) or idle
 * (disconnected), so the panel stops the poll rather than growing a stale one.
 */
export function pollsWhile(status: InstanceStatus): boolean {
  return status === "pairing";
}

export function pairingStage(snapshot: InstanceSnapshot): PairingStage {
  switch (snapshot.status) {
    case "pairing":
      if (snapshot.qr) return { kind: "scan", qr: snapshot.qr };
      if (snapshot.pairingCode) return { kind: "code", code: snapshot.pairingCode };
      return { kind: "waiting" };
    case "connected":
      return {
        kind: "connected",
        identity: {
          phoneNumber: snapshot.phoneNumber ?? "",
          botJid: snapshot.botJid ?? "",
          botLid: snapshot.botLid ?? "",
          connectedAt: snapshot.connectedAt ?? "",
          lastSeenAt: snapshot.lastSeenAt ?? "",
        },
      };
    case "logged_out":
      return { kind: "stopped", tone: "failure", reason: "This device was unlinked from the phone." };
    case "error":
      return { kind: "stopped", tone: "failure", reason: snapshot.pairingError ?? "The worker reported an error." };
    case "disconnected":
      return { kind: "stopped", tone: "idle", reason: "This account is not linked right now." };
  }
}

/**
 * A refused `POST /api/instances`, read the way the form needs it: which field to
 * mark, what to say, and whether pressing the button again could plausibly work.
 *
 * The code decides, never the message, and the route's own phrase is preferred
 * because it is the one written for this failure. `field: "form"` means the problem
 * is not attributable to a single input.
 */
export type CreateInstanceFailure = {
  field: "label" | "form";
  message: string;
  retry: boolean;
};

const FALLBACK_FAILURE = "The request was refused";
const UNREACHABLE = "The worker could not be reached";

export function createInstanceFailure(status: number, body: { code?: string; error?: string }): CreateInstanceFailure {
  const phrase = body.error?.trim();
  switch (body.code) {
    case "label_conflict":
      return { field: "label", message: phrase || FALLBACK_FAILURE, retry: false };
    case "invalid_request":
      return { field: "form", message: phrase || FALLBACK_FAILURE, retry: false };
    case "worker_unreachable":
      return { field: "form", message: phrase || UNREACHABLE, retry: true };
    default:
      return { field: "form", message: phrase || `${FALLBACK_FAILURE} (${status})`, retry: true };
  }
}

/**
 * Stamps are rendered in UTC so the server and the browser cannot disagree about
 * what they say, and an absent stamp reads as "never" rather than a date that
 * looks like a fact.
 */
export function formatStamp(iso: string | null): string {
  if (!iso) return "never";
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}
