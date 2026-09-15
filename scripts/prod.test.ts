import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * What the production launcher does that the development one does not: it builds
 * before it starts, it runs the compiled worker rather than `go run`, it refuses a
 * deployment whose console could not be logged into, and it starts nothing at all
 * when a build fails.
 *
 * The harness is the shape `scripts/dev.test.ts` uses — a fixture repository with
 * stubbed commands on PATH, so the assertions are about what the launcher actually
 * invoked and which processes it actually left running. Supervision itself is
 * shared with development and tested there.
 *
 * Every wait here is on an event the launcher or a child produced: a line on the
 * launcher's own output, or the launcher exiting. Nothing sleeps to guess how long
 * a step takes, and bun's per-test timeout is the only failure bound.
 */
const repoRoot = join(import.meta.dir, "..");

const SYSTEM_COMMANDS = [
  "bash",
  "env",
  "sed",
  "seq",
  "mktemp",
  "mkfifo",
  "rm",
  "sleep",
  "cat",
  "chmod",
  "ln",
  "mkdir",
  "dirname",
  "setsid",
  "uname",
];

function makeSystemPath(dir: string): string {
  const bin = join(dir, "sysbin");
  mkdirSync(bin, { recursive: true });
  for (const name of SYSTEM_COMMANDS) {
    const resolved = Bun.which(name);
    if (!resolved) continue;
    try {
      symlinkSync(resolved, join(bin, name));
    } catch {
      // Already linked by an earlier fixture in this process; harmless.
    }
  }
  return bin;
}

const fixtures: string[] = [];
afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

const COMPLETE_ENV = [
  "ORGANIZATION_ID=org_default",
  "MONGODB_URI=mongodb://127.0.0.1:27017/group_butler?replicaSet=rs0",
  "MONGODB_DB=group_butler",
  "ENVIRONMENT=development",
  "WORKER_SECRET=stub-worker-secret",
  "PORT=4000",
  "R2_ACCOUNT_ID=abcdef1234567890",
  "R2_ACCESS_KEY_ID=stub-access-key",
  "R2_SECRET_ACCESS_KEY=stub-secret-key",
  "R2_BUCKET=group-butler",
  "OWNER_EMAIL=owner@local",
  "OWNER_PASSWORD=local-password",
  // Quoted, because a real hash contains `$` and this file is sourced by the shell.
  "OWNER_PASSWORD_HASH='scrypt$16384$8$1$stub$stub'",
  "AUTH_SECRET=auth-secret-of-at-least-32-characters",
  "",
].join("\n");

/**
 * The names the fixture's own env file declares. The repository `.env` is loaded
 * into this test process (bun reads it at startup), so an inherited value under
 * one of these names would outlive the fixture's file and quietly decide a test
 * that means to withhold it.
 */
const FIXTURE_ENV_NAMES = COMPLETE_ENV.split("\n")
  .map((line) => line.split("=")[0] ?? "")
  .filter((name) => name !== "");

function withoutFixtureEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const name of FIXTURE_ENV_NAMES) delete copy[name];
  return copy;
}

interface Fixture {
  dir: string;
  path: string;
  state: string;
  invocations: () => string[];
  run: (args: string[], extraEnv?: Record<string, string>) => { code: number; stdout: string; stderr: string };
  spawn: (args: string[], extraEnv?: Record<string, string>) => Bun.Subprocess<"pipe", "pipe", "pipe">;
}

function makeFixture(opts: { env?: string | null; failBuild?: boolean } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "butler-prod-"));
  fixtures.push(dir);
  const state = join(dir, "state");
  const stubPath = join(dir, "stubbin");

  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "infra", "dev"), { recursive: true });
  mkdirSync(join(dir, "apps", "web"), { recursive: true });
  mkdirSync(join(dir, "apps", "worker"), { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(stubPath, { recursive: true });

  cpSync(join(repoRoot, "scripts", "prod.sh"), join(dir, "scripts", "prod.sh"));
  chmodSync(join(dir, "scripts", "prod.sh"), 0o755);
  // The launcher is a thin caller: the harness it runs is the shared one.
  cpSync(join(repoRoot, "scripts", "stack.sh"), join(dir, "scripts", "stack.sh"));
  writeFileSync(join(dir, "infra", "dev", "docker-compose.yml"), "name: group-butler-dev\nservices: {}\n");
  writeFileSync(join(dir, ".env.example"), COMPLETE_ENV);
  if (opts.env !== null) writeFileSync(join(dir, ".env"), opts.env ?? COMPLETE_ENV);

  const write = (name: string, body: string) => {
    const path = join(stubPath, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  };

  write(
    "docker",
    `#!/usr/bin/env bash
set -u
echo "docker $*" >> "$STUB_STATE/invocations"
if [[ "\${1:-} \${2:-}" == "compose version" ]]; then echo "Docker Compose version v2.99.0-stub"; exit 0; fi
if [[ "\${1:-}" != compose ]]; then echo "stub docker: unexpected argv: $*" >&2; exit 90; fi
case "\${4:-}" in
  exec) printf '1\\n'; exit 0 ;;
  down) echo down >> "$STUB_STATE/downed"; exit 0 ;;
  *) exit 0 ;;
esac
`,
  );

  // The build leaves behind what a real `next build` with standalone output
  // leaves: the server file the launcher runs, and the static tree it links in.
  write(
    "bun",
    `#!/usr/bin/env bash
echo "bun $*" >> "$STUB_STATE/invocations"
echo "$$" > "$STUB_STATE/build.pid"
mkdir -p "$STUB_FIXTURE/apps/web/.next/standalone/apps/web" "$STUB_FIXTURE/apps/web/.next/static"
cat > "$STUB_FIXTURE/apps/web/.next/standalone/apps/web/server.js" <<'EOS'
${STANDALONE_SERVER}EOS
chmod +x "$STUB_FIXTURE/apps/web/.next/standalone/apps/web/server.js"
echo "[web] stub next build"
exit "\${STUB_BUILD_FAIL:-0}"
`,
  );

  // `node apps/web/server.js` — the image's CMD. The stub records where it was
  // asked to run from and then executes the file, so the launcher's own command
  // and working directory are what the assertions are about.
  write(
    "node",
    `#!/usr/bin/env bash
echo "node $*" >> "$STUB_STATE/invocations"
exec bash "$@"
`,
  );

  // `go build -o <path> .` — and what it writes is a real executable, so the
  // launcher running it is observed rather than assumed.
  write(
    "go",
    `#!/usr/bin/env bash
echo "go $*" >> "$STUB_STATE/invocations"
if [[ "\${1:-}" != build ]]; then
  echo "stub go: expected 'go build', got: $*" >&2
  exit 91
fi
out=""
prev=""
for arg in "$@"; do
  if [[ "$prev" == "-o" ]]; then out="$arg"; fi
  prev="$arg"
done
if [[ -z "$out" ]]; then echo "stub go: no -o target" >&2; exit 93; fi
cat > "$out" <<'EOS'
#!/usr/bin/env bash
echo "$$" > "$STUB_STATE/worker.pid"
echo "$PWD" > "$STUB_STATE/worker.cwd"
trap 'echo stopped > "$STUB_STATE/worker.stopped"; exit 143' TERM INT
echo "[worker] compiled worker started"
while true; do sleep 0.2; done
EOS
chmod +x "$out"
`,
  );

  write(
    "curl",
    `#!/usr/bin/env bash
echo "curl \${!#}" >> "$STUB_STATE/invocations"
printf '403'
`,
  );

  const env = (extra: Record<string, string> = {}) => ({
    ...withoutFixtureEnv(process.env),
    PATH: `${stubPath}:${makeSystemPath(dir)}`,
    STUB_STATE: state,
    STUB_FIXTURE: dir,
    PROD_ENV_FILE: join(dir, ".env"),
    ...(opts.failBuild ? { STUB_BUILD_FAIL: "1" } : {}),
    ...extra,
  });

  return {
    dir,
    path: stubPath,
    state,
    // A test that expects the launcher to refuse before doing anything has no
    // invocations at all, which is an answer rather than a missing file.
    invocations: () => (readFileIfPresent(join(state, "invocations")) ?? "").split("\n").filter(Boolean),
    run: (args, extra) => {
      const proc = Bun.spawnSync(["bash", join(dir, "scripts", "prod.sh"), ...args], { cwd: dir, env: env(extra) });
      return { code: proc.exitCode ?? -1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
    },
    spawn: (args, extra) => Bun.spawn(["bash", join(dir, "scripts", "prod.sh"), ...args], { cwd: dir, env: env(extra) }),
  };
}

function readFileIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * A cursor over a spawned launcher's output: `await follow(needle)` returns what
 * has been printed once `needle` appears in it. The wait is the pipe itself, so it
 * ends the moment the launcher says the thing happened — never after a guessed
 * delay. One reader per process, because a stream has exactly one.
 */
function followOutput(proc: Bun.Subprocess<"pipe", "pipe", "pipe">) {
  const decoder = new TextDecoder();
  const reader = proc.stdout.getReader();
  let seen = "";
  return async (needle: string): Promise<string> => {
    for (;;) {
      if (seen.includes(needle)) return seen;
      const { done, value } = await reader.read();
      if (done) throw new Error(`the launcher exited before printing ${needle}; output was:\n${seen}`);
      seen += decoder.decode(value, { stream: true });
    }
  };
}

/**
 * The file `next build` produces, as this fixture's version of it: the BFF child
 * the launcher then runs, which reports where it was started from and stops when
 * the launcher stops it.
 */
const STANDALONE_SERVER = `#!/usr/bin/env bash
echo "$$" > "$STUB_STATE/web.pid"
echo "$PWD" > "$STUB_STATE/web.cwd"
trap 'echo stopped > "$STUB_STATE/web.stopped"; exit 143' TERM INT
echo "[web] standalone server started"
while true; do sleep 0.2; done
`;

/**
 * What a previous run of this launcher leaves behind: the standalone server (the
 * artifact `next build` produces and the one this mode runs) and the compiled
 * worker. Both are what the next run looks for before deciding to build.
 */
function leaveBuiltArtifacts(fx: Fixture, opts: { worker?: boolean } = {}): void {
  const appDir = join(fx.dir, "apps", "web", ".next", "standalone", "apps", "web");
  mkdirSync(join(appDir, ".next"), { recursive: true });
  writeFileSync(join(appDir, "server.js"), STANDALONE_SERVER);
  chmodSync(join(appDir, "server.js"), 0o755);
  if (opts.worker === false) return;
  // An executable where the worker is compiled to; the launcher only checks that
  // it is there and runs it.
  writeFileSync(join(fx.dir, "apps", "worker", "whatsapp-worker"), "#!/usr/bin/env bash\ntrue\n");
  chmodSync(join(fx.dir, "apps", "worker", "whatsapp-worker"), 0o755);
}

describe("production launcher: the console it refuses to serve without", () => {
  test("refuses a deployment whose plaintext password cannot be used, naming the fix", () => {
    const fx = makeFixture({ env: COMPLETE_ENV.replace("OWNER_PASSWORD_HASH='scrypt$16384$8$1$stub$stub'\n", "") });
    const res = fx.run(["--check", "--no-infra"]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("OWNER_PASSWORD_HASH");
    expect(res.stderr).toContain("auth:hash");
    // The refusal comes before any work: nothing was built.
    expect(res.stderr).not.toContain("building");
  });

  test("refuses an AUTH_SECRET too short to sign a session", () => {
    const fx = makeFixture({ env: COMPLETE_ENV.replace("AUTH_SECRET=auth-secret-of-at-least-32-characters", "AUTH_SECRET=short") });
    const res = fx.run(["--check", "--no-infra"]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("AUTH_SECRET");
    expect(res.stderr).toContain("32");
  });

  /**
   * The hash `bun run auth:hash` prints is `scrypt$16384$8$1$…`, and the launcher
   * sources this file. Unquoted, the shell expands `$16384` and aborts the script
   * with its own unbound-variable error — against a line number, with nothing
   * naming the file or the fix. It is refused here with the quoting it needs.
   */
  test("refuses a hash whose dollars were left unquoted, and says how to quote them", () => {
    const fx = makeFixture({
      env: COMPLETE_ENV.replace("OWNER_PASSWORD_HASH='scrypt$16384$8$1$stub$stub'", "OWNER_PASSWORD_HASH=scrypt$16384$8$1$stub$stub"),
    });
    const res = fx.run(["--check", "--no-infra"]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("could not read");
    expect(res.stderr).toContain("single quotes");
    expect(fx.invocations()).toEqual([]);
  });

  test("--check validates and builds nothing at all", () => {
    const fx = makeFixture();
    const res = fx.run(["--check", "--no-infra"]);

    expect(res.code).toBe(0);
    expect(res.stdout).toContain("check ok");
    expect(fx.invocations().filter((line) => line.startsWith("go build"))).toEqual([]);
    expect(readFileIfPresent(join(fx.state, "build.pid"))).toBeNull();
  });
});

/**
 * A build that is already there is reused: `next build` writes `apps/web/.next`
 * and the worker is compiled to `apps/worker/whatsapp-worker`, so a restart over an
 * unchanged tree starts in seconds instead of rebuilding for a minute. Neither tool
 * can tell this working tree from the one it built last, which is why `--force`
 * exists and why the reuse says so out loud.
 */
describe("production launcher: builds are kept", () => {
  test("reuses both artifacts and says so, without invoking either builder", async () => {
    const fx = makeFixture();
    leaveBuiltArtifacts(fx);

    const proc = fx.spawn([]);
    try {
      const follow = followOutput(proc);
      const seen = await follow("[web] standalone server started");
      expect(seen.replace(/\u001b\[[0-9;]*m/gu, "")).toContain("reusing the existing builds");
      expect(fx.invocations().some((line) => line.includes("build"))).toBe(false);
    } finally {
      proc.kill("SIGTERM");
      // Reaped here rather than after the try: an assertion that fails must not
      // leave the launcher running past the fixture's own cleanup.
      await proc.exited;
    }
  });

  test("--force rebuilds what is already there", async () => {
    const fx = makeFixture();
    leaveBuiltArtifacts(fx);

    const proc = fx.spawn(["--force"]);
    try {
      const follow = followOutput(proc);
      const seen = await follow("[web] standalone server started");
      expect(seen.replace(/\u001b\[[0-9;]*m/gu, "")).not.toContain("reusing the existing builds");
      const invocations = fx.invocations();
      expect(invocations.some((line) => line.includes("build"))).toBe(true);
      expect(invocations.some((line) => line.startsWith("go build"))).toBe(true);
    } finally {
      proc.kill("SIGTERM");
      // Reaped here rather than after the try: an assertion that fails must not
      // leave the launcher running past the fixture's own cleanup.
      await proc.exited;
    }
  });

  // Each artifact is judged on its own, so a worker change does not pay for a
  // `next build` it does not need.
  test("builds only what is missing", async () => {
    const fx = makeFixture();
    leaveBuiltArtifacts(fx, { worker: false });

    const proc = fx.spawn([]);
    try {
      const follow = followOutput(proc);
      await follow("[worker] compiled worker started");
      const invocations = fx.invocations();
      expect(invocations.some((line) => line.includes("bun run") && line.includes("build"))).toBe(false);
      expect(invocations.some((line) => line.startsWith("go build"))).toBe(true);
    } finally {
      proc.kill("SIGTERM");
      // Reaped here rather than after the try: an assertion that fails must not
      // leave the launcher running past the fixture's own cleanup.
      await proc.exited;
    }
  });
});

describe("production launcher: built, not interpreted", () => {
  test("builds both, then runs the compiled binary as the worker", async () => {
    const fx = makeFixture();
    const proc = fx.spawn([]);
    try {
      // The launcher's own output is the signal: children are prefixed through a
      // FIFO, so a line here means that child is up.
      const follow = followOutput(proc);
      await follow("[web] standalone server started");
      const seen = await follow("[worker] compiled worker started");

      // The launcher colours its own prefix, so the marker is read from the line
      // without it — the build phase announced before either child started.
      expect(seen.replace(/\u001b\[[0-9;]*m/gu, "")).toContain("[prod] building");
      const invocations = fx.invocations();
      const built = invocations.indexOf(`bun run --cwd ${join(fx.dir, "apps", "web")} build`);
      const compiled = invocations.findIndex((line) => line.startsWith("go build"));
      // The deployment's own entry point, not `next start`: the app is built with
      // standalone output and this is the file the image's CMD names.
      const started = invocations.findIndex((line) => line.startsWith("node apps/web/server.js"));

      expect(built).toBeGreaterThanOrEqual(0);
      expect(compiled).toBeGreaterThan(built);
      // The server that serves the build starts after the build has finished.
      expect(started).toBeGreaterThan(compiled);
      // …and it is started from the standalone root, so the assets it serves
      // beside itself are the ones this run linked in.
      expect(readFileIfPresent(join(fx.state, "web.cwd"))?.trim()).toBe(
        join(fx.dir, "apps", "web", ".next", "standalone"),
      );
      // `go run` compiles and supervises in one child; production compiles first.
      expect(invocations.some((line) => line.startsWith("go run"))).toBe(false);

      // The worker child is the file the build wrote, run from apps/worker so its
      // whatsmeow store stays where the dev session left it.
      expect(readFileIfPresent(join(fx.state, "worker.cwd"))?.trim()).toBe(join(fx.dir, "apps", "worker"));
    } finally {
      proc.kill("SIGTERM");
    }

    // The launcher does not exit until it has reaped both children, so their stop
    // markers are a consequence of its exit rather than a race with it.
    await proc.exited;
    expect(readFileIfPresent(join(fx.state, "web.stopped"))).toBe("stopped\n");
    expect(readFileIfPresent(join(fx.state, "worker.stopped"))).toBe("stopped\n");
  });

  // A stack that half-started around a failed build would serve whatever was built
  // last, which is the one thing a production run exists to rule out.
  test("starts nothing when the build fails, and carries the build's failure out", () => {
    const fx = makeFixture({ failBuild: true });
    const res = fx.run([]);

    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("build failed");
    expect(readFileIfPresent(join(fx.state, "web.pid"))).toBeNull();
    expect(readFileIfPresent(join(fx.state, "worker.pid"))).toBeNull();
    expect(fx.invocations().some((line) => line.startsWith("go build"))).toBe(false);
  });
});
