# Group Butler

A WhatsApp group assistant for one operator: it watches the groups you assign, remembers
what was said, and answers you — in a group or in your own chat — through an agent that
can read a group's history, search it, read an attachment, and send or schedule a message.

Two host processes and one database: a Next.js BFF (the console and the API) and a Go
worker (the WhatsApp sessions and the scheduled work). Media lives in a real Cloudflare R2
bucket; MongoDB holds everything else.

## Start here

- **Install and run it** — [`docs/install.md`](docs/install.md)
- **How it is put together** — [`docs/architecture-draft.md`](docs/architecture-draft.md)
- **What it is meant to do, and why** — [`docs/plans/`](docs/plans/)

```bash
cp .env.example .env      # fill it in — the guide names the four that matter
bun install
bun run dev:check         # validate env, R2 and MongoDB
bun run dev:local         # infra up, then the BFF and the worker
```

For a production build on the same host — the built BFF and the compiled worker, reusing
whatever is already built — `bun run prod`. For the published images,
`infra/prod/docker-compose.ghcr.yml`.

## What it does today

| | |
| --- | --- |
| Watches | only the groups you assign **and** whitelist, plus your own direct messages |
| Remembers | messages, then summarised batches and facts, scoped to one group and one tenant |
| Answers | owner mentions in a group, and anything you ask in your own chat |
| Reads | a group's details and members, its recent messages, a text search over them, and a stored attachment |
| Sends | a message into a monitored group, now or scheduled — the message you asked for |
| Proposes | everything it may not do alone: a group's photo, its membership, leaving, revoking a message. Those wait for your approval, by short id |
| Cancels | a queued message, before it goes out |

## Checks

```bash
bun run lint && bun run check     # eslint + tsc
bun run test                      # scripts, shared package, app
bun run test:worker               # go test ./... -short
```

CI runs the same on every push to `master` and every pull request
(`.github/workflows/ci.yml`); `deploy.yml` publishes the two images to GHCR.
