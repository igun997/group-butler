# Fluent-informed UI research for Group Butler

Scope: an internal Next.js dashboard using Shadcn and Tailwind. This is a design recommendation only. It does not require installing Fluent UI or copying Fluent visuals.

## Design stance

Adapt Fluent as a behavior and information-design reference:

- **Clear hierarchy:** use semantic headings, concise labels, restrained dividers, and predictable regions. Fluent recommends logical structure and heading order so people can scan and navigate efficiently.
- **Calm, task-first surfaces:** put the active operational decision ahead of summaries. Avoid the generic sidebar plus metric cards plus chart plus table dashboard. There are no invented counts, rates, activity items, or customer data in this proposal.
- **Inclusive control:** preserve focus through updates and temporary UI. Fluent's accessibility guidance calls for logical focus movement, reflow down to a 320px breakpoint, and no loss of information at 400% zoom.
- **Semantic color:** use existing Shadcn theme tokens for meaning and contrast, not Fluent color tokens or a Microsoft-like visual treatment. Status has a text label in addition to color.

## One radically minimal option: the operations triage desk

**Desktop scene:** an operator monitors active WhatsApp work in a calm, dense workspace on a laptop or shared office display. The page has one quiet application header and exactly **three primary modules**. There are no KPI cards, chart area, activity feed, or dashboard gallery.

### 1. Work queue

A narrow, persistent list of conversations requiring attention. Each row has the conversation/group label, the latest message excerpt when available, a text status, and an accessible unread indicator. The selected row is visibly distinct from keyboard focus.

- Primary job: choose the next conversation, not inspect aggregate performance.
- Live behavior: retain list order and focus. If a new message changes priority, announce it through a non-disruptive status region and offer an explicit “Show new items” control rather than moving the active row under the operator.
- Components: `Input` or `Command` for search, `Tabs` or `ToggleGroup` for a small filter set, `ScrollArea`, `Button`, `Badge`, `Avatar` with fallback, and `Skeleton` for row geometry.
- States: first-use empty state with the one available setup action; filtered-empty state with “Clear filters”; error state with an inline `Alert` and retry; loading state that keeps the list's row shape rather than replacing the whole page.

### 2. Conversation workspace

The center, widest module is the current group or direct conversation. It holds the thread, quoted context, attachments, message delivery state, and a composer. This is the only place that offers send/reply actions.

- Prefer a single semantic message feed (`ol` or log-like region) with grouped timestamps over each message inside a floating card. Preserve reading position when older content loads.
- Composer states must be explicit: idle, sending, send failed with a retry action, and unavailable because the session is disconnected. Do not use a toast as the only evidence that a message failed.
- Components: `ScrollArea`, `Separator`, `Textarea`, `Button`, `DropdownMenu` for secondary message actions, `Tooltip` for icon-only controls, `Alert` for durable failures, `AlertDialog` only for destructive actions, and `Skeleton` for messages while the selected thread loads.
- Live behavior: if the user is at the newest message, append without stealing focus. If not, preserve scroll position and expose a “New messages” button. Announce new content only when it is relevant to the focused conversation, and do not announce message bodies twice.

### 3. Group and session control

A compact right-side inspector for the selected conversation's group and linked WhatsApp session. It is an operational context panel, not a settings area: group name and canonical ID, connection state, membership/mention policy where available, and scoped actions such as refresh, rename, or reconnect.

- Collapse it into a `Sheet` on smaller screens. Keep group-management actions scoped to the selected group and confirm destructive or permission-sensitive actions inline before the action, not via an opaque global modal.
- Components: semantic definition list for immutable facts, `Badge` for connection state, `Button`, `DropdownMenu`, `Collapsible` for secondary details, `Field`, `Input`, and `AlertDialog` for a destructive disconnect. Use `Dialog` only when a form cannot fit inline or in the sheet.
- States: no selected group means the inspector names the prerequisite, no linked session presents a connection action, fetch failure is an inline retryable error, and pending rename/reconnect disables only the affected action with a visible `Spinner`.

### Layout and responsive rule

Desktop uses a three-column CSS grid only for the three modules. The header contains product identity, global search/command access, and the user menu, but is not a dashboard module. At tablet widths, collapse group/session control into a sheet. At phone widths, show one module at a time with a persistent way to return to the queue; opening a conversation or inspector must keep back navigation and the browser history useful. Do not horizontally scroll the thread, queue, or composer.

## Component and state recommendations

| Need | Shadcn-compatible recommendation | Required behavior |
| --- | --- | --- |
| Shell and small-screen context | `Sidebar` on desktop, `Sheet` on mobile | Landmarks: `header`, queue `nav`, conversation `main`, inspector `aside`. Use one page `h1`; module headings follow logically. |
| Conversation and group selection | Semantic list rows plus `Button`; `Tabs` only when views are preloaded | Do not create a fake data grid. Arrow-key patterns belong only to a real composite widget. |
| Message compose and group rename | `Field`, `Textarea` or `Input`, `Button`, `Spinner` | Associate label, description, error, and disabled rationale. Keep an error in the module until resolved. |
| Connection or delivery status | `Badge` plus visible text | Never rely on a green/red dot alone. Expose the current state programmatically. |
| Destructive work | `AlertDialog` | Include the target and consequence. Return focus to the invoking control or a logical successor after completion. |
| Secondary actions | `DropdownMenu` and `Tooltip` | Every icon-only trigger has an accessible name. Preserve a direct keyboard path to common actions. |
| Search and fast navigation | `Command` in a `Dialog`, optional documented shortcut | Do not override browser or assistive-technology shortcuts. Make the shortcut discoverable near the trigger. |

### Loading and skeletons

Use Shadcn `Skeleton` only for the shape of content that is actually expected: queue rows, message lines, or inspector fields. The official Skeleton documentation defines it as a placeholder while content loads and includes list, card, text, and form patterns.

- Mark the affected module `aria-busy="true"` while its data is loading, with concise visually hidden loading text such as “Loading conversations”. Do not make each skeleton item a live-region announcement.
- Keep loaded controls out of the DOM until their data and permissions are known. Skeletons must not look clickable or include fake names, message text, timestamps, avatars, or counts.
- Respect `prefers-reduced-motion`; a static placeholder is valid. Do not use a full-page shimmer that hides usable queue or composer content.
- Distinguish initial loading, background refresh, and pagination. Initial loading can skeleton the local module; background refresh should retain content and show a small non-blocking status; loading older messages belongs at the history boundary.

### Toast and persistent feedback

Use Shadcn's current toast primitive or Sonner only for short, non-critical confirmation such as an action accepted for processing, a copied identifier, or an undoable change. Shadcn documents success, info, warning, error, loading, actions, and promise-driven state updates.

- Pair asynchronous operations with one updating notification, not a separate loading and success toast. Include an action only when it is safe and genuinely available.
- Never place a message-send, rename, reconnect, permission, or connection failure solely in a disappearing toast. Keep it inline in the relevant module with a retry or recovery action.
- Keep toast focus non-interruptive. W3C's alert pattern notes that alerts are normally announced without moving keyboard focus and warns against automatically disappearing important messages. Use an `AlertDialog` only when work must be interrupted to prevent a destructive or irreversible outcome.

### Empty, error, and live states

Each module needs distinct states, not a generic “No data” panel:

| Module | Empty | Loading | Error | Live update |
| --- | --- | --- | --- | --- |
| Queue | Explain that no conversations match the current scope, with one relevant next action if available. | Row-geometry skeleton. | Inline alert plus retry, keep prior rows if they exist. | Non-disruptive count-free update control; do not reorder focused item. |
| Conversation | Explain that a conversation must be selected. | Message-shape skeleton. | Retain known messages and show failure at the fetch boundary. | Append only when user is at the newest point; otherwise offer a jump control. |
| Group/session control | Explain that a group or linked session must be selected. | Field-shape skeleton. | Inline retry beside the failed data/action. | Update state label in place; do not move focus. |

## Keyboard and mobile requirements

- All controls are keyboard operable. Follow normal DOM order: header, queue, conversation, inspector. Use `Tab` and `Shift+Tab` between modules; reserve arrows for real `Tabs`, menu, listbox, or other composite patterns.
- Preserve an obvious focus indicator, distinguish selection from focus, and restore focus after closing a dialog/sheet or after removing a selected thread. W3C recommends predictable focus movement and warns against losing focus after a temporary UI closes or an item is removed.
- Let `Escape` close temporary UI, return focus to the trigger, and do not set initial focus on page load unless the screen has one universally immediate task.
- Meet WCAG 2.2 target-size minimum of 24 by 24 CSS pixels. For frequent mobile actions such as back, send, attachment, and inspector open, use a more comfortable touch target where space permits. Keep adjacent icon controls sufficiently separated.
- At 320px and 400% zoom, reflow rather than clip. The composer stays reachable above the virtual keyboard, long group names wrap or truncate with a full accessible label, and the message feed never creates horizontal scrolling.
- Live updates must not steal focus, auto-open a panel, or scroll a reader away from an in-progress reply. Announce only the minimum useful change via a stable status region.

## Sources

- [Fluent 2 Accessibility](https://fluent2.microsoft.design/accessibility): logical hierarchy, visible focus, semantic structure, contrast, 320px reflow, and 400% zoom guidance.
- [Fluent 2 Design System](https://fluent2.microsoft.design/): source for the design-system adaptation, not a dependency recommendation.
- [shadcn/ui Skeleton](https://ui.shadcn.com/docs/components/skeleton): placeholder purpose and component patterns.
- [shadcn/ui Toast](https://ui.shadcn.com/docs/components/toast): toast types, actions, and promise-state updates.
- [W3C ARIA Alert Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/alert/): non-focus-stealing alerts and the warning against disappearing important messages.
- [W3C Keyboard Interface Practice](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/): predictable focus, tab order, composite-widget navigation, and focus restoration.
- [WCAG 2.2 Target Size Minimum](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html): 24 by 24 CSS pixel minimum target guidance.
