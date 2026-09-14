# Owner Mention Replies Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Automatically answer an explicit WhatsApp mention from the configured dashboard owner in an assigned and whitelisted group, using only retained context from that group.

**Architecture:** The Go worker parses and persists only assigned-group messages, then emits an idempotent private callback for an eligible owner mention. The Next BFF verifies the callback with a distinct secret, validates current group scope, retrieves only same-group content, generates one response through the configured AI SDK provider, and creates a tagged auto-approved send. The existing dispatcher remains the only WhatsApp transport.

**Tech Stack:** Go, whatsmeow, MongoDB, Next.js 15, Vercel AI SDK, Zod, Vitest, Go testing.

---

### Task 1: Add configuration and domain contracts

**Files:**
- Modify: `apps/worker/config.go`
- Modify: `apps/worker/config_test.go`
- Modify: `packages/shared/src/env-contract.ts`
- Modify: `apps/web/package.json`
- Test: `apps/worker/config_test.go`

**Step 1: Write failing configuration tests**

Add tests that reject missing or invalid `OWNER_WHATSAPP_JID` and `WORKER_CALLBACK_SECRET` when owner-mention replies are enabled, and normalize the owner JID once at startup.

**Step 2: Run the focused Go test**

Run: `go test ./... -run 'TestLoadConfig.*Reply' -count=1`

Expected: FAIL because reply configuration does not exist.

**Step 3: Add the minimal typed configuration**

Add explicit reply-enable, owner-JID, callback URL/secret, AI provider, model, retrieval limit, and cooldown settings. Use a distinct callback secret, never `WORKER_SECRET`.

**Step 4: Run the focused Go test**

Run: `go test ./... -run 'TestLoadConfig.*Reply' -count=1`

Expected: PASS.

### Task 2: Gate ingestion and create durable reply jobs

**Files:**
- Modify: `apps/worker/handler.go`
- Modify: `apps/worker/manager.go`
- Modify: `apps/worker/groupstore.go`
- Modify: `apps/worker/ingest.go`
- Modify: `apps/worker/message.go`
- Test: `apps/worker/handler_test.go`
- Test: `apps/worker/ingest_test.go`

**Step 1: Write failing worker behavior tests**

Prove direct and unassigned-group messages are not persisted; assigned messages are persisted; only a non-bot message from the configured owner with a structured mention of the instance bot JID/LID produces one durable job.

**Step 2: Run focused worker tests**

Run: `go test ./... -run 'Test.*(Assigned|Mention|Reply).*' -count=1`

Expected: FAIL because the assignment gate and reply job do not exist.

**Step 3: Implement the minimum worker path**

Perform group config lookup away from WhatsApp callback I/O, persist allowed messages, and upsert a reply job keyed by organization, instance, and inbound WhatsApp message ID. Do not create jobs from historical events, bot-originated events, direct chats, unassigned groups, non-owner senders, or non-mentions.

**Step 4: Run focused worker tests**

Run: `go test ./... -run 'Test.*(Assigned|Mention|Reply).*' -count=1`

Expected: PASS.

### Task 3: Deliver owner mention jobs privately and idempotently

**Files:**
- Create: `apps/worker/reply_delivery.go`
- Test: `apps/worker/reply_delivery_test.go`
- Modify: `apps/worker/main.go`

**Step 1: Write failing delivery tests**

Prove callback requests include the separate bearer secret and stable job identifier, retry bounded transient failures, and mark a delivered job without blocking WhatsApp event handling.

**Step 2: Run the focused worker test**

Run: `go test ./... -run 'TestReplyDelivery' -count=1`

Expected: FAIL because delivery does not exist.

**Step 3: Implement delivery**

Run a bounded worker-owned delivery loop over reply jobs. Send a minimal event envelope to the BFF, do not send message text in the callback, and retain durable retry state.

**Step 4: Run the focused worker test**

Run: `go test ./... -run 'TestReplyDelivery' -count=1`

Expected: PASS.

### Task 4: Build the BFF callback, same-group retrieval, and AI response

**Files:**
- Create: `apps/web/src/app/api/internal/reply-jobs/route.ts`
- Create: `apps/web/src/server/ai/provider.ts`
- Create: `apps/web/src/server/ai/group-reply.ts`
- Create: `apps/web/src/server/repos/reply-jobs.ts`
- Modify: `apps/web/src/server/repos/messages.ts`
- Modify: `apps/web/src/server/collections.ts`
- Modify: `apps/web/src/server/bootstrap.ts`
- Test: `apps/web/src/app/api/internal/reply-jobs/route.test.ts`
- Test: `apps/web/src/server/ai/group-reply.test.ts`

**Step 1: Install only the `ai` package and inspect its bundled documentation**

Run: `bun add ai`

Then inspect `apps/web/node_modules/ai/docs` for the current server generation API.

**Step 2: Write failing BFF tests**

Prove the callback refuses a missing/invalid secret, rejects an unassigned or unwhitelisted group, fetches only same-organization, same-instance, same-group context, and creates one auto-approved send for an idempotent job.

**Step 3: Run focused BFF tests**

Run: `bun run test src/app/api/internal/reply-jobs/route.test.ts src/server/ai/group-reply.test.ts`

Expected: FAIL because the route and group-reply service do not exist.

**Step 4: Implement the minimum BFF path**

Use the current AI SDK server API with an explicit OpenAI-compatible provider configuration. Bind every retrieval query to the invoking organization, instance, and group. Persist a reply-job audit record and create an `approved` send tagged with the inbound message/job identity.

**Step 5: Run focused BFF tests**

Run: `bun run test src/app/api/internal/reply-jobs/route.test.ts src/server/ai/group-reply.test.ts`

Expected: PASS.

### Task 5: Preserve manual send semantics and document the public contract

**Files:**
- Modify: `apps/web/src/server/repos/sends.ts`
- Modify: `apps/web/src/app/api/sends/route.ts`
- Modify: `docs/api-contract.md`
- Test: `apps/web/src/app/api/sends/route.test.ts`

**Step 1: Write failing tests**

Prove dashboard-created sends remain `pending_approval` and only owner-mention jobs can create tagged automatic `approved` sends.

**Step 2: Run the focused test**

Run: `bun run test src/app/api/sends/route.test.ts`

Expected: FAIL because automatic job provenance is not modeled.

**Step 3: Implement minimal provenance fields and update docs**

Add immutable automatic-send provenance and a unique index/transaction condition that prevents multiple sends for one reply job. Document the behavior and operational environment variables.

**Step 4: Run the focused test**

Run: `bun run test src/app/api/sends/route.test.ts`

Expected: PASS.

### Task 6: Run integration verification

**Files:**
- Test: affected Go and TypeScript suites

**Step 1: Run affected suites**

Run: `go test ./... -count=1` from `apps/worker` and `bun run test` from `apps/web`.

Expected: all tests pass.

**Step 2: Run static and production checks**

Run: `go vet ./...`, `bun run check`, and `bun run build`.

Expected: all commands exit zero.

**Step 3: Smoke test the callback path**

Start the BFF and worker test dependencies, submit a signed eligible event, then verify exactly one approved automatic send exists and a duplicate callback does not create another.

**Step 4: Commit**

```bash
git add apps/worker apps/web packages/shared docs
git commit -m "feat: reply to owner mentions in groups"
```
