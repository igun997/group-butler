import type { Metadata } from "next";
import { cache } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PairingLive } from "@/components/instances/pairing-live";
import { RemoveInstance } from "@/components/instances/remove-instance";
import { ScopeForm } from "@/components/instances/scope-form";
import { SyncGroups } from "@/components/instances/sync-groups";
import { OwnerWhitelistForm } from "@/components/instances/owner-whitelist-form";
import { InstanceStatusBadge } from "@/components/shell/status-badge";
import { formatStamp } from "@/lib/instances";
import { requireOwner } from "@/server/auth/require";
import { getDb } from "@/server/mongo";
import { COLLECTIONS } from "@/server/collections";
import { readInstanceConfig } from "@/server/repos/instance-config";
import { getInstanceRuntime, instanceInOrg } from "@/server/repos/instances";
import { authorizedJidsOf } from "@/server/authorized-jids";
import { instanceLabel, listInstanceGroups } from "@/server/repos/groups";
import { hermesInstanceSnapshot } from "@/server/hermes/instance";
import { readHermesPairingAny } from "@/server/hermes/pairing";
import { getInstanceDoc } from "@/server/repos/instances";

/**
 * Whether this instance belongs to the organisation, asked once per request.
 *
 * The check is made in `generateMetadata` as well as here on purpose: Next has
 * already streamed the shell by the time a page body resolves, so a `notFound()`
 * thrown there can no longer change the status line and a missing instance would
 * answer `200`. Metadata resolves before the body, so the refusal is a real 404.
 * `cache` keeps that from costing a second query.
 */
const ownsInstance = cache(async (organizationId: string, id: string): Promise<boolean> => {
  const db = await getDb();
  return instanceInOrg(db, organizationId, id);
});

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const owner = await requireOwner();
  const { id } = await params;
  if (!(await ownsInstance(owner.organizationId, id))) notFound();
  return { title: id };
}

/**
 * One instance's workspace: what the worker says about it, what is stored about
 * it, and the three things an operator can change here.
 *
 * The stored summary is read independently of the worker, so a worker that is
 * down still leaves a usable page: label, group counts and the scope picker come
 * from Mongo, and only the pairing and identity facts go missing.
 */
export default async function InstancePage({ params }: { params: Promise<{ id: string }> }) {
  const owner = await requireOwner();
  const { id } = await params;

  if (!(await ownsInstance(owner.organizationId, id))) notFound();
  const db = await getDb();

  const [label, runtime, config, groups, instanceDoc, organization] = await Promise.all([
    instanceLabel(db, owner.organizationId, id),
    getInstanceRuntime(db, owner.organizationId, id),
    readInstanceConfig(db, owner.organizationId, id),
    listInstanceGroups(db, owner.organizationId, id),
    // The session belongs to Hermes, so the worker cannot answer for it — asking
    // it here would show a console that disagrees with the pairing route behind
    // the same page.
    getInstanceDoc(db, owner.organizationId, id),
    db.collection<{ config?: { autoReplyAuthorizedJids?: unknown } }>(COLLECTIONS.organizations).findOne(
      { _id: owner.organizationId as never },
      { projection: { _id: 0, "config.autoReplyAuthorizedJids": 1 } },
    ),
  ]);

  const groupSync = runtime?.groupSync ?? { groupsObserved: 0, groupsLeft: 0, lastSyncAt: null, lastError: null };
  const live = instanceDoc === null ? null : hermesInstanceSnapshot(instanceDoc, await readHermesPairingAny());
  const status = live?.status ?? runtime?.status ?? "disconnected";

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          href="/instances"
          className="w-fit text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
        >
          All instances
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{label}</h1>
          <InstanceStatusBadge status={status} />
        </div>
        <p className="font-mono text-xs break-all text-muted-foreground">{id}</p>
      </header>

      {live === null ? (
        <section className="rounded-xl border border-border p-4">
          <h2 className="text-sm font-medium">Pairing</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            This instance has no stored row, so there is nothing to pair. The status above is what was last recorded.
          </p>
        </section>
      ) : (
        <PairingLive instanceId={id} initial={live} />
      )}

      <ScopeForm
        instanceId={id}
        groups={groups.map((group) => ({ jid: group.groupJid, name: group.name }))}
        whitelisted={config?.groupJidWhitelist ?? []}
      />
      <OwnerWhitelistForm authorizedJids={authorizedJidsOf(organization?.config?.autoReplyAuthorizedJids)} />

      <section className="rounded-xl border border-border p-4">
        <h2 className="text-sm font-medium">Groups observed</h2>
        <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <div className="flex items-baseline gap-2">
            <dt className="text-muted-foreground">Observed</dt>
            <dd className="tabular-nums">{groupSync.groupsObserved}</dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="text-muted-foreground">Left</dt>
            <dd className="tabular-nums">{groupSync.groupsLeft}</dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="text-muted-foreground">Last sync</dt>
            <dd className="font-mono text-xs">{formatStamp(groupSync.lastSyncAt)}</dd>
          </div>
        </dl>
        {groupSync.lastError ? (
          <p className="mt-2 text-xs text-destructive">Last sync error: {groupSync.lastError}</p>
        ) : null}
        <div className="mt-3">
          <SyncGroups instanceId={id} />
        </div>
      </section>

      <RemoveInstance instanceId={id} label={label} />
    </div>
  );
}
