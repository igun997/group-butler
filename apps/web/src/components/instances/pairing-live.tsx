"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { InstanceSnapshot } from "@butler/shared";
import { PairingPanel } from "./pairing-panel";
import { pairingStage, pollsWhile } from "@/lib/instances";

/** How often the pairing screen re-reads the worker's snapshot while pairing. */
const POLL_MS = 2_000;

/**
 * Keeps one instance's snapshot current while it is pairing, and stops the
 * moment it is not: the worker owns the lifecycle, so the console asks it again
 * rather than waiting for a change stream that does not carry pairing material.
 *
 * Asking again is a `POST /check`, not a re-read: the worker verifies the live
 * socket and reconnects when the credential is still valid, so a poll can turn a
 * stale snapshot into the real one. The same call is what "Check now" runs.
 *
 * The last good snapshot stays on screen if a single poll fails. Pairing is a
 * minutes-long step watched by an operator, and blanking the screen because one
 * request timed out would be worse than a stale second.
 */
export function PairingLive({ instanceId, initial }: { instanceId: string; initial: InstanceSnapshot }) {
  const [snapshot, setSnapshot] = useState<InstanceSnapshot>(initial);
  const [checking, setChecking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const inFlight = useRef(false);

  const polling = pollsWhile(snapshot.status);

  const check = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setChecking(true);
    try {
      const response = await fetch(`/api/instances/${instanceId}/check`, { method: "POST" });
      if (response.ok) {
        setSnapshot((await response.json()) as InstanceSnapshot);
        setFailure(null);
      } else {
        const body: { error?: string } = await response.json().catch(() => ({}));
        setFailure(body.error ?? `The worker did not answer (${response.status}).`);
      }
    } catch {
      setFailure("The worker could not be reached.");
    } finally {
      inFlight.current = false;
      setChecking(false);
    }
  }, [instanceId]);

  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => {
      void check();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [polling, check]);

  const requestCode = useCallback(async () => {
    setChecking(true);
    try {
      const response = await fetch(`/api/instances/${instanceId}/pairing-code`, { method: "POST" });
      if (response.ok) {
        setSnapshot((await response.json()) as InstanceSnapshot);
        setFailure(null);
      } else {
        const body: { error?: string } = await response.json().catch(() => ({}));
        setFailure(body.error ?? `The worker refused the request (${response.status}).`);
      }
    } catch {
      setFailure("The worker could not be reached.");
    } finally {
      setChecking(false);
    }
  }, [instanceId]);

  // The worker answers this one with the snapshot the new pairing attempt is in,
  // so the panel switches to the scan or waiting stage from the same shape it
  // was already polling.
  const pairAgain = useCallback(async () => {
    setChecking(true);
    try {
      const response = await fetch(`/api/instances/${instanceId}/pair`, { method: "POST" });
      if (response.ok) {
        setSnapshot((await response.json()) as InstanceSnapshot);
        setFailure(null);
      } else {
        const body: { error?: string } = await response.json().catch(() => ({}));
        setFailure(body.error ?? `The worker refused the request (${response.status}).`);
      }
    } catch {
      setFailure("The worker could not be reached.");
    } finally {
      setChecking(false);
    }
  }, [instanceId]);

  return (
    <div className="flex flex-col gap-2">
      <PairingPanel
        stage={pairingStage(snapshot)}
        polling={polling}
        checking={checking}
        onCheckNow={check}
        onRequestCode={snapshot.mode === "code" ? requestCode : undefined}
        onPairAgain={pairAgain}
      />
      {failure ? (
        <p role="alert" className="rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
          {failure} The panel above is the last state the worker reported.
        </p>
      ) : null}
    </div>
  );
}
