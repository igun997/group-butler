"use client";

import { useState } from "react";
import { RemoveInstancePanel } from "./remove-instance-panel";

/**
 * `DELETE /api/instances/:id`, behind the two steps the panel renders.
 *
 * A refusal keeps the operator where they are, with the reason: the worker may
 * have failed to log the device out while the instance row survived, and
 * navigating away would imply the removal happened.
 */
export function RemoveInstance({ instanceId, label }: { instanceId: string; label: string }) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function remove() {
    setPending(true);
    setError(undefined);
    let response: Response;
    try {
      response = await fetch(`/api/instances/${instanceId}`, { method: "DELETE" });
    } catch {
      setError("The server did not answer. The instance is unchanged.");
      setPending(false);
      return;
    }

    if (response.ok) {
      // Stays pending: the browser is about to load the list.
      window.location.assign("/instances");
      return;
    }

    const body: { error?: string } = await response.json().catch(() => ({}));
    setError(body.error ?? `The instance was not removed (${response.status}).`);
    setPending(false);
  }

  return (
    <RemoveInstancePanel
      label={label}
      confirming={confirming}
      pending={pending}
      error={error}
      onStart={() => setConfirming(true)}
      onCancel={() => {
        setConfirming(false);
        setError(undefined);
      }}
      onConfirm={remove}
    />
  );
}
