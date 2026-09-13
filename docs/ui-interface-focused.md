# Group Butler — UI Option A: **The Ledger**

Status: **design option, no product code exists**. This document proposes one interface for the
single-owner dashboard and nothing else. It changes pages and components only; the BFF handler
surface, the Mongo schema, the worker contract, and the send state machine are taken as given.

Companion documents:

| Document | Relationship |
|---|---|
| `docs/architecture-draft.md` | Source of every domain noun, endpoint, status value, and failure mode cited here. Where this document says "§7.3" it means that file. |
| `docs/ui-research-fluent.md` | Accessibility / Fluent-adaptation constraints this option is required to satisfy. Cited as "research §…". |
| `docs/ui-interface-flexible.md` | The other option under consideration (multi-destination, adaptive IA). This one is the opposite bet: **one scope, one canvas, one dock.** |

**Non-fabrication rule (inherited from `ui-research-fluent.md`):** no invented counts, names, group
IDs, message bodies, or metrics appear in this document. Every example uses placeholders in angle
brackets (`⟨group name⟩`, `⟨question⟩`) or the form already present in the architecture draft
(`12036304…@g.us`, `Ops Team` as that draft's own illustrative value).

---

## 0. The stance, in six theses

The option is radical in its *shape*, not in its components: every primitive below is an ordinary
Shadcn dashboard primitive (`Sidebar`, `Resizable`, `Command`, `Tabs`, `Table`, `Sheet`,
`AlertDialog`, `Skeleton`, `Sonner`), composed the way Fluent composes regions rather than the way a
template gallery composes a dashboard.

1. **Scope is the interface.** There is exactly one *scope cursor* — an instance, optionally
   narrowed to one group — carried in the URL. Every read, the AI whitelist, and every write target
   derive from it. The operator never wonders "what am I looking at?" because the answer is in the
   header, in the URL, and in the assistant's scope banner at once.
2. **The read surface cannot write.** The canvas is read-only, permanently. The only place a send
   is created, approved, or scheduled is the dock. R7's human-approval invariant is therefore
   visible in the layout: there is no "send" affordance anywhere near the message you are reading.
3. **One chronology, not four piles.** Messages, media state transitions, group renames/leaves, and
   send lifecycle events share a single time axis. Inspecting activity means correlating
   (a rename, the burst after it, the send that followed), which four separate pages cannot show.
4. **The dock is the state machine you walk.** Ask → Stage → Approve is a pipeline, not three
   features. Each send card renders its own position in `draft → pending_approval → approved →
   scheduled → sending → sent | failed` (§8.1), including the `ambiguous` failure that must never
   auto-retry.
5. **No dashboard.** No KPI cards, no chart gallery, no gauge wall (research §"Design stance").
   Aggregate numbers live in a table-shaped `Pulse` canvas and a 28px status ribbon where they are
   read as *status*, not as decoration.
6. **Server truth is rendered, never predicted.** Loading, error, and pending states are exact and
   enumerated (§5). Status transitions are never optimistic; the interface shows what the server
   says happened, and says so at the moment the server says it.

---

## 1. Interface / component signatures and route & module structure

### 1.1 Route structure — one real route, everything else is a shim

The console is a single authenticated route. Every other URL from §7.6 becomes a server-side 308
redirect that carries the scope into the query string, so bookmarks and chat links from before this
option keep working and the operator lands in the same workspace.

| URL | Render | Query contract |
|---|---|---|
| `/login` | real page, outside the shell (§11.1) | `?next=` |
| `/` | **the console** (only rendering route) | `instance`, `group`, `view`, `q`, `dock` |
| `/instances` | 308 → `/?view=instances` | — |
| `/instances/[id]` | 308 → `/?view=instances&instance=[id]` | — |
| `/groups` | 308 → `/?view=registry` | — |
| `/groups/[jid]` | 308 → `/?view=ledger&group=[jid]` (instance resolved from the record) | — |
| `/messages` | 308 → `/?view=search` | `q` passed through |
| `/sends` | 308 → `/?view=sends` | — |
| `/assistant` | 308 → `/?dock=ask` | — |
| `/stats` | 308 → `/?view=pulse` | — |
| `/settings` | 308 → `/?view=settings` | — |

Query contract, validated by one zod schema in `lib/scope.ts`. Invalid or stale values degrade, they
never throw:

| Param | Type | Default | Degradation rule |
|---|---|---|---|
| `instance` | instance `_id` | first instance by `instances` list order; if no instance exists, the `Pair an instance` empty state | unknown id ⇒ drop the param, keep the group param dropped too, and show one inline notice "That instance is no longer registered." |
| `group` | `groupJid` | none (instance-wide scope) | unknown JID ⇒ drop param + inline notice; group in another instance ⇒ drop param + notice (cross-instance group reads are impossible by design, §7.2) |
| `view` | `ledger` \| `search` \| `registry` \| `sends` \| `pulse` \| `instances` \| `settings` | `ledger` | unknown ⇒ `ledger` |
| `q` | string ≤ 200 chars | empty | longer ⇒ truncated to 200 with the truncation shown in the search field |
| `dock` | `ask` \| `stage` \| `approve` | `approve` when the queue is non-empty, otherwise `ask` | unknown ⇒ the default |

History rules: `instance`, `group`, `view`, `q` are history-worthy (`router.push` on user action).
`dock` is **not** (`router.replace`), so the back button never becomes a tab-stack trap; the palette
can therefore deep-link `/?dock=ask&group=…` without polluting history.

### 1.2 Module structure (only what this option adds or reshapes)

```
apps/web/src/app/(dash)/layout.tsx          # ConsoleShell: auth gate, scope provider, stream provider, toaster
apps/web/src/app/(dash)/page.tsx            # the console; reads + validates searchParams, renders a view
apps/web/src/app/(dash)/{instances,groups,messages,sends,stats,assistant,settings}/**/page.tsx
                                            # 308 shims only (5 lines each)
apps/web/src/components/console/
  shell/console-shell.tsx  scope-spine.tsx  scope-chip.tsx  status-ribbon.tsx  command-palette.tsx
  ledger/activity-ledger.tsx  ledger-row.tsx  ledger-filter-bar.tsx  media-thumb.tsx  raw-payload.tsx
  registry/group-registry-table.tsx  instance-table.tsx  whitelist-editor.tsx
  pulse/pulse-canvas.tsx  pulse-panels.tsx
  dock/dock.tsx  ask-panel.tsx  stage-panel.tsx  approve-panel.tsx  send-card.tsx
       send-composer.tsx  dispatch-timeline.tsx  approve-dialog.tsx  schedule-popover.tsx
  feedback/{skeletons.tsx,empty-state.tsx,error-state.tsx,inline-alert.tsx,toaster.tsx,announcer.tsx}
apps/web/src/hooks/{use-scope.ts,use-ledger-stream.ts,use-media-url.ts,use-dock.ts}
apps/web/src/lib/{scope.ts,transitions.ts,feedback.ts,error-copy.ts,format.ts,name-fallback.ts}
apps/web/src/server/**                      # unchanged from §4 / §7; no new server modules
```

Server components read through the same `src/server/*` accessors the route handlers use (no
self-HTTP hop); client components call the §7.3 handlers. Both sides are typed by
`packages/shared`. If the architecture owner mandates handler-only access, the shell swaps its
accessor calls for `fetch` — **component props and states below are unaffected**, which is the
point of keeping every data shape in `packages/shared`.

### 1.3 Cross-cutting types

```ts
type Scope = {
  instanceId: string;            // always present once an instance exists
  groupJid: string | null;       // null = the whole instance
  view: View;                    // see §1.1
  q: string;                     // ledger/search query text
  dock: DockTab;
};

type ScopeDescriptor = {         // what the server tells the UI about this scope
  instance: { id: string; label: string; status: InstanceStatus; phoneNumber?: string };
  group: null | { groupJid: string; name: string; nameSource: NameSource; state: GroupState };
  whitelistCount: number;        // instances.config.groupJidWhitelist.length (§7.2)
  aiEnabled: boolean;            // config.aiEnabled AND whitelistCount > 0
  aiDisabledReason: null | 'no_whitelist' | 'disabled_in_config' | 'over_budget';
  groupCount: number;            // groups observed for this instance (§7.5)
  live: 'sse' | 'polling';       // §7.4
};

type LedgerItem =                 // one row in the single chronology (§0 thesis 3)
  | { kind: 'message';    id: string; at: Date; groupJid: string; groupName: string;
      sender: { jid: string; display: string }; text: string;
      media: MediaState; flags: { edited: boolean; revoked: boolean } }
  | { kind: 'media';      id: string; at: Date; groupJid: string; messageId: string; state: MediaState }
  | { kind: 'group';      id: string; at: Date; groupJid: string; change: GroupChange }
  | { kind: 'send';       id: string; at: Date; sendRequestId: string; status: SendStatus;
      groupJid: string; errorClass: SendErrorClass | null };

type SendCardModel = {            // the dock's unit of work (§8.1, §8.2)
  id: string; status: SendStatus; mode: 'immediate' | 'scheduled'; scheduledFor: Date | null;
  target: { instanceId: string; groupJid: string; groupName: string };
  content: { text: string; media: null | { fileName: string; mime: string; size: number } };
  origin: 'manual' | 'ai_suggestion';
  approval: { state: 'pending' | 'approved' | 'rejected'; note?: string; rejectedReason?: string };
  dispatch: { attempts: number; errorClass: SendErrorClass | null; waMessageId: string | null };
  createdAt: Date; updatedAt: Date;
};

type Feedback =                   // the single shape used for every user-initiated outcome (§5.4)
  | { channel: 'inline';  zone: Zone; code: string; message: string; retry?: 'idempotent' | 'none' }
  | { channel: 'toast';   level: 'success' | 'error'; message: string;
      action?: { label: string; run: () => void } };
```

### 1.4 Component signatures

Each entry lists the props that matter plus the behavior contract this option requires. Everything
is a client component unless marked **RSC**.

```ts
// ── Shell ────────────────────────────────────────────────────────────────────────────────
/** RSC. The only page chrome in the product. Owns the scope provider, the SSE provider,
 *  the command palette, the status ribbon, the toast host, and the two live regions. */
function ConsoleShell(props: {
  scope: Scope; descriptor: ScopeDescriptor;
  children: React.ReactNode;                     // the canvas for `scope.view`
}): JSX.Element;
// contract: renders header (product identity, scope chip, global search trigger, owner menu),
// landmarks `header` / `nav`(spine) / `main`(canvas) / `complementary`(dock) / `contentinfo`(ribbon);
// exactly one `h1` per page — the canvas heading, which is also the scope-change focus target.

/** Scope spine — a scope *selector*, not a module nav. Collapses to a 64px icon rail; at <768px
 *  it becomes a Sheet (research §"Layout and responsive rule"). Never reorders under the cursor. */
function ScopeSpine(props: {
  instances: InstanceRow[]; selectedInstanceId: string;
  groups: GroupRow[]; selectedGroupJid: string | null;
  loading: 'none' | 'instances' | 'groups';
  onSelectInstance(id: string): void; onSelectGroup(jid: string | null): void;
  onSync(instanceId: string): Promise<SyncSummary>;
}): JSX.Element;
// contract: group list sorted assigned-first, then observed.lastActivityAt desc (§7.5);
// each row shows `name` (with the never-blank fallback already applied server-side, §7.5) and the
// full JID in a copyable monospace cell; `whitelisted` and `assigned` are text badges, not dots
// (research: status always has a text label). Rename in place on `group.updated` SSE (§6.6.6).

/** RSC. The immutable scope facts rendered as a definition list (§7.5 provenance). */
function ScopeChip(props: {
  descriptor: ScopeDescriptor;
  onCopyJid(jid: string): void;      // → success toast (§5.4 single allowed info toast)
  onOpenWhitelist(): void;
}): JSX.Element;

// ── Canvas: Ledger ──────────────────────────────────────────────────────────────────────
/** RSC outer + client inner. One time axis; four item kinds; filters are chips, not a form. */
function ActivityLedger(props: {
  scope: Scope; initialPage: { items: LedgerItem[]; nextCursor: string | null };
  filters: LedgerFilters;                 // kinds[], mediaStatus[], sender?, groupJidOverride?
  onFiltersChange(next: LedgerFilters): void;
  onLoadOlder(cursor: string): Promise<{ items: LedgerItem[]; nextCursor: string | null }>;
  onScopeTo(item: LedgerItem): void;      // entry point of the primary loop (§2.2)
}): JSX.Element;
// contract: `ol` with `role="feed"`-free semantics — a plain ordered list whose items are the rows;
// each row is a `li` containing one `button` (the row's single interactive element) that expands
// the row in place. No arrow-key composite widget is simulated (research: arrows only for real
// composite widgets). New items append only when the operator is at the newest edge.

function LedgerRow(props: {
  item: LedgerItem; expanded: boolean; focused: boolean;
  nameCache: Map<string, { name: string; stale: boolean }>;   // §3 — the row never fetches
  onToggle(): void; onCopyJid(jid: string): void; onSendToGroup(jid: string): void;
}): JSX.Element;

function MediaThumb(props: {
  messageId: string; media: MediaState; enrich: EnrichState | null;
}): JSX.Element;
// contract: requests `GET /api/media/[messageId]/url` once on mount and once more after an
// `onError` (single retry, then stop); renders the declared-type chip with its reason for
// `unparsed` / `unavailable` / `failed` (§6.3). Never a bare broken-image icon.

function RawPayload(props: { raw: unknown; truncated: boolean; bytes: number }): JSX.Element;
// contract: `<details>`-style disclosure rendering pretty-printed **text**; never interpreted,
// never `dangerouslySetInnerHTML` (§11.5).

// ── Canvas: Registry / Pulse / Instances / Search ───────────────────────────────────────
function GroupRegistryTable(props: {       // R11 surface; `Table` + `DataTable` patterns
  rows: GroupRow[]; loading: 'initial' | 'refresh';
  onSelectGroup(jid: string): void; onToggleAssigned(jid: string, next: boolean): Promise<void>;
  onSyncAll(): Promise<SyncSummary>;
}): JSX.Element;
// contract: columns Instance · Group ID (copyable) · Name · Name set by/at · State · Assigned ·
// Whitelisted · Last activity. Rename provenance shown as "renamed N×" opening the capped
// `subjectHistory` (§7.5) in a Popover.

function WhitelistEditor(props: {
  instanceId: string; groups: GroupRow[]; whitelist: string[];
  onSave(next: string[]): Promise<void>;     // PATCH /api/instances/[id] (§7.3)
}): JSX.Element;
// contract: every save is confirmed by an AlertDialog naming the count before/after, because the
// diff *is* the AI scope (§7.2.5 writes an auditLog row).

function PulseCanvas(props: {
  tab: 'bots' | 'groups' | 'tokens';
  bots: BotStats | null; groups: GroupStats | null; tokens: TokenStats | null;
  onRecompute(): Promise<void>;               // §10.2 $merge rollup
}): JSX.Element;
// contract: tables and sparkline rows only (§0 thesis 5). Token tab shows
// `rejected[{groupJid, reason:'not_whitelisted'}]` counts as a security metric (§10).

function InstanceCanvas(props: {                 // pairing + per-instance config, one table + Sheet
  instances: InstanceRow[]; selected: string | null; pairing: PairingState | null;
  onCreate(input: { label: string; mode: 'qr' | 'code'; phoneNumber?: string }): Promise<void>;
  onPairingCode(id: string): Promise<void>; onLogout(id: string): Promise<void>;
  onOpenWhitelist(id: string): void; onOpenSettings(id: string): void;
}): JSX.Element;
// contract: `runtime.counters` and `runtime.groupSync` render as text rows inside the instance
// Sheet (§7.5), never as KPI cards. `logged_out` renders the re-pair banner required by §15.

function SettingsCanvas(props: {
  ai: { model: string; maxTokensPerDay: number }; retention: { messagesDays: number };
  ui: { timezone: string }; r2: { bucketHost: string; presignTtlSeconds: number } | null;
  audit: AuditRow[]; nextCursor: string | null;
  onSave(patch: SettingsPatch): Promise<void>; onLoadMore(cursor: string): Promise<Page>;
}): JSX.Element;
// contract: `appSettings` fields only (§5.1). The audit table is read-only, newest first, and is
// the surface the whitelist/budget decision trails point at.

function SearchCanvas(props: { q: string; results: LedgerItem[]; nextCursor: string | null;
  onQuery(next: string): void; onLoadMore(cursor: string): Promise<Page> }): JSX.Element;
// contract: results are LedgerRows; hitting a result sets the scope to its group and switches to
// `view=ledger` focused on that row — search is a way into the ledger, not a destination.

// ── Dock: the only write surface ────────────────────────────────────────────────────────
function Dock(props: {
  scope: Scope; descriptor: ScopeDescriptor;
  pendingCount: number; draftsCount: number;
  answer: AnswerState | null;                 // survives tab switches (§4)
  onTab(next: DockTab): void;
}): JSX.Element;
// contract: `Tabs` with roving tabindex; the panel is kept mounted when hidden so a streaming
// answer and an in-flight approval are never destroyed by a tab switch.

function AskPanel(props: {
  scope: Scope; descriptor: ScopeDescriptor; state: AnswerState;
  onAsk(question: string): void;              // POST /api/assistant, streamed (§7.1)
  onStop(): void; onStageAnswer(part: Citation[] | DraftRef): void; onOpenCall(aiCallId: string): void;
}): JSX.Element;
// contract: disabled with an inline reason when `descriptor.aiDisabledReason !== null` (never a
// toast, §5.4); renders the scope banner from `whitelistSnapshot`; renders tool-call rows
// (`searchMessages`/`listGroups`/`messageContext`/`groupStats`/`draftSend`) with their
// `allowed`/`resultCount`; renders citations as chips that focus ledger rows; renders
// `rejected[]` as one non-blocking line: "N retrieval requests were outside this scope and were
// refused." The panel never displays message text as instructions to the operator (§11.3).

function StagePanel(props: {
  drafts: SendCardModel[]; scope: Scope; assignedGroups: GroupRow[];
  onCreateDraft(input: DraftInput): Promise<SendCardModel>;
  onEditDraft(id: string, patch: Partial<DraftInput>): Promise<SendCardModel>;
  onSubmit(id: string): Promise<SendCardModel>;   // draft → pending_approval (§8.1)
  onDiscard(id: string): Promise<void>;
}): JSX.Element;
// contract: target picker lists only `config.assigned` groups of the current instance (§8.2 —
// approval validates the same thing, so the picker never offers what the server will refuse).
// Submit is a two-step affordance: the composer's primary button is "Submit for approval", never
// "Send".

function ApprovePanel(props: {
  queue: SendCardModel[]; filter: 'pending' | 'scheduled' | 'history';
  onFilter(next: ApproveFilter): void;
  onApprove(id: string, opts: { note?: string; scheduledFor?: Date }): Promise<SendCardModel>;
  onReject(id: string, reason: string): Promise<SendCardModel>;
  onCancel(id: string): Promise<SendCardModel>;
}): JSX.Element;
// contract: cards ordered by `scheduledFor` then `createdAt`; the panel is the only place with
// approve/reject/cancel controls; server response replaces the card, and a subsequent
// `sendRequests` SSE patch replaces it again (§7.4). No optimistic transitions, ever.

function SendCard(props: {
  request: SendCardModel; focused: boolean; stale: boolean;   // stale = SSE gap (§3)
  onApprove(): void; onReject(): void; onCancel(): void; onEdit(): void; onFocusRow(): void;
}): JSX.Element;
// contract: renders status text + icon (never color alone), DispatchTimeline, and an inline
// InlineAlert for the last error with its `errorClass`. `ambiguous` renders the exact copy
// "Delivery unknown — WhatsApp did not confirm. Re-approving may post a second message."
// with a "Re-approve" button (§8.1); no plain "Retry" label is allowed for that class.

function DispatchTimeline(props: { request: SendCardModel }): JSX.Element;
// steps: Draft → Submitted → Approved → Scheduled → Sending → Sent, each with a state of
// done/current/pending/skipped and a timestamp. Failed renders as a terminal step labeled with
// the error class in prose. `sent` step shows the `waMessageId` (copyable).

// ── Feedback kit (§5) ───────────────────────────────────────────────────────────────────
function LedgerSkeleton(props: { rows: number }): JSX.Element;      // §5.1
function TableSkeleton(props: { rows: number; columns: number }): JSX.Element;
function DockCardSkeleton(props: { cards: number }): JSX.Element;
function EmptyState(props: { variant: EmptyVariant; scope: ScopeDescriptor;
  action?: { label: string; run(): void } }): JSX.Element;
function ErrorState(props: { zone: Zone; code: string; message: string; detail?: string;
  onRetry?: () => void }): JSX.Element;      // zone-level; never page-level
function StatusRibbon(props: { descriptor: ScopeDescriptor; queue: { pending: number };
  tokens: { dayTotal: number; budget: number | null }; sync: { lastSyncAt: Date | null;
  lastError: string | null }; onOpenPulse(): void }): JSX.Element;
function CommandPalette(props: { scope: Scope; onRun(action: PaletteAction): void }): JSX.Element;
```

### 1.5 Keyboard map (visible equivalents are mandatory — WCAG 2.1.1)

| Keys | Action | Guard |
|---|---|---|
| `Ctrl/Cmd+K` | Command palette (jump to instance/group, ask, approve, sync, recompute) | never fires while a Dialog/AlertDialog has focus |
| `/` | focus the ledger/search filter field | ignored inside text inputs and the composer |
| `j` / `k` | move row focus in the ledger or the approve queue | ignored inside text inputs |
| `Enter` | expand the focused row / open the focused card | — |
| `a` | approve the focused card (opens ApproveDialog) | only when `status === 'pending_approval'` |
| `s` | schedule the focused card (opens SchedulePopover) | only when the target instance is `connected` |
| `x` | reject the focused card (AlertDialog with a required reason) | only when `pending_approval` |
| `Esc` | close the top overlay; focus returns to the trigger | — |
| `?` | shortcuts dialog | — |

Shortcuts are advertised next to their visible controls (research: "Make the shortcut discoverable
near the trigger"), and `?` lists them; nothing overrides browser or AT shortcuts.

---

## 2. Usage journey

Placeholders only; timings are the ones the architecture commits to (`group.updated` within about a
second of the notification, §7.6; dispatch ticker 5s, §8.3; SSE degrades to 3s polling, §7.4).

### 2.1 First run: no instance yet

1. Owner signs in at `/login` (email + password, §11.1) → `/` with `view=ledger`.
2. The canvas is the **`no_instance` empty state** (not a broken table): "No WhatsApp instance is
   registered yet." + primary action **Register an instance** → `view=instances` canvas.
3. `view=instances` shows the pairing flow (mode `qr` or `code`, §6.5). The status ribbon shows
   `Worker unreachable` if `/api/health` says so, so a pairing failure is attributable.
4. On connect, the spine's group list fills from the first full sync (§6.6.2). Until then the rail
   shows the `groups_loading` skeleton. The ledger shows the `never_had_messages` empty state.
5. Definition of done for this journey (mirrors §16 P0): the registry canvas lists every group as
   `<id>@g.us` next to its current name, and a live rename appears in the spine without a reload.

### 2.2 The primary operator loop: inspect → ask → approve

1. **Inspect.** `/` with `view=ledger`, scope = one instance, no group. The ledger streams one
   chronology: message rows, media state changes, group changes, send events. A 12-row
   `LedgerSkeleton` covers the first paint; older history is loaded by a boundary row, not by
   replacing the list.
2. **Narrow.** The operator clicks a row's group name → `onScopeTo` sets `group=⟨jid⟩` and the
   ledger re-renders scoped (skeleton again, 150ms-deferred). Alternatively `/` + typing in the
   filter field, or `⌘K → ⟨group name⟩`.
3. **Ask.** `dock=ask` is already open (its default when the queue is empty). The panel's scope
   banner reads: scope, `whitelistCount` groups, and the exact list used for the last call
   (`whitelistSnapshot`, §7.2.5). The operator types `⟨question⟩`. The answer streams into the
   panel; tool rows show what was retrieved; citations render as chips.
4. **Escalate.** The answer includes a `draftSend` tool result, or the operator presses **Stage as
   send** on a citation set → a `draft` send card appears in `dock=stage` with `origin` shown as
   `ai_suggestion`. Draft → edit target/text (target picker restricted to `config.assigned`) →
   **Submit for approval** → the card moves to `dock=approve` as `pending_approval`. No path from
   here reaches `sending` without the operator's own approval (§8.1 invariant).
5. **Approve.** The card shows the target group name + JID, the full text, media metadata, and the
   timeline. The operator presses `a` → `ApproveDialog` restates target and consequence, offers an
   optional note and an optional schedule (`SchedulePopover`, must be > now + 30s per §8.2). Confirm.
   The panel shows the card as `approved` (from the server response, not optimistically) and a
   success toast appears with the action **View in queue**.
6. **Watch it land.** The worker claims it within the dispatch interval (§8.3); the `sendRequests`
   SSE patch moves the card to `sending`, then `sent` with the `waMessageId`. The ledger gains a
   `send` row at the same timestamp, so the group's chronology and the send outcome are the same
   screen.
7. **Elapsed per step:** no full-page navigation occurred. Every step is in-place, which is the
   entire justification for the single-canvas bet (§6).

### 2.3 Ambiguous send (the case the layout is designed around)

1. Card reaches `failed` with `dispatch.errorClass === 'ambiguous'` (§8.3).
2. Inline alert on the card: "Delivery unknown — WhatsApp did not confirm. Re-approving may post a
   second message." + **Re-approve** (the only correct affordance, §8.1).
3. No toast is emitted for this transition (§5.4: system outcomes are not toasts).
4. Re-approve runs the same ApproveDialog with an appended warning paragraph and requires the
   confirmation checkbox before the primary button enables — a deliberate friction, because the
   alternative is a duplicate message in a group.

### 2.4 Operator changes AI scope

1. `view=registry` (or the scope chip's **Whitelist** action) → `WhitelistEditor` over the group
   table. Renames and rename provenance are visible in the same table, so scope decisions are made
   with naming context (§7.5).
2. Save → AlertDialog "AI scope changes from N to M groups" → `PATCH /api/instances/[id]` →
   success toast → spine badges update. The Ask panel's banner updates on the next request, because
   the list is read per request and never cached across requests (§7.2.6).
3. If the whitelist becomes empty, the Ask panel switches to the `no_whitelist` inline state with
   the action **Choose groups**, and `Ask` is disabled — never a toast, never a silent no-op.

### 2.5 Budget exhausted

1. `appSettings.ai.maxTokensPerDay` / `instances.config.aiMaxTokensPerDay` reach their ceiling.
2. The dock's Ask panel shows the `over_budget` state: today's total, the ceiling, and when the day
   rolls over in `appSettings.ui.timezone`. The ribbon's token segment turns into a filled bar with
   the same numbers. No toast, because nothing the operator just did failed.

---

## 3. Complexity hidden internally

Each row: what the operator sees → what the interface must hide → where the hiding lives.

| Operator sees | Hidden mechanism | Owned by |
|---|---|---|
| A group name on every row, always non-empty | `observed.subject` may be `""` right after discovery; the BFF's never-blank fallback (`"(unnamed group) ⟨shortJid⟩"`, §7.5) is applied server-side, so no component ever branches on emptiness | `lib/name-fallback.ts` (client mirror for optimistic rows only) + BFF |
| A rename appearing "immediately" | `group.updated` SSE patch (§6.6.6) vs. periodic sync (§6.6.2) vs. 3s polling fallback (§7.4) — three transports, one row patch | `use-ledger-stream.ts` |
| Group names on message rows | 60s in-process name cache behind `{instanceId, groupJid}` (§7.5); rows receive a resolved `nameCache` map and never fetch | `hooks/use-ledger-stream.ts`, BFF cache |
| Media that "just shows up" | presigned URL minting (`R2_PRESIGN_TTL_SECONDS`, §11.4), one retry on expiry, then the declared-type chip with `reason` | `use-media-url.ts`, `MediaThumb` |
| A send that moves by itself | BFF approval → worker `findOneAndUpdate` claim with lock staleness (§8.3) → `sending`/`sent` patches; the UI never runs a timer or assumes an ack | `use-ledger-stream.ts`, `DispatchTimeline` |
| "Only what I'm allowed to see" | Whitelist closure over frozen `allowed` set + Mongo `$in` filter + `aiCalls.rejected` (§7.2) — the UI receives a `ScopeDescriptor`, never the scope-filtering logic | `src/server/ai/**` (unchanged) |
| Exact token accounting | Enrichment calls also write `aiCalls` and `$inc` `statsDaily.tokens` (§9); the ribbon and Pulse read the same rollup | `src/server/stats/**` (unchanged) |
| Numbers that survive worker downtime | live counters vs. idempotent `$merge` rollups (§10) — Pulse shows rollup-computed values and the rollup timestamp | `PulseCanvas` |
| Clock/timezone sanity | all timestamps UTC; rendering in `appSettings.ui.timezone`; `serverSkewMs` shown only in the raw payload | `lib/format.ts` |
| Why an action was refused | worker `{error, code}` codes (§6.5) mapped once to human copy and to a retry class | `lib/error-copy.ts`, `lib/feedback.ts` |
| Which transitions are legal right now | one `getAvailableTransitions(status, connectivity)` function drives card buttons, keyboard guards, and the palette | `lib/transitions.ts` |
| Paging, dedupe, ordering | cursor pagination; SSE inserts deduped by `waMessageId`/`_id` against the optimistic-free list; out-of-order inserts sorted by `timestamp` | `ActivityLedger` |

Rule: a component that needs one of these hides it **once**, in `lib/` or a hook, and the component
receives plain data. If two components would each implement a rule, the rule moves to `lib/`.

---

## 4. Tradeoffs

| Decision | What it buys | What it costs | Mitigation in this design |
|---|---|---|---|
| **One rendering route**, everything else a 308 shim | Zero context loss across the loop; one place where scope, stream, and errors are wired; the UI cannot show two scopes at once | A URL no longer implies a page — "share this page" means "share this scope"; deep-link history is coarser | File routing is preserved for compatibility; `view` is history-worthy; the palette shows the canonical scope URL with a copy action |
| **Read surface cannot write** | R7 made structural: no accidental send from a message row | Repeating a recurring announcement takes an extra hop to the dock | Palette action `Compose` and the Stage panel's **Duplicate draft** cover the repeat case without weakening the invariant |
| **Single scope cursor** | No cross-scope confusion; a query can never silently widen | Operators comparing two groups must switch scope twice | Side-by-side comparison is deliberately *not* offered; the registry table (all groups, one instance) answers "which group" questions without message content, and `⌘K` shows recent scopes |
| **One dock with three tabs** | One write surface, one place for pipeline state | Asking and approving compete for the same 360px column | Answers and in-flight transitions survive tab switches (panel kept mounted); the Approve tab carries a count badge; the queue is also a full canvas at `view=sends` |
| **Merged chronology** | Correlation across message/media/rename/send — the actual inspection task | Mixed-density rows; filtering is needed more often | Kind chips are always visible; filter state is in the URL; each kind renders a fixed row height so scanning is stable |
| **No optimistic status transitions** | The card can never claim an approval the state machine refused | Approve feels one round-trip slower than it could | The button's `pending` state is immediate, the response replaces the card, and the SSE patch confirms dispatch separately — the operator sees a truthful three-stage acknowledgement |
| **Fixed row geometry (56/40/96px)** | Skeletons match content exactly; no layout shift; cheap virtualization | Long text must truncate | Truncation is clamped with a full accessible label and an expand-in-place control; nothing important is only in the truncated region |
| **Fluent-depth restraint (acrylic only in chrome/overlays)** | Dense text keeps AA contrast | Less "designed" surface | Solid fallback behind translucent layers, `@supports (backdrop-filter: …)` gate, and contrast checked on the fallback first |
| **Keyboard-first** | The loop is fast for the sole operator | Hidden affordance; touch users are slower | Every shortcut has a visible control, the palette has a visible trigger in the header, `?` documents the map |
| **Pulse as tables + sparklines** | Honest, scannable, no decorative charts | Less "executive" feel | Sparkline rows carry a text value and the rollup timestamp (§10) |
| **Polling fallback shows `Live: polling (3 s)`** | Honesty about staleness | A visible imperfection | It is a ribbon segment, not a banner, and it is the only place indicating degraded liveness |

---

## 5. Interaction rules: skeleton / toast / empty / error / loading

### 5.1 Skeleton loading (exact)

| Rule | Value |
|---|---|
| Applies to | **Initial load** of a zone, and **scope changes** that invalidate the zone's content. Never to background refresh. |
| Show delay | Skeleton mounts only if the zone is still unresolved after **150 ms**. |
| Minimum visible | **300 ms** once shown. If data arrives sooner, the skeleton is held for the remainder — this prevents a one-frame flash. |
| Geometry | Ledger row `56px` × **12** rows; table row `40px` × **8** rows × real column widths; dock card `96px` × **3** cards; text line `20px`. Skeletons reuse the real grid/column definitions, not a copy. |
| Content | Static neutral blocks in `--muted` at `0.6` opacity. **No fake names, IDs, text, timestamps, avatars, counts, or badge shapes** (research: skeletons must not look clickable or carry fake data). |
| Motion | Shimmer/pulse is `motion-safe:` gated; with `prefers-reduced-motion: reduce` the blocks are static. |
| ARIA | The zone region gets `aria-busy="true"` for the duration; every skeleton primitive is `aria-hidden="true"`; **one** visually hidden status per zone: `Loading ⟨zone⟩ for ⟨scope⟩`. No per-row live regions. |
| Announcement | The shell's polite region announces completion only if the load took **> 1000 ms**: `⟨zone⟩ loaded` (counts optional, never bodies). Pagination under **400 ms** is silent. |
| Background refresh | Content is retained, `aria-busy="false"` (the content is still valid), and a `2px` indeterminate bar with `aria-hidden="true"` appears in the zone header. No skeleton. |
| Pagination | Three skeleton rows appended after the last real row ("history boundary", research). Existing rows are never replaced or reordered. |
| No-skeleton zones | The dock's composer, the filter bar, the ribbon, and the spine's selected row are never skeletonized while in use — they keep their content and show a small "refreshing" indicator instead. |
| Data arriving during skeleton | Swap in the same commit as the resolution; scroll position preserved; no animated reflow beyond the 150 ms Fluent decelerate fade (`cubic-bezier(0,0,0,1)`) on the container, `motion-safe:` only. |

### 5.2 Empty states (exact)

Seven variants, each with a required heading, a required single primary action, and no illustration
that hides the reason. Empty is never an error; error is never an empty state.

| Variant | Trigger | Heading | Body | Primary action |
|---|---|---|---|---|
| `no_instance` | `instances` list is empty | "No WhatsApp instance is registered yet" | "An instance links one WhatsApp account; its groups and messages appear here." | Register an instance |
| `not_paired` | instance exists, `runtime.status ∈ {disconnected, pairing, logged_out}` | "⟨instance label⟩ is not connected" | Names the current status in words and the last known `pairingError` if any | Open pairing |
| `never_had_messages` | scope resolved, zero messages ever for the scope | "No messages captured yet for ⟨scope name⟩" | "Ingest starts when the instance is connected and the group is a participant." | Sync groups |
| `no_search_results` | query/filters active, zero rows | "No ⟨items⟩ match the current filters" | Lists the active filters as removable chips | Clear filters |
| `group_left` | `group.state ∈ {left, deleted}` | "⟨group name⟩ is ⟨left the account / deleted⟩" | "Messages already ingested remain searchable." | Show history |
| `no_whitelist` | `descriptor.aiDisabledReason === 'no_whitelist'` | "AI scope is empty for ⟨instance label⟩" | "Assistant requests are refused until at least one group is whitelisted." | Choose groups |
| `queue_empty` | approve queue empty, filter `pending` | "Nothing is waiting for approval" | "Drafts you stage appear here." | Open Stage |

Rules: the empty state's action is the first focusable element in that region; the region's heading
is `h2` under the canvas `h1`; a disabled empty-state action must name its prerequisite in the body
text instead of being silently disabled.

### 5.3 Error states (exact)

Errors are **zone-scoped**: the failure is rendered where the missing data would have been, previous
valid content is retained, and only the affected controls are disabled. A page-level error screen
exists only for a failed session (§11.1) and for a failed first paint of the shell.

| Condition | Zone | Rendering | Copy | Retry |
|---|---|---|---|---|
| Session missing/expired (`401`) | shell | full-page `ErrorState` variant `session`; SSE closed; in-flight dialogs closed and focus returned | "Your session has ended. Sign in to continue." | Sign in → `/login?next=⟨current scope URL⟩` |
| Mongo unavailable (§15) | any data zone | zone `ErrorState` with code `mongo_unavailable`; ribbon shows `Data unavailable` | "The database is not reachable. Ingest continues; this view cannot load." | Retry (idempotent read) |
| Worker down (§15) | ribbon + dock | ribbon segment `Worker unreachable`; sends panels show a **queued** hint, not an error | "The worker is offline. Approved sends wait for it to return." | Retry probe every 10s; manual Retry |
| R2 unavailable (§15) | `MediaThumb` only | chip with `media.status` and `reason`; rest of the row unaffected | "Media ⟨status⟩ · ⟨reason⟩" | Thumb retry once, then none |
| Worker restart mid-send (§15/§8.3) | `SendCard` | `failed`, `errorClass` shown in prose | `ambiguous` copy per §2.3; other classes get class-specific copy | Class-dependent: `ambiguous` ⇒ Re-approve; `auth` ⇒ Check pairing; `rejected`/`transport` ⇒ Re-approve after inspection |
| SSE gap / `Mongo not a replica set` (§7.4) | ribbon | `Live: polling (3 s)`; content otherwise identical | — | Automatic; reconnect with backoff when SSE is available |
| `409 ai_no_whitelist` (§7.2) | Ask panel | inline `no_whitelist` state; the question text is preserved in the composer | "This instance has no whitelisted groups, so the assistant is disabled." | Choose groups |
| `429` token budget (§7.1) | Ask panel | inline `over_budget` state with day total, ceiling, reset time | "Today's token budget is exhausted." | None (a retry cannot succeed); the ribbon shows the same numbers |
| `ai_no_whitelist`/`not_whitelisted` inside a call (§7.2.3) | Ask panel | one line under the answer: `⟨N⟩ retrieval requests were outside this scope and were refused.` + link to the call's `aiCalls` row | — | — |
| Worker error code (§6.5) | owning zone | `InlineAlert` with the human copy and the raw `code` in a copyable monospace span | `error-copy.ts` map | Per code: `retryable` vs `terminal` |
| Network offline | ribbon + all write controls | writes disabled with the reason "Reconnect to ⟨action⟩"; readability unaffected | — | Automatic on `online`; **approval is never queued client-side** |
| Group not found for a deep link | ledger zone | inline notice, scope repaired per §1.1 | "That group is no longer in the local registry." | Auto (scope already repaired) |

Rules: never show a stack trace; always include the stable `code`; always state what still works
(e.g. "ingest continues"); a retry button appears only when the operation is idempotent, and for
state transitions "Retry" must re-open the confirmation rather than re-issue the transition.

### 5.4 Toast rules (exact)

Toasts acknowledge **the operator's own completed action**. They never report system state, never
report background events, and are never the only evidence of a failure.

| Rule | Value |
|---|---|
| Host | One `Toaster` mounted in `ConsoleShell` (mounted eagerly, so the live region exists before the first toast). Position `bottom-right`; `bottom-center` below `640px`. |
| Allowed triggers | (a) dialog-scoped action succeeded: approve, reject, cancel, create/edit/submit draft, whitelist save, sync groups, recompute rollup; (b) clipboard writes (`Group ID copied`); (c) a promise-backed action's single updating toast (`loading → success/error`). |
| Forbidden triggers | message arrival; media state change; group rename; send transition to `sending`/`sent`; **any load failure**; form validation errors (inline field errors instead); `ai_no_whitelist`/`over_budget` (inline dock states); SSE reconnect. |
| Levels | `success` (auto-dismiss 4 s), `error` (persistent, explicit dismiss). No `warning` toasts — budget/whitelist warnings live in the dock and ribbon where their action is. |
| Stacking | Max **3** visible; newest on top; excess queued; auto-dismiss pauses on hover and on focus-within (Sonner default) and resumes after. |
| Dedupe | Key `${action}:${targetId}`; an identical key within 5 s replaces the existing toast instead of adding one. |
| Content | Short label + icon + text; **status is never conveyed by color alone**; exactly one action when the action is safe. Actions navigate by setting the scope (e.g. `View in queue` focuses the card, `Open call` focuses the `aiCalls` row) — a toast never opens a Dialog. |
| Error toast + inline mirror | Every error toast is mirrored by an `InlineAlert` in the owning zone, so dismissing the toast leaves the evidence. |
| Announcements | Sonner's live region; success is `polite`, error is `assertive`. The shell also exposes `role="status"` (polite, atomic) for zone/stream announcements and `role="alert"` for hard failures — one of each per document, never nested. |
| Copy rules | Present tense, name the object, no exclamation marks, no raw codes in the sentence (code goes in the alert), e.g. `Send approved · queued for dispatch`. |
| Undo | **No undo toasts.** The state machine has no reverse transitions for approve/reject/cancel (§8.1). Where a redo is meaningful the toast offers a *create-new* action (`Re-open as draft`), which creates a new `sendRequest` with its own `idempotencyKey` instead of mutating a terminal one. |

### 5.5 Loading / in-flight (exact)

| Rule | Value |
|---|---|
| Spinner delay | A control shows `pending` immediately (label changes, `aria-busy="true"`, disabled) but a spinner is only rendered after **150 ms** in flight, so sub-150 ms operations do not flicker. |
| Scope of disabling | Only the initiating control. The zone, the dock, and the ledger stay interactive; concurrent actions on different cards are allowed. |
| Label change | `Approve → Approving…`, `Submit for approval → Submitting…`, `Sync now → Syncing…`. The accessible name follows the visible label. |
| Optimistic UI | Permitted **only** for pure-view state: dock tab, row expand/collapse, filter chips, palette open. Prohibited for every status transition, whitelist save, and send creation. |
| Long operations | `Sync now` and `Recompute rollup` stream progress into an `InlineAlert`-styled region (counts when the endpoint returns them, §6.5 sync summary); their toast is the promise pattern's single updating toast. |
| Streaming answer | The Ask panel shows a caret + `aria-live="polite"` on the answer container only, throttled to ≤ 1 announcement per 2 s; the panel is never scrolled away while focused; `Stop` is always available. |
| Cancellation | `Stop` (answer), `Cancel` (scheduled send — terminal per §8.1), `Esc` on any dialog. Cancel of a dialog changes nothing on the server. |
| Timeout | Client fetch timeout aborts the request and renders the zone error with `code: 'timeout'` and an idempotent Retry. For transitions, no automatic retry (double-post risk). |
| Truthfulness | The card's status text always comes from the last server payload or SSE patch; the timestamp of the last update is shown on hover so a stalled stream is diagnosable. |

### 5.6 Live-update rules (they interact with all of the above)

- The ledger appends without stealing focus and without moving the focused row. If new items arrive
  while the operator is scrolled away from the newest edge, a `⟨N⟩ new` control appears at the
  bottom edge; clicking it scrolls and appends. Announcements are batched (≤ 1 per 2 s) and count
  only, never bodies.
- Renames patch in place in the spine, the registry, the scope chip, and any visible ledger row's
  group label — one patch, four surfaces, from one event.
- Approve-panel reordering (a `scheduledFor` edit) must not move the focused card; the card is
  reordered after focus leaves it, or the operator is offered "Apply new order".
- Polling fallback: the same patch path, sourced from a 3s poll; the ribbon states which mode is
  active. Components are unaware of the difference.

### 5.7 Accessibility contract (non-negotiable, from the research document)

| Rule | Requirement |
|---|---|
| Landmarks | `header` (identity, scope chip, search, owner menu), `nav` (scope spine), `main` (canvas), `complementary` (dock), `contentinfo` (status ribbon). One `h1` per page: the canvas heading. |
| Headings | Regions are `h2`; nothing skips a level. Dock panel titles are `h2` inside `complementary`. |
| Focus visibility | 2px indicator with 1px offset, drawn with the Shadcn `--ring` token plus a neutral inner line so it survives any surface. Focus and selection are visually distinct. |
| Focus restoration | Closing a Dialog/AlertDialog/Popover/Sheet returns focus to its trigger; removing the focused card (approval completing) moves focus to the next card, or to the panel heading when the queue empties — never to `body`. |
| Initial focus | Never set on page load; only inside a dialog, on the first field. |
| Target size | ≥ 24×24 CSS px for every control (WCAG 2.2), with larger targets for the ledger row's action cluster and the composer's send/submit control. |
| Reflow | No horizontal scrolling of the ledger, the tables, or the composer down to 320px; at 400% zoom the grid becomes one column per region and the spine/dock become Sheets. Long group names truncate with a full accessible label, never clip silently. |
| Color | Status is icon + text label + token color. No green/red-dot-only indicators anywhere. |
| Zoom/AA | Body text ≥ 4.5:1 on its actual background — including on the translucent chrome layers, which is why those layers keep a solid fallback. |
| Live regions | Exactly one polite region (`role="status"`, atomic) and one assertive region (`role="alert"`) for the shell; zone-level announcements route through them. |
| Streaming | The answer container is `aria-live="polite"` with throttled updates; `Stop` remains focusable and operable throughout. |
| Shortcuts | All keyboard actions have visible equivalents; `Ctrl/Cmd+K`, `/`, `j/k`, `a/s/x`, `Esc`, `?` never fire from inside text inputs and never override AT/browser shortcuts. |
| Escape/back | `Esc` closes the top overlay only, and the back button never walks a dock tab stack (§1.1). |
| Reduced motion | Every entrance animation (row insert, panel reveal, skeleton shimmer) is `motion-safe:` gated; with `prefers-reduced-motion: reduce` all of them are absent, including the 150ms fade. |

---

## 6. Design rationale

**Why the loop decides the layout.** The three requirements in the brief — inspect activity, ask a
scoped question, approve a send — are sequential in one operator's head. Any structure that puts
them on different URLs charges the operator a context rebuild three times per loop. The single
canvas plus a resident dock makes the loop one screen with no navigation, and it makes the AI's
scope, the ledger's scope, and the send's target provably the same object (`ScopeDescriptor`).

**Why scope lives in the URL.** It is the one piece of state that must survive a reload, a bookmark,
a link pasted into chat, and the palette's jumps — and it is the same value that determines the AI
retrieval boundary (§7.2.1: "the user picks an instance and optionally a group; nothing else about
scope comes from the client"). Making the URL the carrier keeps the UI from inventing a second
notion of scope and keeps the security property auditable: one value, three consumers.

**Why the canvas cannot write.** §8.1's invariant is "no path to `sending` that does not pass
through `approved`". A UI that puts a composer next to a message creates an implicit promise that
sending is a local act. Separating read and write surfaces means the approval gate is encountered
every time, without a modal-conditioned exception.

**Why four kinds on one axis.** §15 shows that the failures an operator actually investigates are
correlations: a rename during worker downtime, a burst that follows a whitelist change, a send that
lands after a reconnect. Correlating those across four pages is the work; presenting them on one
axis removes it.

**Why the state machine is drawn, not summarized.** `ambiguous` sends (§8.3) exist precisely because
a silent retry can double-post. A card that shows `attempts`, `errorClass`, and the timeline makes
"delivery unknown" legible, and the copy in §2.3 is what stops an operator from pressing a generic
Retry.

**Why Shadcn primitives and not Fluent components.** The research document's stance is adopted
wholesale: Fluent is a *behavior* and *information-design* reference (hierarchy, focus preservation,
reflow, semantic color, calm surfaces), while the primitives stay Shadcn so the shell, the tables,
the dialogs, and the toasts are the ones the ecosystem tests and the team already knows. Fluent's
contribution here is compositional: layered surfaces with restrained elevation
(`shadow2/4/8/16`), a 4px spacing ramp, a 4/6/8px radius set, a type ramp capped at `title3` for
canvas headings, motion durations of `100/150/200/250 ms` with decelerate/accelerate curves, and a
2px focus indicator with a 1px offset that survives every background. "Acrylic"/translucency is
restricted to the shell chrome and overlays (behind which text is always on a solid layer with a
`@supports`-gated fallback), because a data-dense ledger needs contrast more than depth.

**Why these exact loading numbers.** 150 ms is below the threshold where an operator perceives a
wait as a state, and above the point where a cached read flips a placeholder in and out. 300 ms
minimum display prevents the double-flash that makes a fast interface feel broken. Geometry-matched
skeletons are not decoration: they are the reason the ledger does not jump when real rows arrive,
which matters when the operator's eye is already on a row.

**Why toasts are so constrained.** The research document's warning is the design rule: a
disappearing toast must never be the only evidence of a failure. So the split is mechanical —
dialog-scoped and clipboard actions may toast because their result is otherwise invisible once the
dialog closes; everything else reports into the surface that owns it. The corollary (no undo
toasts) follows from §8.1: this state machine has no reverse transitions, and offering an undo that
the server cannot honor would be a lie in the most safety-critical corner of the product.

**Why there is no dashboard.** Every requirement in §1 of the architecture draft is about *doing*
something — searching, scoping, approving. Metric cards would occupy the highest-value pixels with
read-only aggregates that the runbook reads from Pulse or the ribbon. Pulse is a canvas mode, not
the landing page, and the landing page is always the operator's own scope.

**What this option deliberately does not build.** Multi-scope comparison views; a per-message send
composer; chart galleries; theming controls beyond light/dark token swap; notification
center/notification toasts for background events; client-side queues for writes; an assistant page
distinct from the dock; mobile-native interactions beyond the responsive rules in the research
document.

**Contract gaps this option surfaces (needed by the UI, not present in §7.3).**
1. `POST /api/sends/[id]/submit` — `draft → pending_approval` (§8.1 names the transition; §7.3 lists
   only approve/reject/cancel).
2. `PATCH /api/sends/[id]` — editing a `draft`'s target/text before submit.
3. `POST /api/sends/[id]/approve` from `failed` with `errorClass: 'ambiguous'` — §8.1 says
   re-approval is the recovery path; the UI needs the endpoint to accept that source state and
   return the new `dispatch.attempts` in the response body.
4. A stream event for `aiCalls` completion (or a polling read of `GET /api/assistant/calls`) so the
   Ask panel can render `rejected[]` and `whitelistSnapshot` without a second manual refresh.

**Build order** (maps onto §16 phases without changing them): P0 = shell, spine, registry canvas,
ledger canvas, feedback kit; P1 = instances canvas, sync actions, whitelist editor; P2 = auth page
and session error states; P3 = Ask panel; P4 = Stage + Approve panels and transition guards;
P5 = Pulse; P7 = raw payload/view-once affordances and the media janitor view.

**Open questions for the architecture owner.**
1. Server components calling `src/server/*` accessors directly, or handler-only access (§1.2)? The
   component contract is unchanged either way; only the shell's data plumbing differs.
2. Should `dock` become history-worthy once the dock holds in-flight work (§4)? Today it is a
   `replaceState` value to avoid back-stack traps.
3. Should the ledger be virtualized behind a feature flag once message volume in the widest scope
   (no group filter, all groups of an instance) exceeds what a plain list can scroll?
4. Does the operator want a per-group `assigned` toggle in the ledger toolbar as well as the
   registry (it is a `PATCH /api/groups/[id]`, so either is possible)?

---

## Appendix A — Requirement traceability

| Requirement (from the brief) | How this option satisfies it | Where |
|---|---|---|
| Internal, single-owner dashboard (§2.1 assumption 1) | No roles, no invitations, no multi-tenant switching; one session, one scope cursor, one owner menu | §1.1, §5.3 (session error) |
| Instances | `view=instances` canvas: table + Sheet with pairing, `runtime.counters`, `runtime.groupSync`, re-pair banner | §1.4 `InstanceCanvas`, §5.3 |
| Group ID + name registry (R11) | `view=registry` table: copyable `<id>@g.us` + current name + provenance, plus the spine's per-instance list; never-blank fallback applied server-side | §1.4 `GroupRegistryTable`, §3 |
| Raw message search (R4) | `view=search` canvas over `GET /api/messages`, results as ledger rows that scope into the ledger; `raw.message` in a text-only disclosure | §1.4 `SearchCanvas`, `RawPayload` |
| AI query restricted by per-instance whitelist (R5) | Ask panel shows `whitelistCount` + `whitelistSnapshot`; disabled inline when `no_whitelist`; `rejected[]` rendered as a scope-refusal line; the UI never computes scope | §1.4 `AskPanel`, §2.4, §5.3 |
| Human-approved / scheduled sends (R7) | Write-only dock: Stage (draft) → Submit (`pending_approval`) → Approve (immediate or `scheduledFor > now + 30s`); the read surface has no send affordance; `ambiguous` gets dedicated copy | §0 thesis 2/4, §1.4 `StagePanel`/`ApprovePanel`/`SendCard`, §2.3 |
| Bot / group / token stats (R8) | `view=pulse` tables + sparkline rows and the 28px status ribbon; live counters and `$merge` rollups both shown with their timestamps | §1.4 `PulseCanvas`, `StatusRibbon` |
| Common Shadcn dashboard patterns | `Sidebar`-equivalent spine, `Resizable` split, `Command` palette, `Tabs` dock, `Table`/`DataTable` registry, `Sheet` for small screens, `AlertDialog` for destructive/sensitive confirmations, `Skeleton`, `Sonner` | §1.2, §1.4 |
| Fluent UI feel (without Fluent components) | Layered chrome, restrained elevation scale, 4px ramp, type ramp capped at `title3`, 100/150/200/250ms motion with Fluent curves, 2px focus indicator, calm task-first surfaces, no KPI-card dashboard | §0 thesis 5, §6 |
| Accessible skeleton loading | 150ms delay / 300ms minimum, geometry-matched rows, `aria-busy` per zone, `aria-hidden` primitives, one hidden status per zone, reduced-motion static blocks, no fake data | §5.1 |
| Toast feedback | Explicit allowed/forbidden trigger lists, levels, stacking, dedupe, ARIA politeness, inline mirroring of every error, no undo that the state machine cannot honor | §5.4 |
| Primary operator loop: inspect → ask → approve | One canvas + resident dock + one scope cursor; no navigation inside the loop; every step is in-place | §0, §1.1, §2.2 |
| Accessibility floor from `ui-research-fluent.md` | Landmarks, heading order, focus restoration, 24px targets, 320px reflow, 400% zoom, semantic color, live-region discipline | §5.7 |

