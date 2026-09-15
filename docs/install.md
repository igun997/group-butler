# Installing Group Butler

Two host processes and one database. The BFF is the Next.js app (the console and the
API); the worker holds the WhatsApp sessions and does the scheduled work. MongoDB is
the only stateful service, and media lives in a real Cloudflare R2 bucket — every
environment uses the real service, so a credential problem shows up on the first
upload rather than at deploy time.

- Design and contracts: [`architecture-draft.md`](./architecture-draft.md)
- Product scope and the agent design: [`plans/`](./plans/)

---

## 1. What you need

| | Why |
| --- | --- |
| **Bun** ≥ 1.3 | installs and runs the BFF, the scripts, and every test |
| **Go** ≥ 1.24 | builds the worker |
| **Docker** with the `compose` v2 plugin | runs the local MongoDB replica set. The apps always run on the host |
| A **Cloudflare R2** bucket + scoped token | attachments; the endpoint is derived from the account id, and there is no emulator |
| A **WhatsApp** account for the bot | paired by QR or phone code from the console |
| An **OpenAI-compatible model endpoint** | the reply agent; `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` |

## 2. Configure

```bash
git clone <your-remote> group-butler && cd group-butler
cp .env.example .env
bun install
```

Then fill `.env`. The file is **sourced by the shell** (`set -a`), so a value
containing `$` must be single-quoted — this matters for the password hash below.

The four that have to be right before anything will start:

| Key | Notes |
| --- | --- |
| `MONGODB_URI` | local default is the compose replica set: `mongodb://127.0.0.1:27017/group_butler?replicaSet=rs0` |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Cloudflare dashboard → R2. `bun run dev:check` refuses placeholders and probes the bucket |
| `OWNER_EMAIL` + `OWNER_PASSWORD_HASH` | the one console account. Generate the hash with `bun run auth:hash '<password>'` and paste it **single-quoted**: `OWNER_PASSWORD_HASH='scrypt$16384$8$1$…'` |
| `AUTH_SECRET` | ≥ 32 characters; it signs the session cookie. Rotating it signs everyone out |

`AI_*` and `WORKER_SECRET` are generated or filled in the same file; every key the code
reads is listed in `packages/shared/src/env-contract.ts`, and a test fails if one of them
is missing from `.env.example`.

Optional:

- `DISPLAY_TIMEZONE` — the clock times are written in for you (default `Asia/Jakarta`).
  Stored times stay UTC; this is what a recap or a history line is rendered in.
- `DEFAULT_COUNTRY_CODE` — how a phone number typed in national form is expanded (default `62`).

## 3. Run it

### Development

```bash
bun run dev:check     # validate env + R2 + Mongo, start nothing
bun run dev:local     # infra up, then the BFF (next dev) and the worker (go run)
```

`Ctrl-C` stops both children and leaves MongoDB running (`bun run dev:down` stops it).
Logs are prefixed `[web]`, `[worker]`, `[dev]`.

### A production build, on this host

```bash
bun run prod:check    # validate env + R2 + Mongo, build nothing
bun run prod          # build what is missing, then run
bun run prod --force  # rebuild both artifacts first
```

The BFF is the standalone server the image runs (`node apps/web/server.js` — this app is
built with `output: "standalone"`), the worker is the compiled binary, and both are kept
between runs: a restart over an unchanged tree takes about a second. `--force` is for
after a code change, because neither tool can tell this tree from the one it built last.
Two production-only requirements are checked before anything starts: an empty
`OWNER_PASSWORD_HASH` (a production build refuses the development plaintext password) and
an `AUTH_SECRET` shorter than 32 characters.

### The published images (Docker)

`deploy.yml` publishes `ghcr.io/<owner>/<repo>/web` and `.../worker` on every push to
`master` and on `v*` tags. To run them:

```bash
cp apps/web/.env.production.example   infra/prod/.env.web      # fill every blank
cp apps/worker/.env.production.example infra/prod/.env.worker  # fill every blank
BUTLER_GHCR_OWNER=<owner> docker compose -f infra/prod/docker-compose.ghcr.yml up -d
```

`infra/prod/docker-compose.ghcr.yml` is pull-only: it builds nothing and starts no
database (the worker reaches yours through `MONGODB_URI`). It publishes only the web
port; the worker's control plane is reachable on the compose network as
`http://worker:4000`, which the file sets for you — inside a container `127.0.0.1` is
that container, so a loopback `WORKER_URL` makes every BFF call to the worker fail while
both containers look healthy. Pin a release with `BUTLER_TAG=v1.2.3` rather than floating
on `latest`.

## 4. Pair the WhatsApp account

1. Open the console at `http://localhost:3000` and sign in with the owner email and
   password.
2. **Instances → New**, choose QR or phone code, and scan/enter it from the phone that
   will be the bot.
3. Open the instance and **assign** the groups it should watch. Only assigned **and**
   whitelisted groups are ever read, stored, or answered in — and the worker stores
   messages only for those, plus the owner's own direct messages.

The worker's session lives in its `whatsmeow` store (`apps/worker/.localdata` by default,
or `WHATSMEOW_DB_URI`). Losing it means pairing again; in Docker it is the `butler-wa`
named volume for that reason.

## 5. Checks

```bash
bun run lint                                  # packages/shared + apps/web
bun run check                                 # tsc
bun test scripts/dev.test.ts scripts/prod.test.ts
bun run --cwd packages/shared test
bun run --cwd apps/web test                   # integration suites; needs no database of its own
bun run test:worker                           # cd apps/worker && go test ./... -short
```

`.github/workflows/ci.yml` runs those on every push to `master` and every pull request;
`deploy.yml` publishes the images. The app suites start their own
`mongodb-memory-server` replica set, so nothing needs to be running first.

## 6. When something is wrong

| Symptom | Cause |
| --- | --- |
| `[dev] missing …/env` | `cp .env.example .env` |
| `media storage requires Cloudflare R2` | one of the four `R2_*` keys is empty or still `REPLACE_WITH_*` |
| `could not read …/.env` | a value with a `$` is unquoted — the password hash needs single quotes |
| `OWNER_PASSWORD_HASH is empty` | `bun run prod` refuses the development plaintext password; run `bun run auth:hash` |
| `/api/health` reports `worker: unreachable` | the worker is not running, or `WORKER_URL` points at loopback from inside a container |
| `EADDRINUSE` on 3000 or 4000 | the development stack is still up; stop it before `bun run prod` |
| The console says a model call failed | `AI_*` is wrong, or the endpoint answered with an error envelope — the reply is retried once and then recorded as a provider fault |
