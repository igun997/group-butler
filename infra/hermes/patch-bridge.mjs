#!/usr/bin/env node
/**
 * Adds an archive forwarder to Hermes's WhatsApp bridge.
 *
 * Hermes's bridge is the only place that sees every inbound WhatsApp message:
 * the Python gateway decides what to hand the agent, and a message it declines
 * is dropped without its text ever being written anywhere. Passive listening —
 * a durable record of a group's chatter, attachments included — therefore has to
 * hook the bridge, before any of that gating.
 *
 * The bridge ships inside the Hermes image, so the patch is applied to a copy
 * extracted from that image and the copy is mounted over the original. Keeping
 * the change as a script rather than a checked-in 27 KB vendored file means an
 * image bump is a re-run plus a look at the anchors below, not a three-way merge
 * against a file nobody reads.
 *
 *   node infra/hermes/patch-bridge.mjs <image> <output-path>
 *
 * Then mount `<output-path>` at `/opt/hermes/scripts/whatsapp-bridge/bridge.js`.
 *
 * Configuration is by environment, all optional — with no URL the bridge behaves
 * exactly as it shipped:
 *   WHATSAPP_ARCHIVE_URL     where each event is POSTed
 *   WHATSAPP_ARCHIVE_SECRET  bearer token for that endpoint
 *   WHATSAPP_ARCHIVE_TIMEOUT_MS  per-request timeout (default 10000)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [sourceArg, output] = process.argv.slice(2);
if (!sourceArg || !output) {
  console.error("usage: patch-bridge.mjs <image | path-to-bridge.js> <output-path>");
  process.exit(2);
}

const BRIDGE_PATH = "/opt/hermes/scripts/whatsapp-bridge/bridge.js";

/**
 * Two ways in, because there are two places this runs: against an image, to
 * produce a patch to mount (development), and against a file already inside a
 * build, so the result can be baked into an image (deployment). A deployed image
 * must not depend on `docker run` being available to its own build.
 */
const source = existsSync(sourceArg)
  ? readFileSync(sourceArg, "utf8")
  : execFileSync("docker", ["run", "--rm", "--entrypoint", "cat", sourceArg, BRIDGE_PATH], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });

/** The group-operation endpoints, kept in their own file so they stay reviewable. */
const GROUP_ACTIONS = readFileSync(join(import.meta.dirname, "bridge-group-actions.js"), "utf8");

/** Anchors are asserted so an image that moves them fails loudly instead of silently unpatching. */
const CONFIG_ANCHOR = "const MAX_MESSAGE_LENGTH = parseInt(process.env.WHATSAPP_MAX_MESSAGE_LENGTH || '4096', 10);";
const PUSH_ANCHOR = "      messageQueue.push(event);";
const HEALTH_ANCHOR = "app.get('/health', (req, res) => {";

/**
 * The bridge's DNS-rebinding guard, which accepts loopback hosts only. That guard
 * is worth keeping — it is what stops a browser on the same machine from being
 * tricked into reaching the bridge — but it also makes the bridge unreachable by
 * the services that must call it, since the worker and the console run in sibling
 * containers and send their own Host. The list stays an allowlist: the deployment
 * names the hosts it trusts, and nothing else is admitted.
 */
const HOSTS_ANCHOR = `const _ACCEPTED_HOST_VALUES = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  '::1',
]);`;
const HOSTS_PATCHED = `const _ACCEPTED_HOST_VALUES = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  '::1',
  // Added by group-butler (see infra/hermes/patch-bridge.mjs): the services that
  // execute group actions live in sibling containers. Comma-separated hostnames.
  ...String(process.env.WHATSAPP_BRIDGE_ALLOWED_HOSTS || '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean),
]);`;

/**
 * The interface the bridge listens on. Loopback is the right default and stays
 * the default — the bridge has no authentication of its own, and only the Host
 * allowlist above stands between it and anything that can reach it. A deployment
 * whose worker and console run in sibling containers has to opt in to binding the
 * network interface; without that, every group action fails as unreachable while
 * the bridge looks perfectly healthy from inside its own container.
 */
const BIND_ANCHOR = "  app.listen(PORT, '127.0.0.1', () => {";
const BIND_PATCHED = "  app.listen(PORT, process.env.WHATSAPP_BRIDGE_BIND || '127.0.0.1', () => {";

/** The archive forwarder, kept in its own file so it stays reviewable. */
const FORWARDER = readFileSync(join(import.meta.dirname, "bridge-archive-forwarder.js"), "utf8").trimEnd();

const PUSH_PATCHED = `      messageQueue.push(event);
      // Fire-and-forget: archiving must never delay or fail delivery to the agent.
      archiveForward({ ...event, fromMe: !!msg.key.fromMe }).catch(() => {});`;

for (const [name, anchor] of [
  ["config anchor", CONFIG_ANCHOR],
  ["queue-push anchor", PUSH_ANCHOR],
  ["health anchor", HEALTH_ANCHOR],
  ["host-guard anchor", HOSTS_ANCHOR],
  ["bind anchor", BIND_ANCHOR],
]) {
  const occurrences = source.split(anchor).length - 1;
  if (occurrences !== 1) {
    console.error(`patch-bridge: expected exactly one ${name} in ${sourceArg}, found ${occurrences}`);
    process.exit(1);
  }
}

const patched = source
  .replace(CONFIG_ANCHOR, FORWARDER)
  .replace(PUSH_ANCHOR, PUSH_PATCHED)
  .replace(HEALTH_ANCHOR, `${GROUP_ACTIONS}\n${HEALTH_ANCHOR}`)
  .replace(HOSTS_ANCHOR, HOSTS_PATCHED)
  .replace(BIND_ANCHOR, BIND_PATCHED);
writeFileSync(output, patched, "utf8");
console.log(`patched ${sourceArg} -> ${output} (${patched.length} bytes)`);
