import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ButtonLink } from "@/components/shell/button-link";
import { MessageTranscript } from "@/components/messages/message-transcript";
import { requireOwner } from "@/server/auth/require";
import { getDb } from "@/server/mongo";
import { listAllGroups } from "@/server/repos/groups";
import { listInstances } from "@/server/repos/instances";
import { clampMessageLimit, InvalidMessageCursorError, nextMessageCursor, searchMessages, type MessageRow } from "@/server/repos/messages";

export const metadata: Metadata = { title: "Messages" };

type Search = Record<string, string | string[] | undefined>;

function valueOf(search: Search, key: string): string {
  const value = search[key];
  return typeof value === "string" ? value.trim() : "";
}

function nextHref(params: URLSearchParams, cursor: string | null): string {
  if (cursor === null) return "/messages";
  params.set("cursor", cursor);
  return `/messages?${params.toString()}`;
}

export default async function MessagesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const owner = await requireOwner();
  const search = await searchParams;
  const requestedInstance = valueOf(search, "instanceId");
  const requestedGroup = valueOf(search, "groupJid");
  const query = valueOf(search, "q");
  const cursor = valueOf(search, "cursor");
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (requestedInstance) params.set("instanceId", requestedInstance);
  if (requestedGroup) params.set("groupJid", requestedGroup);

  const db = await getDb();
  const [instances, allGroups] = await Promise.all([
    listInstances(db, owner.organizationId),
    listAllGroups(db, owner.organizationId),
  ]);
  const selectedInstance = instances.some((instance) => instance.id === requestedInstance) ? requestedInstance : "";
  const groups = selectedInstance ? allGroups.filter((group) => group.instanceId === selectedInstance) : [];
  const selectedGroup = groups.some((group) => group.groupJid === requestedGroup) ? requestedGroup : "";
  const limit = clampMessageLimit(50);
  let invalidCursor = false;
  let messages: MessageRow[];
  try {
    messages = await searchMessages(db, {
      organizationId: owner.organizationId,
      query,
      instanceId: selectedInstance || undefined,
      groupJid: selectedGroup || undefined,
      cursor: cursor || undefined,
      limit,
    });
  } catch (error) {
    if (!(error instanceof InvalidMessageCursorError)) throw error;
    invalidCursor = true;
    messages = await searchMessages(db, {
      organizationId: owner.organizationId,
      query,
      instanceId: selectedInstance || undefined,
      groupJid: selectedGroup || undefined,
      limit,
    });
  }
  const nextCursor = nextMessageCursor(messages, limit);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Messages</h1>
        <p className="max-w-[65ch] text-sm text-muted-foreground">
          Search captured text, message metadata, attachment names, and the stored searchable raw message fields. Results remain inside the selected instance and group.
        </p>
      </header>

      <form method="get" className="grid gap-3 rounded-xl border border-border p-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Message filters">
        <label className="grid gap-1.5 text-sm font-medium sm:col-span-2 lg:col-span-1">
          Search messages
          <Input name="q" defaultValue={query} placeholder="Search captured messages" className="max-md:h-11" />
        </label>
        <label className="grid gap-1.5 text-sm font-medium">
          Instance
          <Input name="instanceId" defaultValue={selectedInstance} list="message-instances" placeholder="All instances" className="font-mono max-md:h-11" />
          <datalist id="message-instances">{instances.map((instance) => <option key={instance.id} value={instance.id}>{instance.label || instance.id}</option>)}</datalist>
        </label>
        <label className="grid gap-1.5 text-sm font-medium">
          Group
          <Input name="groupJid" defaultValue={selectedGroup} list="message-groups" placeholder={selectedInstance ? "All groups on this instance" : "Choose an instance first"} disabled={!selectedInstance} className="font-mono max-md:h-11" />
          <datalist id="message-groups">{groups.map((group) => <option key={group.groupJid} value={group.groupJid}>{group.name}</option>)}</datalist>
        </label>
        <div className="flex flex-wrap items-end gap-2 sm:col-span-2 lg:col-span-3">
          <Button type="submit" className="min-h-11">Search messages</Button>
          {(query || selectedInstance || selectedGroup || cursor) ? <ButtonLink href="/messages" variant="outline" className="min-h-11">Clear filters</ButtonLink> : null}
        </div>
      </form>

      {invalidCursor ? (
        <p role="alert" className="rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
          The previous page link is no longer valid. Showing the first page for the current filters.
        </p>
      ) : null}
      <MessageTranscript messages={[...messages].reverse()} filtered={Boolean(query || selectedInstance || selectedGroup)} />
      {nextCursor ? <div><ButtonLink href={nextHref(params, nextCursor)} variant="outline" className="min-h-11">Load older messages</ButtonLink></div> : null}
      {cursor && messages.length === 0 ? <p role="status" className="text-sm text-muted-foreground">There are no older messages in this scope.</p> : null}
      <p className="text-xs text-muted-foreground">Each page contains at most {limit} messages.</p>
    </div>
  );
}
