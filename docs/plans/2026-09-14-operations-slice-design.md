# Operations slice — design

Status: **agreed** (2026-09-14). Scope: make the worker's scheduled loops and the product's usage
counters visible in one console page, and start recording what the statistics requirement promises.

## Goal

An operator can see what the worker is doing on a timer, and what this organisation has used today,
without reading logs or the database. Today neither is possible: the loops are bare tickers with no
recorded state, and of the counters the architecture claims, only `statsDaily.counters.receipts` is
ever written.

## Decisions taken

1. **One `/operations` page with two sections.** Loops first (worker-owned), then today's usage
   (Mongo-owned). Each fails independently: a worker that is down says so while the usage section
   still renders.
2. **Instrumentation first, then the surface.** Every number the page shows has to be written before
   it can be displayed, so the slice starts in the worker and the reply path, and the page comes
   last.
3. **Depth: tokens plus the counters the doc promises.** `aiCalls` gets its first writer, and
   `instances.runtime.counters` / `statsDaily` gain the counters named in
   `docs/architecture-draft.md` §5.1 and §10 for the events the worker already knows. The nightly
   `$merge` reconciliation job is explicitly out.
4. **No "run now" controls.** The three loops have no individual trigger; the one manual trigger that
   exists (per-instance group sync) already lives on the instance workspace where its result has
   context. A control that cannot act would be dead UI (R-26).
5. **Absent usage is not zero.** AI SDK 7 types tokens as `number | undefined`, so a row stores
   `null` when the provider reported nothing and the page renders "not reported" rather than a zero
   that reads as "free".

## Surface

`/operations`, in the console shell, with nav gaining a third item and the same session guard.

**Loops** — one row per scheduled loop: name, interval, last run (UTC), outcome, runs since start.

| Loop | Knob | Default | Owner |
| --- | --- | --- | --- |
| `group-sync` | `GROUP_SYNC_INTERVAL` | 30m | scheduler |
| `media-janitor` | `MEDIA_JANITOR_INTERVAL` | 5m | media runner |
| `send-dispatch` | `DISPATCH_INTERVAL` | 5s | dispatcher |

Data: new `GET /scheduler` on the worker (bearer, like the rest of the control plane), proxied as
`GET /api/scheduler` with `no-store`, read through a server loader that returns a failure as a value
so the section can say why it is empty.

**Today's usage** — messages in, media stored, media unparsed, sends ok, sends failed, receipts, and
AI tokens in/out/total against `appSettings.ai.maxTokensPerDay`, per instance, for the current UTC
day. A day with nothing recorded names what would put something there instead of showing zeros as
though work had happened.

## Recording contract

**Worker: a scheduler registry.** `name`, `interval`, `lastRunAt`, `lastError`, `runs`, updated after
each pass through the loop body, not when the ticker fires. Each loop already has a ticker seam its
tests drive by hand (`scheduler_test.go`'s `manualTicker`, `dispatch.go`'s `newTicker`), so a pass
can be asserted without sleeping.

**Worker: counters.** `instances.runtime.counters` gets its first writer at the points the event is
already known — `messagesIn` on ingest accept, `mediaStored` / `mediaUnparsed` in the media pipeline,
`sendOk` / `sendFailed` at dispatch, `groups` after a sync — and `statsDaily` gains the matching
per-day/per-instance/per-group counters beside `counters.receipts`, with the same `$inc` shape so
"one row per day per group" stays the invariant.

**Web: `aiCalls`.** One row per model call in the reply path, on success and on failure:
organization, instance, group, kind, model, `inputTokens`, `outputTokens`, `totalTokens`, latency,
outcome, `createdAt`.

## Out of scope

The nightly `$merge` rollup, budget enforcement (nothing refuses a call today and this slice does not
start), group-level rollups beyond the day row, enrichment statistics for a pipeline that does not
exist, and the other console slices (groups workspace, sends approval, messages and media).

## Behaviour queue (TDD order)

Worker, in this order: the registry records a clean pass and a failed one; `GET /scheduler` lists the
loops with their intervals and refuses a bad token; the three loops report their passes; then one
counter at a time — `messagesIn`, `mediaStored` / `mediaUnparsed`, `sendOk` / `sendFailed`, `groups`,
and the matching `statsDaily` counters.

Web: an `aiCalls` row is written on a successful reply, on a failed one, and with nulls when the
provider reports no usage; then the read models (`loadScheduler`, `loadUsage`), then the page's two
sections with their empty and failure states.

## Verification

Go tests drive the loops through their own ticker seams, so no test sleeps. The page is verified by
clicking through the running console with the worker up and with it down, and the counters are
checked by reading the documents the writes produced rather than trusting the screen.
