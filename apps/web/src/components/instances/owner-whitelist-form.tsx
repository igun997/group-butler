"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { displayAuthorizedJid, normalizeAuthorizedJid } from "@/server/authorized-jids";

export function OwnerWhitelistForm({ authorizedJids }: { authorizedJids: string[] }) {
  const router = useRouter();
  const [entries, setEntries] = useState(authorizedJids);
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function add() {
    const jid = normalizeAuthorizedJid(phone);
    if (jid === null) {
      setError("Enter a valid phone number or WhatsApp JID.");
      return;
    }
    setEntries((current) => (current.includes(jid) ? current : [...current, jid].sort()));
    setPhone("");
    setError(null);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/organizations/authorized-jids", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ authorizedJids: entries }),
      });
      if (!response.ok) {
        const body: { error?: string } = await response.json().catch(() => ({}));
        setError(body.error ?? `The owner whitelist was refused (${response.status}).`);
        return;
      }
      router.refresh();
    } catch {
      setError("The server did not answer. The owner whitelist is unchanged.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-xl border border-border p-4" aria-labelledby="owner-whitelist-title">
      <h2 id="owner-whitelist-title" className="text-sm font-medium">Authorized reply owners</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Only these phones can trigger an automatic reply when they mention the assistant in an eligible group.
      </p>
      {entries.length === 0 ? (
        <p className="mt-3 text-sm text-warning">Automatic replies are disabled until an owner phone is saved.</p>
      ) : (
        <ul className="mt-3 flex flex-wrap gap-2" aria-label="Authorized owner phones">
          {entries.map((jid) => (
            <li key={jid} className="flex items-center gap-1.5 rounded-md border border-border py-1 pl-2 pr-1 text-xs">
              <span className="font-mono tabular-nums">{displayAuthorizedJid(jid)}</span>
              <Button type="button" variant="ghost" size="xs" aria-label={`Remove ${displayAuthorizedJid(jid)}`} onClick={() => setEntries((current) => current.filter((entry) => entry !== jid))}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <Input value={phone} onChange={(event) => setPhone(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(); } }} aria-label="Owner phone or WhatsApp JID" placeholder="Add owner phone" disabled={saving} className="max-md:h-11" />
        <Button type="button" variant="outline" onClick={add} disabled={saving} className="max-md:h-11">Add owner phone</Button>
      </div>
      {error ? <p role="alert" className="mt-2 text-sm text-destructive">{error}</p> : null}
      <div className="mt-3">
        <Button type="button" onClick={save} disabled={saving} className="max-md:h-11">
          {saving ? <Spinner /> : null}
          {saving ? "Saving authorized owners" : "Save authorized owners"}
        </Button>
      </div>
    </section>
  );
}
