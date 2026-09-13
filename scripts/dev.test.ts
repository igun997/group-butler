import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const launcherSource = join(repoRoot, "scripts/dev.sh");

/** Commands the launcher legitimately needs from the host system. */
const SYSTEM_COMMANDS = ["bash", "env", "sed", "seq", "mktemp", "mkfifo", "rm", "sleep", "cat", "dirname", "setsid", "uname"];

/**
 * A PATH containing only these commands, so "no docker binary" really means no
 * docker — the host's own docker must never be reachable from a test (a fixture
 * without a docker stub previously reached the real one and ran `compose down`).
 */
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
  'MONGODB_DB="group butler"',
  "MONGODB_DB_FOR_SUMMARY=unused",
  "ENVIRONMENT=development",
  "WORKER_SECRET=dev-secret",
  "PORT=4000",
  "R2_ACCOUNT_ID=abcdef1234567890",
  "R2_ACCESS_KEY_ID=stub-access-key",
  "R2_SECRET_ACCESS_KEY=stub-secret-key",
  "R2_BUCKET=group-butler-dev",
  "",
].join("\n");

interface Fixture {
  dir: string;
  state: string;
  stubPath: string;
  env: (extra?: Record<string, string>) => Record<string, string>;
  invocations: () => string[];
  childSignals: () => string;
  run: (args: string[], extraEnv?: Record<string, string>) => { code: number; stdout: string; stderr: string };
  spawn: (args: string[], extraEnv?: Record<string, string>) => Bun.Subprocess<"pipe", "pipe", "pipe">;
}

function makeFixture(opts: { env?: string | null; stubDocker?: boolean; failWeb?: boolean } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "butler-launcher-"));
  fixtures.push(dir);
  const state = join(dir, "state");
  const stubPath = join(dir, "stubbin");

  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "infra", "dev"), { recursive: true });
  mkdirSync(join(dir, "apps", "web"), { recursive: true });
  mkdirSync(join(dir, "apps", "worker"), { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(stubPath, { recursive: true });

  cpSync(launcherSource, join(dir, "scripts", "dev.sh"));
  chmodSync(join(dir, "scripts", "dev.sh"), 0o755);
  // Content is irrelevant: the docker stub never reads it.
  writeFileSync(join(dir, "infra", "dev", "docker-compose.yml"), "name: group-butler-dev\nservices: {}\n");
  writeFileSync(join(dir, ".env.example"), COMPLETE_ENV);
  if (opts.env !== null) writeFileSync(join(dir, ".env"), opts.env ?? COMPLETE_ENV);

  const write = (name: string, body: string) => {
    const path = join(stubPath, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  };

  if (opts.stubDocker ?? true) {
    write(
      "docker",
      `#!/usr/bin/env bash
set -u
echo "docker $*" >> "$STUB_STATE/invocations"
if [[ "\${1:-} \${2:-}" == "compose version" ]]; then echo "Docker Compose version v2.99.0-stub"; exit 0; fi
if [[ "\${1:-}" != compose ]]; then echo "stub docker: unexpected argv: $*" >&2; exit 90; fi
file="\${3:-}"; sub="\${4:-}"
if [[ "$sub" == up ]]; then
  for arg in "$@"; do
    case "$arg" in web|worker) echo "stub docker: refusing to start app container '$arg'" >&2; exit 99;; esac
  done
  echo "\${3}" >> "$STUB_STATE/up_files"
  exit 0
fi
case "$sub" in
  exec) printf '1\\n'; exit 0 ;;
  down) echo down >> "$STUB_STATE/downed"; exit 0 ;;
  *) exit 0 ;;
esac
`,
    );
  }

  write(
    "bun",
    `#!/usr/bin/env bash
echo "bun $*" >> "$STUB_STATE/invocations"
echo "$$" > "$STUB_STATE/web.pid"
trap 'echo web-signal >> "$STUB_STATE/child_signals"; exit 143' TERM INT
echo "[web] stub bff started"
sleep 0.2
if [[ "\${STUB_FAIL_WEB:-}" == "1" ]]; then echo "[web] stub bff failing" >&2; exit 3; fi
while true; do sleep 0.2; done
`,
  );

  write(
    "go",
    `#!/usr/bin/env bash
echo "go $*" >> "$STUB_STATE/invocations"
echo "$$" > "$STUB_STATE/worker.pid"
trap 'echo worker-signal >> "$STUB_STATE/child_signals"; exit 143' TERM INT
echo "[worker] stub worker started"
while true; do sleep 0.2; done
`,
  );

  write(
    "curl",
    `#!/usr/bin/env bash
url="\${!#}"
echo "curl $url" >> "$STUB_STATE/invocations"
printf '403'
`,
  );

  const env = (extra: Record<string, string> = {}) => ({
    ...process.env,
    PATH: `${stubPath}:${makeSystemPath(dir)}`,
    STUB_STATE: state,
    DEV_ENV_FILE: join(dir, ".env"),
    ...(opts.failWeb ? { STUB_FAIL_WEB: "1" } : {}),
    ...extra,
  });

  const invocations = () =>
    readFileSyncIfPresent(join(state, "invocations"))?.split("\n").filter(Boolean) ?? [];

  return {
    dir,
    state,
    stubPath,
    env,
    invocations,
    childSignals: () => readFileSyncIfPresent(join(state, "child_signals")) ?? "",
    run: (args, extra) => {
      const proc = Bun.spawnSync(["bash", join(dir, "scripts", "dev.sh"), ...args], {
        cwd: dir,
        env: env(extra),
      });
      return {
        code: proc.exitCode ?? -1,
        stdout: proc.stdout.toString(),
        stderr: proc.stderr.toString(),
      };
    },
    spawn: (args, extra) =>
      Bun.spawn(["bash", join(dir, "scripts", "dev.sh"), ...args], { cwd: dir, env: env(extra) }),
  };
}

function readFileSyncIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** A pid file written by a stub, validated so it cannot smuggle shell syntax. */
function readPid(path: string): string | null {
  const raw = (readFileSyncIfPresent(path) ?? "").trim();
  return /^\d+$/.test(raw) ? raw : null;
}

/**
 * The launcher is a separate OS process, so its observable progress is a file it
 * causes a child to write, not a promise this test owns. Waiting polls that real
 * signal and returns the moment it appears — the timeout is only a failure
 * bound, never a fixed delay the assertions depend on.
 */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

const waitForFile = (path: string, what = path) => waitFor(() => readFileSyncIfPresent(path) !== null, what);

const waitForFileText = (path: string, needle: string) =>
  waitFor(() => (readFileSyncIfPresent(path) ?? "").includes(needle), `${needle} in ${path}`);

const waitForGone = (pid: string | null) =>
  waitFor(() => {
    if (!pid) return false;
    const probe = Bun.spawnSync(["bash", "-c", `kill -0 ${pid} 2>/dev/null && echo alive || echo gone`]);
    return probe.stdout.toString().trim() === "gone";
  }, `pid ${pid} to exit`);

async function collect(proc: Bun.Subprocess<"pipe", "pipe", "pipe">): Promise<{ code: number; stdout: string; stderr: string }> {
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

describe("dev launcher: environment preflight", () => {
  test("fails fast and actionably when .env is missing", () => {
    const fx = makeFixture({ env: null });
    const res = fx.run(["--check"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("cp .env.example .env");
    // Nothing may be started before the environment is known good.
    expect(fx.invocations()).toEqual([]);
  });

  test("rejects placeholder R2 values before touching docker, naming each one", () => {
    const fx = makeFixture({
      env: COMPLETE_ENV.replace("R2_ACCOUNT_ID=abcdef1234567890", "R2_ACCOUNT_ID=REPLACE_WITH_R2_ACCOUNT_ID").replace(
        "R2_SECRET_ACCESS_KEY=stub-secret-key",
        "R2_SECRET_ACCESS_KEY=REPLACE_WITH_R2_SECRET_ACCESS_KEY",
      ),
    });
    const res = fx.run(["--check", "--no-infra"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("R2_ACCOUNT_ID");
    expect(res.stderr).toContain("R2_SECRET_ACCESS_KEY");
    expect(res.stderr).toContain("Manage API Tokens");
    expect(fx.invocations()).toEqual([]);
  });

  test("rejects an unknown flag with a usage exit code", () => {
    const fx = makeFixture();
    const res = fx.run(["--nope"]);
    expect(res.code).toBe(2);
  });
});

describe("dev launcher: R2 endpoint derivation", () => {
  test("probes the endpoint derived from the account id, with no override variable", () => {
    const fx = makeFixture();
    const res = fx.run(["--check", "--no-infra"]);
    expect(res.code).toBe(0);
    const probes = fx.invocations().filter((line) => line.startsWith("curl "));
    expect(probes).toHaveLength(1);
    expect(probes[0]).toBe("curl https://abcdef1234567890.r2.cloudflarestorage.com/group-butler-dev");
    // A configured endpoint would have been used instead if one were allowed.
    expect(res.stdout).not.toContain("R2_ENDPOINT");
  });

  test("reads values through shell sourcing, so quoted values survive intact", () => {
    const fx = makeFixture();
    const res = fx.run(["--check", "--no-infra"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('mongo_db="group butler"');
  });
});

describe("dev launcher: --check is validation only", () => {
  test("validates, verifies mongo, and starts no application process", () => {
    const fx = makeFixture();
    const res = fx.run(["--check"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("check ok");
    const inv = fx.invocations();
    expect(inv.some((l) => l.includes("bun run --cwd"))).toBe(false);
    expect(inv.some((l) => l.includes("go run"))).toBe(false);
    expect(inv.some((l) => l.startsWith("docker") && l.includes(" up "))).toBe(true);
  });

  test("--no-infra never invokes docker at all", () => {
    const fx = makeFixture({ stubDocker: false });
    const res = fx.run(["--check", "--no-infra"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("check ok");
    expect(fx.invocations().filter((l) => l.startsWith("docker"))).toEqual([]);
  });
});

describe("dev launcher: run mode", () => {
  test("starts infra, then the BFF and the worker as host processes with prefixed logs", async () => {
    const fx = makeFixture();
    const proc = fx.spawn([]);
    await waitForFile(join(fx.state, "web.pid"), "the bff child to start");
    await waitForFile(join(fx.state, "worker.pid"), "the worker child to start");
    proc.kill("SIGINT");
    const res = await collect(proc);

    const inv = fx.invocations();
    const upIndex = inv.findIndex((l) => l.startsWith("docker") && l.includes(" up "));
    const webIndex = inv.findIndex((l) => l.startsWith("bun run --cwd"));
    const workerIndex = inv.findIndex((l) => l.startsWith("go "));
    expect(upIndex).toBeGreaterThanOrEqual(0);
    expect(webIndex).toBeGreaterThan(upIndex);
    expect(workerIndex).toBeGreaterThanOrEqual(0);

    // The web app is started through the workspace script with the corrected Bun ordering.
    expect(inv[webIndex]).toContain("bun run --cwd");
    expect(inv[webIndex]).toContain("apps/web");
    expect(inv[webIndex]).toMatch(/\bdev\b/);

    // Logs are namespaced per process.
    expect(res.stdout).toContain("[dev]");
    expect(res.stdout).toContain("[web] stub bff started");
    expect(res.stdout).toContain("[worker] stub worker started");

    // Only the infra compose file is ever addressed, and never an app service.
    expect(inv.filter((l) => l.includes("apps/web") || l.includes("apps/worker")).every((l) => !l.startsWith("docker"))).toBe(true);
    const upFiles = readFileSyncIfPresent(join(fx.state, "up_files")) ?? "";
    expect(upFiles).toContain("infra/dev/docker-compose.yml");
  });

  test("preserves a child's failure exit code and stops the sibling", async () => {
    const fx = makeFixture({ failWeb: true });
    const res = await collect(fx.spawn([]));
    expect(res.code).toBe(3);
    // The worker was running and had to be cleaned up; it must not survive.
    const workerPid = readPid(join(fx.state, "worker.pid"));
    expect(workerPid).not.toBeNull();
    await waitForGone(workerPid);
    await waitForFileText(join(fx.state, "child_signals"), "worker-signal");
  });

  test("forwards signals to both children and leaves docker running by default", async () => {
    const fx = makeFixture();
    const proc = fx.spawn([]);
    await waitForFile(join(fx.state, "web.pid"), "the bff child to start");
    await waitForFile(join(fx.state, "worker.pid"), "the worker child to start");
    proc.kill("SIGINT");
    const res = await collect(proc);

    await waitForFileText(join(fx.state, "child_signals"), "web-signal");
    await waitForFileText(join(fx.state, "child_signals"), "worker-signal");
    expect(res.stdout).toContain("infra left running");
    expect(fx.invocations().some((l) => l.includes(" down"))).toBe(false);
    // A launcher interrupted by SIGINT exits 128 + 2, the conventional status.
    expect(res.code).toBe(130);
  });

  test("DEV_STOP_INFRA=1 tears the infra down on exit", async () => {
    const fx = makeFixture();
    const proc = fx.spawn([], { DEV_STOP_INFRA: "1" });
    await waitForFile(join(fx.state, "web.pid"), "the bff child to start");
    await waitForFile(join(fx.state, "worker.pid"), "the worker child to start");
    proc.kill("SIGINT");
    const res = await collect(proc);

    await waitFor(() => fx.invocations().some((l) => l.startsWith("docker") && l.includes(" down")), "docker compose down");
    expect(res.stdout).toContain("stopping infra");
  });

  test("--no-infra with DEV_STOP_INFRA=1 never invokes docker", async () => {
    // Teardown requires that THIS run started infra: --no-infra means the
    // launcher never touched Docker, so it must not stop someone else's stack.
    const fx = makeFixture({ failWeb: true });
    const res = await collect(fx.spawn(["--no-infra"], { DEV_STOP_INFRA: "1" }));

    expect(res.code).toBe(3);
    expect(fx.invocations().filter((l) => l.startsWith("docker"))).toEqual([]);
    expect(res.stdout).not.toContain("stopping infra");
    expect(res.stdout).not.toContain("infra left running");
  });

  test("--no-infra needs no docker binary at all", async () => {
    const fx = makeFixture({ stubDocker: false, failWeb: true });
    const res = await collect(fx.spawn(["--no-infra"], { DEV_STOP_INFRA: "1" }));

    // Nothing docker-related may be attempted, so no teardown messaging and the
    // child's status survives (a docker call would surface as 127 or a warning).
    expect(res.code).toBe(3);
    expect(res.stdout).not.toContain("stopping infra");
    expect(res.stdout).not.toContain("infra left running");
  });
});
