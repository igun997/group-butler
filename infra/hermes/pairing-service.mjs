#!/usr/bin/env node
/**
 * Pairing and live status, as HTTP, from inside the Hermes container.
 *
 * Why this exists: Hermes's pairing is a terminal wizard. `hermes whatsapp`
 * refuses to run without a TTY, so it can only be driven by a process that has
 * the Hermes CLI and can allocate a pseudo-terminal. The console and the worker
 * run in their own containers and have neither, which is why a console "Pair
 * again" button could not work, and why sharing Hermes's data directory was the
 * only way for anything else to see the account's state.
 *
 * So the capability lives where it can actually run, and is offered as HTTP. That
 * removes every cross-container filesystem dependency: no uid alignment, no shared
 * volume, and the same configuration works under docker-compose and as separate
 * services on EasyPanel.
 *
 * It deliberately does NOT render the QR. It answers with the glyphs the wizard
 * printed and lets the caller turn them into an image, because the console
 * already owns that conversion and a second implementation would be a second
 * thing to keep correct.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const PORT = Number(process.env.BUTLER_PAIRING_PORT || 3010);
const HERMES_HOME = process.env.HERMES_HOME || "/opt/data";
const GATEWAY_STATE = `${HERMES_HOME}/gateway_state.json`;

/** The wizard's own words — the only progress signal it gives. */
const QR_MARKER = "Scan this QR code";
const PAIRED_MARKERS = ["is configured and paired", "paired successfully"];
const RE_PAIR_PROMPT = "Re-pair?";
const MAX_ANSWERS = 8;

/** One pairing at a time: the wizard takes the WhatsApp session lock. */
let session = null;

/** The text of the last non-empty line, which is where prompts and verdicts are. */
function lastLine(output) {
  const lines = output.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  return lines.length > 0 ? lines[lines.length - 1] : null;
}

function reportsPaired(output) {
  return PAIRED_MARKERS.some((marker) => output.includes(marker));
}

/** The most recent QR block the wizard printed, as its raw glyph lines. */
function latestQr(output) {
  const marker = output.lastIndexOf(QR_MARKER);
  if (marker === -1) return null;
  const lines = output.slice(marker).split("\n");
  const block = [];
  for (const line of lines) {
    const bare = line.replace(/\r/g, "");
    if (bare.length >= 30 && [...bare].every((ch) => "█▀▄ ".includes(ch))) block.push(bare);
  }
  return block.length > 0 ? block.join("\n") : null;
}

function snapshot() {
  if (session === null) {
    return { state: "idle", qr: null, message: null, running: false };
  }
  const { output, child } = session;
  const running = child.exitCode === null && !child.killed;
  if (reportsPaired(output)) return { state: "paired", qr: null, message: lastLine(output), running };
  const qr = latestQr(output);
  if (qr !== null && running) return { state: "awaiting_scan", qr, message: "Scan the QR", running };
  if (output.includes("✗") || !running) {
    return { state: "failed", qr: null, message: lastLine(output) ?? "the pairing command did not finish", running };
  }
  return { state: "starting", qr: null, message: lastLine(output), running };
}

function startPairing() {
  if (session !== null && session.child.exitCode === null) return snapshot();

  // `script` supplies the PTY the wizard demands; without it the CLI exits
  // immediately rather than printing a code.
  const child = spawn("script", ["-qec", "hermes whatsapp", "/dev/null"], {
    env: { ...process.env, HOME: HERMES_HOME, TERM: "xterm-256color" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const state = { child, output: "", answered: 0 };
  session = state;

  const onData = (chunk) => {
    state.output += chunk.toString();
    const plain = state.output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
    // Answers belong to questions, and questions arrive split across chunks —
    // counting the prompts already seen is what keeps each answer with its own
    // question. The re-pair question is answered `y`: reaching it means the caller
    // asked to link, and a fresh code only exists once the old session is cleared.
    const questions = plain.split("[y/N]");
    questions.pop();
    while (state.answered < questions.length && state.answered < MAX_ANSWERS) {
      child.stdin.write(`${questions[state.answered].includes(RE_PAIR_PROMPT) ? "y" : ""}\n`);
      state.answered += 1;
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  return snapshot();
}

/** What Hermes says about the account, so a caller need not read its files. */
function gatewayStatus() {
  try {
    const parsed = JSON.parse(readFileSync(GATEWAY_STATE, "utf8"));
    return {
      gateway: parsed.gateway_state ?? "unknown",
      whatsapp: parsed.platforms?.whatsapp?.state ?? "unknown",
      updatedAt: parsed.platforms?.whatsapp?.updated_at ?? null,
    };
  } catch {
    return { gateway: "unknown", whatsapp: "unknown", updatedAt: null };
  }
}

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

createServer((req, res) => {
  if (req.method === "POST" && req.url === "/pair") return json(res, 200, startPairing());
  if (req.method === "GET" && req.url === "/pair") return json(res, 200, snapshot());
  if (req.method === "GET" && req.url === "/status") return json(res, 200, gatewayStatus());
  if (req.method === "GET" && req.url === "/health") return json(res, 200, { ok: true });
  return json(res, 404, { error: "not found" });
}).listen(PORT, "0.0.0.0", () => {
  console.log(`[butler-pairing] listening on ${PORT}`);
});
