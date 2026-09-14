/**
 * The assistant-scope editor's decisions, kept out of the component: whether a
 * selection differs from what is stored, what the request carries, and which
 * groups a search leaves visible.
 *
 * The route takes the whole list (`PATCH /api/instances/:id`) and the stored one
 * is a set, so ordering must never read as a change: a save that only reorders
 * would write an identical list and an audit row saying something moved.
 */
export type ScopeGroup = {
  jid: string;
  name: string;
};

export function scopeIsDirty(whitelisted: readonly string[], selected: readonly string[]): boolean {
  const stored = new Set(whitelisted);
  const next = new Set(selected);
  if (stored.size !== next.size) return true;
  for (const jid of stored) {
    if (!next.has(jid)) return true;
  }
  return false;
}

/** The body the route expects: each group once, in a stable order. */
export function scopePayload(selected: readonly string[]): string[] {
  return [...new Set(selected)].sort();
}

/** Name or JID, case-insensitively, with the operator's stray spaces ignored. */
export function filterGroups<T extends ScopeGroup>(groups: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...groups];
  return groups.filter(
    (group) => group.name.toLowerCase().includes(needle) || group.jid.toLowerCase().includes(needle),
  );
}
