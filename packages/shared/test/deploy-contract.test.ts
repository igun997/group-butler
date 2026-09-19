import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The production operator path, as two committed artifacts that must agree with each other and
 * with `docs/architecture-draft.md` §12.3:
 *
 *   - `infra/prod/docker-compose.ghcr.yml`, the optional pull-only wrapper around the two
 *     published images, and
 *   - `apps/web/.env.production.example`, the `WORKER_URL` an operator copies for the plain
 *     `docker run` pair.
 *
 * The failure this guards is silent: a `WORKER_URL` whose host is loopback, or one that names a
 * container/host the operator's network never creates, leaves both containers healthy while every
 * BFF → worker call (health included) fails. Nothing about it is visible from `docker ps`.
 */
const root = join(import.meta.dir, "../../..");
const COMPOSE = "infra/prod/docker-compose.ghcr.yml";
const WEB_EXAMPLE = "apps/web/.env.production.example";

/**
 * The `services:` block of this hand-written compose file, as service name → its own lines. A
 * full YAML parser is not worth a dependency here: the assertions below are about which service
 * declares what, and the file is written by this repo.
 */
function services(text: string): Map<string, string> {
  const found = new Map<string, string>();
  let inside = false;
  let current: string | null = null;
  for (const line of text.split("\n")) {
    if (!inside) {
      if (/^services:\s*$/.test(line)) inside = true;
      continue;
    }
    if (/^\S/.test(line)) break; // the next top-level key ends the block
    const service = /^ {2}([a-z0-9-]+):\s*$/.exec(line);
    if (service) {
      current = service[1]!;
      found.set(current, "");
      continue;
    }
    if (current) found.set(current, `${found.get(current)}${line}\n`);
  }
  return found;
}

/** `WORKER_URL:`'s value, with the default of a `${VAR:-default}` expression standing in for it. */
function workerUrlValue(body: string): string {
  const raw = /^ *WORKER_URL: *(.*)$/m.exec(body)?.[1]?.trim() ?? "";
  const fallback = /\$\{[A-Z0-9_]+:-([^}]+)\}/.exec(raw)?.[1];
  return (fallback ?? raw).replace(/^["']|["']$/g, "");
}

/** `KEY=`'s value in an env file, which Docker's parser reads literally. */
function envValue(text: string, key: string): string {
  const line = new RegExp(`^${key}=(.*)$`, "m").exec(text)?.[1];
  if (line === undefined) throw new Error(`${key} is missing`);
  return line.trim();
}

describe("production rollout: the pull-only compose wrapper", () => {
  const text = readFileSync(join(root, COMPOSE), "utf8");
  const declared = services(text);

  test("pulls the two published images instead of building anything", () => {
    expect([...declared.keys()].sort()).toEqual(["web", "worker"]);
    // The whole point of the wrapper: an image the operator cannot rebuild here.
    expect(text).not.toMatch(/^ *build:/m);
    expect(declared.get("worker")).toMatch(/ghcr\.io\/.*\/group-butler\/worker:/);
    expect(declared.get("web")).toMatch(/ghcr\.io\/.*\/group-butler\/web:/);
  });

  test("keeps the worker's control plane private", () => {
    const worker = declared.get("worker")!;
    expect(worker).not.toMatch(/^ *ports:/m);
    // The auth-store volume this used to assert is gone: the worker holds no
    // WhatsApp session any more, so there is no device credential to keep. What
    // remains worth pinning is that its control plane stays off the network.
  });

  test("points the BFF at the worker over the compose network, not at its own loopback", () => {
    const url = new URL(workerUrlValue(declared.get("web")!));
    // The host has to be a service in this file: that name is what the network resolves.
    expect(declared.has(url.hostname)).toBe(true);
    expect(["127.0.0.1", "localhost", "0.0.0.0", "::1"]).not.toContain(url.hostname);
    expect(url.port).toBe("4000");
  });

  test("starts the web service only once the worker's own probe passes", () => {
    const web = declared.get("web")!;
    expect(web).toMatch(/depends_on:/);
    expect(web).toMatch(/condition: service_healthy/);
  });
});

describe("production rollout: the web example's WORKER_URL", () => {
  test("names a host the documented `docker run` pair actually creates", () => {
    const example = readFileSync(join(root, WEB_EXAMPLE), "utf8");
    const url = new URL(envValue(example, "WORKER_URL"));
    // §12.3 runs the worker as `--name butler-worker` on the `butler` network, which is what makes
    // this name resolve. Loopback would resolve to the BFF container itself and reach nothing.
    expect(url.hostname).toBe("butler-worker");
    expect(url.port).toBe("4000");
  });

  test("the example is a valid env file, not a checklist with trailing comments", () => {
    const example = readFileSync(join(root, WEB_EXAMPLE), "utf8");
    // Docker's env-file parser keeps a trailing `# ...` in the value, so a comment on a value line
    // reaches the container as data — e.g. a WORKER_SECRET that can never match the worker's.
    const commented = example.split("\n").filter((line) => /^[A-Z][A-Z0-9_]*=.*\s#/.test(line));
    expect(commented).toEqual([]);
  });
});

describe("production rollout: the documented wrapper exists", () => {
  test("infra/prod/docker-compose.ghcr.yml is present in the tree", () => {
    // Both docs (§12.3 and the plan's Task 24) name this path as the operator's compose entry
    // point; a deleted file would leave the runbook pointing at nothing.
    expect(existsSync(join(root, COMPOSE))).toBe(true);
  });
});
