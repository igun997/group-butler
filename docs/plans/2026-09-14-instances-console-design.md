# Instances console — design

Status: **agreed** (brainstorm, 2026-09-14). Scope: the first slice that wires the owner console to
the real API, end to end.

## Goal

An operator can link a WhatsApp account, pair it, inspect it, change the assistant's scope, force a
group sync, and remove it, entirely from the console. Today the console can only *display* rows it
has no way to create.

## Decisions taken in the brainstorm

1. **A bookmarkable workspace.** `/instances/[id]` is the surface, not an expanded row on the list.
   This follows the earlier scope-spine decision record (bookmarkable instance and group
   workspaces).
2. **Writes through the existing route handlers; reads through the same server modules.** The 26
   handlers are the documented contract, they already enforce the tenant guard and write the audit
   row, and they are covered by tests. Server actions were rejected: a second write path beside them
   is a way for the two to disagree. No new dependency.
3. **The pairing screen polls `GET /api/instances/:id` every 2s** while the instance is pairing, and
   stops on `connected`, on `logged_out`, on unmount, or on an explicit "Stop checking". The change
   stream is not extended for this: it does not watch `pairingSessions`, and the QR lives in the
   worker snapshot, not in Mongo.
4. **The scope editor is a picker over the instance's known groups.** One `PATCH` carries the full
   list. The route's `unknown_groups` (400) stays as the guard but becomes unreachable by
   construction, and the operator never types a JID.
5. **Removal is a two-step inline confirm**, not a modal: the second step names what it does
   (device deleted on the worker, stored history kept).
6. **No optimistic UI.** The worker owns the pairing lifecycle, so the console shows what the worker
   reports and never a state it invented.
7. **No invented countdown.** The snapshot carries no QR expiry, so the panel says the code rotates
   and follows it, instead of asserting a timer.

## Surface

Reads go through the modules the routes themselves use, so a page cannot drift from the API:
`server/repos/instances.ts`, `server/worker/client.ts`, `server/health.ts`.

| Action | Handler | Failure codes the UI branches on |
|---|---|---|
| Link an account | `POST /api/instances` | `invalid_request`, `label_conflict`, `worker_unreachable` |
| Request a phone code | `POST /api/instances/:id/pairing-code` | `invalid_state`, `instance_offline`, `worker_unreachable` |
| Replace the scope | `PATCH /api/instances/:id` | `invalid_request` (+ `groupJids`), `not_found`, `store_error` |
| Force a group sync | `POST /api/instances/:id/groups/sync` | `group_sync_failed`, `instance_offline`, `worker_unreachable` |
| Remove the instance | `DELETE /api/instances/:id` | `instance_cleanup_failed`, `not_found` |

Screens: `/instances` (list, gains "Link an account" and workspace links), `/instances/new` (create
form), `/instances/[id]` (the workspace).

## Behaviour queue (TDD order)

1. `/instances/new` renders the form: label, mode control, and a phone field only in code mode.
2. `pairingStage(snapshot)` maps every worker status to what the panel shows — `pairing` + QR →
   image, `pairing` + code → code, `connected` → identity and stop, `logged_out` / `error` → the
   reason and stop, `disconnected` → offer a code or a retry.
3. `/instances/[id]` renders the QR when the snapshot carries one, the code when it carries that,
   and the identity facts when connected.
4. The scope editor lists exactly the instance's known groups with the whitelisted ones checked, and
   "Save scope" is disabled until the selection changes.
5. An unknown or foreign instance renders the console's own not-found page **inside the shell**, with a
   way back to the list, and never a shell with empty fields. Measured, not assumed: the status line
   stays `200`, in `next dev` and in a production build, because Next has already streamed the shell
   by the time the page resolves; the body is the not-found page. A true 404 would need the
   ownership check in middleware, which means a Mongo read on every request for a status code, so
   the in-shell page is the trade taken.
6. `/instances` links each row into its workspace and keeps the honest empty state.
7. The create form's failures map to the field or the page: `label_conflict` on the label,
   `invalid_request` on the field it names, `worker_unreachable` as a page notice with a retry.
8. Removal needs the second step, and a failed cleanup keeps the operator on the page with the
   reason.

## Failure handling

Every message comes from the route's `{ error, code }`; branching is on `code`, never on message
text, and the route's phrase is the operator-facing fallback. A worker that is down never blanks a
page: the stored row still renders, with the stale-status notice it already has.

## Out of scope for this slice

Group assignment and the group workspace, sends approval, messages and media, extending the change
stream, and any multi-user or per-tenant UI.

## Test approach

Page tests render the server component tree to a string under the existing `node` environment (the
pattern `apps/web/vitest.config.ts` already documents), so a screen's states are asserted without a
DOM. Pairing and failure mapping are pure functions with their own unit tests. Client interactions
(submit, save, poll, confirm, remove) are verified by clicking through the running console, since
this repo has no jsdom or testing-library dependency and adding one is not part of this slice.

## What the verification covered

Against a running instance of this build (`next dev` and a production `next start`), with the worker
**down** at the time:

| Checked | Result |
| --- | --- |
| The list's link action and row links | "Link an account" present; rows link to `/instances/<id>` |
| Form refusal mapping | `worker_unreachable` produced the form notice and the retry hint, no field error |
| Workspace with the worker down | stored label, status badge, group counts, scope picker and both actions render; the pairing panel says it cannot be read |
| Scope round trip | toggle on → "1 of 1 groups", Save enabled; save → refresh → Save disabled; toggled back and saved again to restore |
| The write itself | `instances.config.groupJidWhitelist` back to `[]`, the group's mirror flag `false`, two `instance.whitelist.updated` audit rows with before/after |
| Manual sync, worker down | the route's phrase ("the WhatsApp service did not answer") as a notice |
| Removal, both steps | step two names what is unlinked and what is kept; Cancel returns to step one with the instance untouched |
| Unknown instance | the in-shell not-found page with a way back |

**Not yet observed, because the worker is down**: create → the workspace redirect, a live QR or phone
code in the panel, the pairing-code request, and a successful removal. The code paths exist and the
route tests cover the handlers; the console's rendering of the payload is covered by the panel's
tests. Run those four clicks once `apps/worker` is up.
