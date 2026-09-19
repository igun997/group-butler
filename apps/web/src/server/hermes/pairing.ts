import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { qrDataUrlFromTerminal } from "./qr";

/**
 * WhatsApp pairing, driven from the console.
 *
 * Hermes pairs over a terminal wizard — `hermes whatsapp` refuses to run without
 * a TTY and prints its QR as text — so the BFF runs it through a pseudo-terminal
 * and turns the printed blocks back into the PNG data URL the pairing panel
 * renders. `script` supplies that TTY, which keeps this dependency-free: no
 * native pty module to build.
 *
 * Nothing about a pairing lives in this process's memory. Next compiles each
 * route into its own bundle, and a module-level variable is not even shared
 * between `/pair` and `/check` — the start route would own the wizard while the
 * poll route reported a console that had never asked for anything. The wizard's
 * own output file is the state, so whoever reads it sees the same pairing.
 */

/** The wizard's own words. They are the only progress signal it gives. */
const QR_MARKER = "Scan this QR code";
/**
 * The wizard has two success endings and uses them for different paths: a scan
 * that establishes a session prints "paired successfully", while a run that finds
 * the session already in place prints "is configured and paired". Matching only
 * one turns a successful pairing into a reported failure — which is exactly what
 * happened the first time a real scan ran.
 */
const PAIRED_MARKERS = ["is configured and paired", "paired successfully"];
const RE_PAIR_PROMPT = "Re-pair?";
const FAILURE_MARKER = "✗";

/** Whether the wizard's output reports a completed pairing. */
function reportsPaired(output: string): boolean {
  return PAIRED_MARKERS.some((marker) => output.includes(marker));
}

/**
 * The command that runs the wizard. It is configurable because the container
 * name and the Hermes binary are deployment facts, and because a deployment that
 * runs Hermes on the host does not need `docker exec` at all.
 */
const COMMAND_ENV = "HERMES_PAIR_COMMAND";
const DEFAULT_COMMAND = "docker exec -it hermes-local hermes whatsapp";

/** Where the wizard's output and its pid are kept, readable by every route. */
const LOG_ENV = "HERMES_PAIR_LOG";
const LOG_PATH = process.env[LOG_ENV] ?? join(tmpdir(), "butler-hermes-pairing.log");
const PID_PATH = `${LOG_PATH}.pid`;

/**
 * How the gateway is told to pick up a freshly paired session. Pairing writes
 * credentials to disk, but a gateway already running is holding the old session
 * in memory — including the "not paired" state it started with — so without this
 * the console would show a successful scan while the agent stayed deaf.
 */
const RESTART_ENV = "HERMES_RESTART_COMMAND";
const DEFAULT_RESTART = "docker exec hermes-local hermes gateway restart";

/** How many prompts one run may answer, so a loop of prompts cannot hang forever. */
const MAX_ANSWERS = 8;

export type HermesPairingState = "starting" | "awaiting_scan" | "paired" | "failed";

export interface HermesPairingStatus {
  state: HermesPairingState;
  /** A `data:image/png;base64,…` QR, present only while a scan is awaited. */
  qr: string | null;
  /** The last thing the wizard said, for the operator to read when it stops. */
  message: string | null;
  startedAt: string;
}

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;

/** The wizard's pid, or `null` when none is recorded. */
function recordedPid(): number | null {
  if (!existsSync(PID_PATH)) return null;
  const pid = Number(readFileSync(PID_PATH, "utf8").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** Whether a recorded wizard is still alive. */
function isRunning(): boolean {
  const pid = recordedPid();
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The text the last non-empty line, which is where prompts and verdicts are. */
function lastLine(output: string): string | null {
  const lines = output.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  return lines.length > 0 ? (lines[lines.length - 1] ?? null) : null;
}

/**
 * The answers to give, in the order the wizard asks.
 *
 * Prompts arrive chunked, so answering "the last thing in this chunk" races the
 * next chunk and can answer the wrong question with the wrong word — which for
 * the re-pair question means quietly *declining* to re-pair and leaving the
 * console showing a QR that never comes. Counting the prompts the output has
 * already contained makes each answer belong to one question regardless of how
 * the bytes were split.
 */
function answersFor(output: string): string[] {
  // Each marker ends one question, so the text between markers is that question.
  const questions = output.split("[y/N]");
  questions.pop();
  return questions.map((question) => (question.includes(RE_PAIR_PROMPT) ? "y" : ""));
}

/**
 * The QR, once the wizard has printed one. It is re-read whenever the output
 * grows because WhatsApp rotates the code every ~20 seconds and the newest one
 * is the only one that still scans.
 */
function readQr(output: string): string | null {
  const marker = output.lastIndexOf(QR_MARKER);
  if (marker === -1) return null;
  return qrDataUrlFromTerminal(output.slice(marker));
}

/**
 * What the recorded output means right now. A run that has stopped without
 * pairing has failed, whatever it last printed: an abandoned wizard is not a
 * pending one, and reporting it as "still waiting" would leave the console
 * spinning on a QR nothing is refreshing.
 */
function statusOf(output: string): HermesPairingStatus {
  const startedAt = existsSync(LOG_PATH)
    ? new Date(Math.floor(statMs(LOG_PATH))).toISOString()
    : new Date().toISOString();
  const message = lastLine(output);
  if (reportsPaired(output)) return { state: "paired", qr: null, message, startedAt };
  const qr = readQr(output);
  if (qr !== null && isRunning()) {
    return {
      state: "awaiting_scan",
      qr,
      message: "Open WhatsApp on your phone, then Settings → Linked Devices → Link a Device.",
      startedAt,
    };
  }
  if (output.includes(FAILURE_MARKER) || (!isRunning() && output !== "")) {
    return { state: "failed", qr: null, message: message ?? "The pairing command did not finish.", startedAt };
  }
  return { state: "starting", qr: null, message, startedAt };
}

function statMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return Date.now();
  }
}

/**
 * Starts one pairing and returns its first status. A wizard already running is
 * left alone and reported as it stands: re-running it would clear the session
 * that is mid-scan.
 */
export function startHermesPairing(command = process.env[COMMAND_ENV] ?? DEFAULT_COMMAND): HermesPairingStatus {
  if (isRunning()) return statusOf(readOutput());

  rmSync(LOG_PATH, { force: true });
  rmSync(PID_PATH, { force: true });
  const log = createWriteStream(LOG_PATH, { flags: "w" });
  const child: ChildProcess = spawn("script", ["-qec", command, "/dev/null"], { stdio: ["pipe", "pipe", "pipe"] });
  writeFileSync(PID_PATH, String(child.pid ?? ""));

  let answered = 0;
  let seen = "";
  let restarted = false;
  const onData = (data: Buffer): void => {
    const text = data.toString();
    log.write(text);
    seen += text.replace(ANSI, "").replace(/\r/g, "");
    // Answer every question the output has revealed and not yet been answered.
    // The re-pair question is answered `y`: reaching it at all means the operator
    // asked to link again, and a fresh code only exists once the wizard clears
    // the old session.
    const answers = answersFor(seen);
    while (answered < answers.length && answered < MAX_ANSWERS) {
      child.stdin?.write(`${answers[answered]}\n`);
      answered += 1;
    }
    // The credentials are on disk now; the running gateway still holds the old
    // session, so it is restarted exactly once to load them.
    if (!restarted && reportsPaired(seen)) {
      restarted = true;
      log.write("\n[archive] restarting the gateway to load the new session\n");
      spawn("sh", ["-c", process.env[RESTART_ENV] ?? DEFAULT_RESTART], { stdio: "ignore", detached: true })
        .on("error", () => {})
        .unref();
    }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.on("error", (error) => {
    log.write(`\n✗ ${error.message}\n`);
    log.end();
    rmSync(PID_PATH, { force: true });
  });
  child.on("exit", () => {
    log.end();
    rmSync(PID_PATH, { force: true });
  });

  return { state: "starting", qr: null, message: null, startedAt: new Date().toISOString() };
}

function readOutput(): string {
  try {
    return readFileSync(LOG_PATH, "utf8");
  } catch {
    return "";
  }
}

/** How long a finished pairing still speaks for an instance's status. */
const PAIRING_RELEVANCE_MS = 10 * 60 * 1000;

/**
 * Where Hermes's pairing service answers, when Hermes runs in its own container.
 *
 * The console cannot drive the wizard itself in that shape — it has neither the
 * Hermes CLI nor a PTY — so the work happens where it can and this calls it. With
 * no URL the local spawn below is used, which is what a host-run development
 * stack still does.
 */
const PAIR_URL_ENV = "HERMES_PAIR_URL";

/** One call to the pairing service, or `null` when it is not configured or unreachable. */
async function callService(pathname: string, method: "GET" | "POST"): Promise<HermesPairingStatus | null> {
  const base = process.env[PAIR_URL_ENV];
  if (!base) return null;
  try {
    const response = await fetch(`${base}${pathname}`, { method, signal: AbortSignal.timeout(15000) });
    if (!response.ok) return null;
    const body = (await response.json()) as { state?: string; qr?: string | null; message?: string | null };
    // "idle" is the service saying nothing is pairing, which is the same fact as
    // this side having no file to read.
    if (body.state === undefined || body.state === "idle") return null;
    return {
      state: body.state as HermesPairingState,
      // The service sends the glyphs the terminal printed; the conversion to an
      // image stays here, where it is already tested.
      qr: body.qr ? qrDataUrlFromTerminal(body.qr) : null,
      message: body.message ?? null,
      startedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/** Asks Hermes to pair, and reports what it is doing. */
export async function startHermesPairingRemote(): Promise<HermesPairingStatus | null> {
  return callService("/pair", "POST");
}

/** Presses the pairing state, however this deployment can reach it. */
export async function readHermesPairingAny(): Promise<HermesPairingStatus | null> {
  return (await callService("/pair", "GET")) ?? readHermesPairing();
}

/** This process's own pairing, when it runs the wizard itself. */
export function readHermesPairing(): HermesPairingStatus | null {
  if (!existsSync(LOG_PATH) && !isRunning()) return null;
  // A wizard that has stopped only speaks for the pairing it just did. Once its
  // output goes quiet the instance's own record is the truth: without this, one
  // failed attempt pins the console to "Error" for the life of the process, long
  // after the account was re-linked by hand.
  if (!isRunning() && Date.now() - statMs(LOG_PATH) > PAIRING_RELEVANCE_MS) return null;
  return statusOf(readOutput());
}

/**
 * Abandons a pairing in flight. The wizard is killed rather than asked to stop:
 * it holds the session lock for as long as it lives, and a scan that has not
 * happened yet has nothing to finish cleanly.
 */
export function stopHermesPairing(): void {
  const pid = recordedPid();
  if (pid !== null) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  rmSync(PID_PATH, { force: true });
  rmSync(LOG_PATH, { force: true });
}
