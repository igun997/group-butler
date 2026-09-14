"use client";

import type { InstanceSnapshot } from "@butler/shared";
import Link from "next/link";
import Image from "next/image";
import { PAIRING } from "../../../tokens";
import { utcStamp } from "../../../../components/utc-stamp";

/**
 * The pairing surface (docs/ui-decision.md §4.1 R-L5, §4.6 R-A3, §4.7 R-M7;
 * draft §6.1, §6.5).
 *
 * R-L5 is the rule this exists for: pairing is a long-running *state*, not a
 * load, so it is rendered as a surface with the current step, the time it has
 * been in it, and a way to leave — never as a skeleton, and never as a spinner.
 * The same surface, in the same place, is what a connected instance shows as its
 * identity; nothing here is unmounted to move from one state to the next, which
 * is why the traversal does not reset to first paint.
 *
 * The QR is the worker's own PNG data URL, drawn at a size an operator can scan
 * from a phone; the code is the worker's own string. Neither is derived here: if
 * the worker has not published pairing material, this surface says so rather
 * than drawing a placeholder that would teach the operator to trust it.
 *
 * Connecting is a state change on the worker, and the status badge is the
 * evidence for it (R-A3: tone, words, and a glyph — never a colour alone).
 */

export interface PairingSurfaceProps {
  snapshot: InstanceSnapshot;
  /** Whether a code request is in flight (only a code-mode instance offers one). */
  requesting: boolean;
  onRequestCode(): void;
}

/** What the instance is doing right now, in one sentence (R-L5's "last known step"). */
function stepLine(snapshot: InstanceSnapshot): string {
  switch (snapshot.status) {
    case "pairing":
      return snapshot.mode === "code"
        ? "Waiting for the code to be entered on the phone."
        : "Waiting for the code to be scanned.";
    case "connected":
      return "Linked. Messages and group metadata arrive as they happen.";
    case "logged_out":
      return "Logged out of WhatsApp. The session is gone; stored groups and messages stay readable.";
    case "error":
      return "Pairing stopped before the account linked.";
    case "disconnected":
      return "No live session. The instance is stored, but nothing is connected to WhatsApp.";
    default:
      return "The instance is in a state this build does not know.";
  }
}

/**
 * R-L5's elapsed time. The stamp is the worker's `createdAt`, so the sentence is
 * the same one every operator can reconcile with the document; an unparseable
 * stamp yields no sentence rather than a zero.
 */
function elapsedLine(createdAt: string): string | null {
  const started = Date.parse(createdAt);
  if (!Number.isFinite(started)) return null;
  const startedAt = utcStamp(createdAt);
  if (startedAt === null) return null;
  const seconds = Math.max(0, Math.round((Date.now() - started) / 1000));
  return `${startedAt} · ${durationWords(seconds)}`;
}

/** A coarse, stable duration: an operator needs the scale, not the second. */
function durationWords(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
}

export function PairingSurface({ snapshot, requesting, onRequestCode }: PairingSurfaceProps) {
  const elapsed = elapsedLine(snapshot.createdAt);

  return (
    <div className="pairing-surface">
      <p className="pairing-surface__step">{stepLine(snapshot)}</p>
      {elapsed === null ? null : <p className="pairing-surface__elapsed">{`Started ${elapsed}`}</p>}

      {snapshot.status !== "pairing" ? null : snapshot.qr === undefined ? null : (
        <div className="pairing-surface__code">
          <Image
            className="pairing-surface__qr"
            src={snapshot.qr}
            alt="Pairing QR code. Scan it from WhatsApp's Linked devices screen."
            width={PAIRING.qrSource}
            height={PAIRING.qrSource}
            // The source is already a rendered PNG, so there is nothing for the
            // image optimizer to do; a data URL cannot be fetched by a loader.
            unoptimized
          />
          <p className="pairing-surface__hint">
            On the phone that holds the account, open WhatsApp, then Linked devices, then Link a
            device, and scan this code. The code is replaced as WhatsApp rotates it, and the one
            here is the current one.
          </p>
        </div>
      )}

      {snapshot.status !== "pairing" || snapshot.mode !== "code" ? null : (
        <div className="pairing-surface__code">
          {snapshot.pairingCode === undefined ? (
            <p className="pairing-surface__hint">
              Ask WhatsApp for a code, then enter it on the phone under Linked devices, then Link
              with phone number.
            </p>
          ) : (
            <p className="pairing-surface__value">
              <span className="pairing-surface__value-label">Pairing code</span>
              <code className="pairing-surface__code-value">{snapshot.pairingCode}</code>
            </p>
          )}
          <button
            type="button"
            className="pairing-surface__action"
            aria-busy={requesting ? true : undefined}
            disabled={requesting}
            onClick={onRequestCode}
          >
            {requesting ? "Requesting…" : snapshot.pairingCode === undefined ? "Request a code" : "Request a new code"}
          </button>
        </div>
      )}

      {snapshot.status === "connected" ? (
        <dl className="pairing-surface__identity">
          <div className="pairing-surface__field">
            <dt>Number</dt>
            <dd>{snapshot.phoneNumber ?? ""}</dd>
          </div>
          <div className="pairing-surface__field">
            <dt>Device</dt>
            <dd>{snapshot.botJid ?? snapshot.botLid ?? ""}</dd>
          </div>
          <div className="pairing-surface__field">
            <dt>Connected</dt>
            <dd>{utcStamp(snapshot.connectedAt) ?? ""}</dd>
          </div>
          <div className="pairing-surface__field">
            <dt>Last seen</dt>
            <dd>{utcStamp(snapshot.lastSeenAt) ?? ""}</dd>
          </div>
          <div className="pairing-surface__field">
            <dt>Pairing mode</dt>
            <dd>{snapshot.mode === "qr" ? "QR code" : "Phone code"}</dd>
          </div>
        </dl>
      ) : null}

      {/*
        The worker's own words for a stopped pairing, shown as the value it is:
        the mapped copy above states the state and the way out (R-X4), and this is
        the evidence behind it, rendered as inert text (draft §11.5's rule for
        raw payloads, applied to the one raw field this surface has).
      */}
      {snapshot.pairingError === undefined || snapshot.pairingError === "" ? null : (
        <p className="pairing-surface__reason">
          <span className="pairing-surface__reason-label">Reported by the worker</span>
          <span className="pairing-surface__reason-value">{snapshot.pairingError}</span>
        </p>
      )}

      {/*
        R-L5's leave affordance. Pairing is the worker's, not this page's, so
        leaving is a real and safe thing to do — and it is offered here because a
        long-running state that cannot be left is a trap. It is the framework's
        own `Link`, because this is a literal in-app page address: an anchor to a
        page the app serves is the one thing the lint surface refuses.
      */}
      <p className="pairing-surface__leave">
        Pairing continues on the worker whether or not this page is open.{" "}
        <Link href="/instances">Back to instances</Link>
      </p>
    </div>
  );
}
