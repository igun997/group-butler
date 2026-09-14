"use client";

import { useState } from "react";
import type { PairingMode } from "@butler/shared";
import { CreateInstanceFields, type CreateInstanceErrors } from "./create-instance-fields";
import { createInstanceFailure } from "@/lib/instances";

type Notice = { message: string; retry: boolean };

/**
 * `POST /api/instances`, then straight to the workspace, because pairing happens
 * there. Failures go to the field or the form according to the route's code (see
 * `createInstanceFailure`), and nothing is guessed about the new instance: the
 * worker owns what happens next.
 */
export function CreateInstanceForm() {
  const [mode, setMode] = useState<PairingMode>("qr");
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<CreateInstanceErrors>({});
  const [notice, setNotice] = useState<Notice | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const form = new FormData(event.currentTarget);
    const label = String(form.get("label") ?? "").trim();
    const phoneNumber = String(form.get("phoneNumber") ?? "").trim();

    setPending(true);
    setErrors({});
    setNotice(null);

    let response: Response;
    try {
      response = await fetch("/api/instances", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(mode === "code" ? { label, mode, phoneNumber } : { label, mode }),
      });
    } catch {
      setNotice({ message: "The server did not answer. Check your connection and try again.", retry: true });
      setPending(false);
      return;
    }

    if (response.ok) {
      const created: unknown = await response.json();
      const id = typeof created === "object" && created !== null && "id" in created ? String(created.id) : "";
      // Stays pending: the browser is about to load the pairing screen.
      window.location.assign(id ? `/instances/${id}` : "/instances");
      return;
    }

    const body: { code?: string; error?: string } = await response.json().catch(() => ({}));
    const failure = createInstanceFailure(response.status, body);
    if (failure.field === "label") {
      setErrors({ label: failure.message });
    } else {
      setNotice({ message: failure.message, retry: failure.retry });
    }
    setPending(false);
  }

  return (
    <form onSubmit={onSubmit} noValidate={false} className="flex flex-col gap-4">
      <CreateInstanceFields mode={mode} onModeChange={setMode} errors={errors} pending={pending} />
      {notice ? (
        <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <p>{notice.message}</p>
          {notice.retry ? <p className="mt-1 text-xs">Pressing Start pairing again is worth a try.</p> : null}
        </div>
      ) : null}
    </form>
  );
}
