import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import { generateText } from "ai";
import { createCompatibleProvider, type ProviderConfig } from "./provider";

/**
 * A provider stub that answers a non-streaming completion, capturing the body it
 * was sent. `/chat/completions` is the only route either caller uses.
 */
function captureServer(onBody: (body: Record<string, unknown>) => void): Promise<{ server: Server; url: string }> {
  const { promise, resolve } = Promise.withResolvers<{ server: Server; url: string }>();
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      onBody(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          created: 1,
          model: String(body.model),
          choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    resolve({ server, url: `http://127.0.0.1:${port}/v1` });
  });
  return promise;
}

let running: Server | null = null;

afterEach(() => {
  running?.close();
  running = null;
});

const config = (url: string): ProviderConfig => ({ baseURL: url, apiKey: "test-key", model: "test-model" });

describe("compatible provider request body", () => {
  test("pins stream:false, because this gateway streams when the field is absent", async () => {
    const bodies: Record<string, unknown>[] = [];
    const { server, url } = await captureServer((body) => bodies.push(body));
    running = server;

    const provider = createCompatibleProvider(config(url));
    const { text } = await generateText({ model: provider("test-model"), prompt: "hi" });

    expect(text).toBe("hi");
    // Without this the gateway answers `text/event-stream`, which the SDK's
    // non-streaming reader rejects as an invalid JSON response.
    expect(bodies[0]?.stream).toBe(false);
  });

  test("leaves a caller that asked to stream alone", async () => {
    const bodies: Record<string, unknown>[] = [];
    const { server, url } = await captureServer((body) => bodies.push(body));
    running = server;

    const provider = createCompatibleProvider(config(url));
    // doStream passes `stream: true`; forcing it false here would break the
    // streaming path the provider supports even though this app does not use it.
    const model = provider("test-model");
    try {
      await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
    } catch {
      // The stub answers a plain JSON body, which a stream reader may reject;
      // the request it sent is what this test is about.
    }

    expect(bodies[0]?.stream).toBe(true);
  });
});
