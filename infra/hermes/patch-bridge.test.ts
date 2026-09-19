import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The two files `infra/hermes/patch-bridge.mjs` splices into Hermes's WhatsApp
 * bridge. Once patched they run inside a third-party process with no test
 * surface of its own, so the only place they can be checked is here — against
 * stubs standing in for `app`, `sock` and `fetch`.
 *
 * These are behavioural tests of the real source: the snippets are read from
 * disk and evaluated, so a bug in the shipped text fails the test. That matters
 * because a mistake in either one is invisible at patch time — the bridge still
 * starts, still connects, and simply does the wrong thing.
 */

const DIR = join(import.meta.dir);
const FORWARDER_SOURCE = readFileSync(join(DIR, "bridge-archive-forwarder.js"), "utf8");
const GROUP_ACTIONS_SOURCE = readFileSync(join(DIR, "bridge-group-actions.js"), "utf8");

/** Evaluates the forwarder snippet and hands back `archiveForward` plus the calls `fetch` saw. */
function loadForwarder(env: Record<string, string>): {
  forward: (payload: unknown) => Promise<void>;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return new Response("", { status: 202 });
  };
  const build = new Function(
    "process",
    "fetch",
    "setTimeout",
    "clearTimeout",
    "AbortController",
    `${FORWARDER_SOURCE}\nreturn archiveForward;`,
  );
  const forward = build(
    { env },
    fakeFetch,
    setTimeout,
    clearTimeout,
    AbortController,
  ) as (payload: unknown) => Promise<void>;
  return { forward, calls };
}

/** A registered-handler fake for the `app` object the snippet closes over. */
type Handler = (req: { params?: Record<string, string>; body?: unknown }, res: FakeResponse) => Promise<void> | void;
interface FakeResponse {
  statusCode: number;
  body: unknown;
  status(code: number): FakeResponse;
  json(payload: unknown): void;
}

function fakeResponse(): FakeResponse {
  const res: FakeResponse = {
    statusCode: 200,
    body: undefined,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
    },
  };
  return res;
}

function loadGroupActions(sock: unknown): Map<string, Handler> {
  const routes = new Map<string, Handler>();
  const app = {
    get: (path: string, handler: Handler) => routes.set(`GET ${path}`, handler),
    post: (path: string, handler: Handler) => routes.set(`POST ${path}`, handler),
  };
  const build = new Function("app", "sock", "Buffer", `${GROUP_ACTIONS_SOURCE}\nreturn undefined;`);
  build(app, sock, Buffer);
  return routes;
}

describe("archive forwarder", () => {
  test("posts the payload to the configured URL with the bearer token", async () => {
    const { forward, calls } = loadForwarder({
      WHATSAPP_ARCHIVE_URL: "http://archive.test/ingest",
      WHATSAPP_ARCHIVE_SECRET: "s3cret",
    });
    await forward({ messageId: "M1", body: "halo" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://archive.test/ingest");
    expect(calls[0]?.init.method).toBe("POST");
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer s3cret");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ messageId: "M1", body: "halo" });
  });

  test("does nothing when no URL is configured", async () => {
    // An unpatched-in-anger deployment must behave exactly as the stock bridge:
    // no URL means no traffic, not a request to an empty address.
    const { forward, calls } = loadForwarder({});
    await forward({ messageId: "M1" });
    expect(calls).toHaveLength(0);
  });
});

describe("group action endpoints", () => {
  test("a members call reports per-JID outcomes and only succeeds when all were confirmed", async () => {
    const sock = {
      groupParticipantsUpdate: async () => [
        { jid: "6281@s.whatsapp.net", status: "200" },
        { jid: "6282@s.whatsapp.net", status: "403" },
      ],
    };
    const routes = loadGroupActions(sock);
    const res = fakeResponse();
    await routes.get("POST /group/participants")?.(
      { body: { jid: "g@g.us", membership: "add", participants: ["6281@s.whatsapp.net", "6282@s.whatsapp.net"] } },
      res,
    );

    // Partial success is the whole point: one member WhatsApp refused must not
    // read as a failed call, and must not read as a success either.
    expect(res.body).toEqual({
      ok: false,
      results: [
        { jid: "6281@s.whatsapp.net", ok: true, error: "" },
        { jid: "6282@s.whatsapp.net", ok: false, error: "403" },
      ],
      failed: ["6282@s.whatsapp.net"],
    });
  });

  test("a settings call applies only the switch it was given", async () => {
    const applied: string[] = [];
    const sock = {
      groupSettingUpdate: async (_jid: string, value: string) => {
        applied.push(value);
      },
    };
    const routes = loadGroupActions(sock);
    const res = fakeResponse();
    await routes.get("POST /group/settings")?.({ body: { jid: "g@g.us", locked: true } }, res);

    // A locked change must not silently also announce-lock the group.
    expect(applied).toEqual(["locked"]);
    expect(res.body).toEqual({ ok: true });
  });

  test("refuses a settings call that names no switch", async () => {
    const routes = loadGroupActions({});
    const res = fakeResponse();
    await routes.get("POST /group/settings")?.({ body: { jid: "g@g.us" } }, res);
    expect(res.statusCode).toBe(400);
  });

  test("answers 503 while whatsapp is not connected", async () => {
    const routes = loadGroupActions(null);
    const res = fakeResponse();
    await routes.get("GET /group/:jid")?.({ params: { jid: "g@g.us" } }, res);
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ ok: false, error: 'whatsapp is not connected' });
  });

  test("a group read reports only what the bridge can know", async () => {
    const sock = {
      groupMetadata: async () => ({
        subject: "Buttle Group test",
        announce: false,
        restrict: true,
        participants: [{ id: "6281@s.whatsapp.net", admin: "admin" }],
      }),
    };
    const routes = loadGroupActions(sock);
    const res = fakeResponse();
    await routes.get("GET /group/:jid")?.({ params: { jid: "g@g.us" } }, res);
    expect(res.body).toEqual({
      ok: true,
      subject: "Buttle Group test",
      announce: false,
      locked: true,
      participants: [{ jid: "6281@s.whatsapp.net", admin: "admin" }],
    });
  });
});
