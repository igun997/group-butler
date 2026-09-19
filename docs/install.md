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
| **MongoDB, as a replica set** | every multi-document write is a transaction and the live dashboard uses change streams. A standalone `mongod` refuses **both** — the app then answers 502 on any save and 503 on the stream, which looks like a broken build rather than a database without a replica set. A single node is enough |
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
| `MONGODB_URI` | local default is the compose replica set: `mongodb://127.0.0.1:27017/group_butler?replicaSet=rs0`. The `replicaSet=` parameter is not optional: without it the driver may connect to a member it was not told about, and the database must *be* a replica set anyway |
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
# The packages are private, because the repository is: every pull needs a
# credential. `gh auth token` is the quickest on a machine that has the gh CLI
# logged in, but it is a session token that rotates — for a server or CI, use a
# classic PAT with `read:packages` instead.
gh auth token | docker login ghcr.io -u <owner> --password-stdin

cp apps/web/.env.production.example   infra/prod/.env.web      # fill every blank
cp apps/worker/.env.production.example infra/prod/.env.worker  # fill every blank
BUTLER_GHCR_OWNER=<owner> docker compose -f infra/prod/docker-compose.ghcr.yml up -d
```

A pull that answers **`unauthorized`** is a missing credential, not a missing
image: a private package answers that way for every tag, including tags that do
not exist. `docker login` writes to the invoking user's `~/.docker/config.json`,
so `sudo docker pull` uses root's and does not see yours — and a tool that sets
`DOCKER_CONFIG` has a client of its own.

**`PORT` is per service, and the two images read the same name**: the BFF serves on
`3000` and the worker's control plane listens on `4000`. A platform that injects one
value into both — or a web service given the worker's environment — puts the BFF on the
worker's port, where the proxy does not look for it. Set `PORT=3000` for web and
`PORT=4000` for worker, and point the worker's `WORKER_URL` at it
(`http://worker:4000` on a compose network).

`infra/prod/docker-compose.ghcr.yml` is pull-only: it builds nothing and starts no
database (the worker reaches yours through `MONGODB_URI`). It publishes only the web
port; the worker's control plane is reachable on the compose network as
`http://worker:4000`, which the file sets for you — inside a container `127.0.0.1` is
that container, so a loopback `WORKER_URL` makes every BFF call to the worker fail while
both containers look healthy. Pin a release with `BUTLER_TAG=v1.2.3` rather than floating
on `latest`.

### If your MongoDB is a standalone

A standalone `mongod` cannot be made to serve transactions by configuration alone —
the server itself has to be started as a replica set, which for one node is:

```bash
# the server needs `--replSet` before it will accept rs.initiate()
mongod --replSet rs0 --bind_ip_all --dbpath /data/db
# once, on the same server, and idempotent enough to re-run and read the message
mongosh --eval 'try { rs.status().ok } catch { rs.initiate({_id: "rs0", members: [{_id: 0, host: "<host>:27017"}]}) }'
```

Existing data is kept: initiating a replica set over a data directory that was a
standalone is supported. Two details decide whether it works from a container:

- the **member host** the set advertises must be an address the clients can resolve.
  A client on the same network uses the service name (`mongo:27017`); host processes
  use `127.0.0.1:27017`. `infra/dev/docker-compose.yml` runs a host-process stack and
  initiates with `127.0.0.1`; `infra/prod/docker-compose.ghcr.yml` plus a container
  database wants the service name.
- `MONGODB_URI` then carries the set's name: `mongodb://mongo:27017/group_butler?replicaSet=rs0`.

A managed MongoDB (Atlas, most PaaS add-ons) is already a replica set; check with
`db.hello().setName` — `null` means standalone.

## 4. Pair the WhatsApp account

1. Open the console at `http://localhost:3000` and sign in with the owner email and
   password.
2. **Instances → New**, choose QR or phone code, and scan/enter it from the phone that
   will be the bot.
3. Open the instance and **assign** the groups it should watch. Only assigned **and**
   whitelisted groups are ever read, stored, or answered in — and the worker stores
   messages only for those, plus the owner's own direct messages.

The linked device belongs to Hermes, not to this worker: the session keys live in the
Hermes container's data volume. The Go worker holds no WhatsApp session at all — losing
anything of the worker's loses no pairing.

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
| **502** `store_error` on saving a scope, a group's settings, an approval, or a send | the write is transactional and the database refused it. Check `db.hello().setName`: `null` means a standalone, which cannot serve transactions — the server log now says so, with the fix |
| A container shows **`unhealthy`**, or never appears when using the compose file | the image's healthcheck is `GET /api/health`, and that route is a dependency check: it answers 503 while MongoDB or the worker is unreachable, so the container reports unhealthy rather than failing. The compose file's `depends_on: service_healthy` then starts nothing. Read why with `docker inspect --format '{{json .State.Health.Log}}' <container>` |
| `EADDRINUSE` on 3000 or 4000 | the development stack is still up; stop it before `bun run prod` |
| `unauthorized` pulling `ghcr.io/…` | the client has no GHCR credential: log in as the user that runs docker (`sudo` uses root's config), or pull a tag that exists — a private package says `unauthorized` either way |
| The console says a model call failed | `AI_*` is wrong, or the endpoint answered with an error envelope — the reply is retried once and then recorded as a provider fault |
