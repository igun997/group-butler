import { afterEach, describe, expect, test, vi } from "vitest";
import { REPLY_OUTPUT_RESERVE_TOKENS } from "../memory/recall";

const generateText = vi.hoisted(() =>
  vi.fn<
    (input: {
      instructions: string;
      prompt?: string;
      messages?: unknown[];
      maxOutputTokens: number;
      tools?: Record<string, unknown>;
      stopWhen?: unknown;
      prepareStep?: (options: { messages: unknown[] }) => { messages?: unknown[] };
    }) => Promise<{
      text: string;
      finishReason: string;
      responseMessages: unknown[];
      usage: { inputTokens: number; outputTokens: number; totalTokens: number };
    }>
  >(async () => ({
    text: "The deployment is green.",
    finishReason: "stop",
    responseMessages: [],
    usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
  })),
);
const stepCountIs = vi.hoisted(() => vi.fn((count: number) => ({ kind: "step-count", count })));
vi.mock("ai", () => ({ generateText, stepCountIs }));
vi.mock("@ai-sdk/openai-compatible", () => ({ createOpenAICompatible: () => (model: string) => ({ model }) }));

import { REPLY_MAX_TOOL_STEPS, generateGroupReply } from "./generate";

const baseEnv = () => {
  vi.stubEnv("AI_BASE_URL", "http://127.0.0.1:1/v1");
  vi.stubEnv("AI_API_KEY", "test-key");
  vi.stubEnv("AI_MODEL", "local-model");
};

/**
 * The real SDK error, not a stand-in: the gateway answers `200` with an error
 * envelope and no `choices`, and this is the object the SDK raises for that
 * body. Building it from the SDK itself is what proves the classifier keys on
 * the marker the SDK actually sets rather than on a string this test chose.
 */
const protocolFailure = async () => {
  const { TypeValidationError } = await vi.importActual<typeof import("ai")>("ai");
  return new TypeValidationError({
    value: { error: { message: "internal error" }, object: "chat.completion", created: 1789466004 },
    cause: new Error("Invalid input: expected array, received undefined"),
  });
};

/**
 * One model answer as the SDK returns it. Every stub goes through this, so a
 * field added to the result is added in one place rather than in each test that
 * happens to return a value.
 */
const answer = (
  text: string,
  usage = { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
  finishReason = "stop",
  responseMessages: unknown[] = [],
) => ({ text, finishReason, responseMessages, usage });

describe("group reply model call", () => {
  afterEach(() => {
    generateText.mockClear();
    stepCountIs.mockClear();
    vi.unstubAllEnvs();
  });

  test("calls the configured model with the assembled prompt and the reserved output cap", async () => {
    baseEnv();

    const result = await generateGroupReply({ system: "SYSTEM", prompt: "PROMPT" });

    expect(REPLY_OUTPUT_RESERVE_TOKENS).toBe(16_000);
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(generateText.mock.calls[0]?.[0]).toMatchObject({
      instructions: "SYSTEM",
      prompt: "PROMPT",
      maxOutputTokens: 16_000,
    });
    expect(result).toEqual({ kind: "ok", reply: { text: "The deployment is green.", model: "local-model", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } } });
  });

  // Without media tools the provider is asked exactly once; `stopWhen` left
  // undefined keeps the SDK's single-step default.
  test("asks the model once and sets no stop condition when there are no tools", async () => {
    baseEnv();

    await generateGroupReply({ system: "SYSTEM", prompt: "PROMPT" });

    expect(generateText.mock.calls[0]?.[0]?.tools).toBeUndefined();
    expect(generateText.mock.calls[0]?.[0]?.stopWhen).toBeUndefined();
    expect(stepCountIs).not.toHaveBeenCalled();
  });

  // A tool-calling reply gets one generation to call a tool and one follow-up
  // generation to answer from its result.
  test("passes the media tools and the step ceiling through", async () => {
    baseEnv();
    const tools = { media_read_csv: { description: "csv" } } as unknown as Parameters<typeof generateGroupReply>[0]["tools"];

    await generateGroupReply({ system: "SYSTEM", prompt: "PROMPT", tools });

    expect(generateText.mock.calls[0]?.[0]?.tools).toBe(tools);
    // Three steps: a direct-chat question about a group needs one call to find
    // the group and one to read it before it can be answered, and at two the
    // deployment sent the half-finished turn instead.
    expect(REPLY_MAX_TOOL_STEPS).toBe(3);
    expect(stepCountIs).toHaveBeenCalledWith(3);
    expect(generateText.mock.calls[0]?.[0]?.stopWhen).toEqual({ kind: "step-count", count: 3 });
  });

  /**
   * The failure this exists for, live in an owner's chat: with a two-step
   * ceiling the model spent its steps finding the group and reading it, and the
   * turn ended on a tool call — so what it had written, `Cuma satu grup
   * dimonitor: "Test Grrup". Cek admin:`, was sent as if it were the answer.
   * The turn is closed instead, with the tools removed so the only thing it can
   * produce is a sentence.
   */
  test("closes a turn the step ceiling cut short, and answers with the tools removed", async () => {
    baseEnv();
    generateText.mockResolvedValueOnce({
      text: 'Cuma satu grup dimonitor: "Test Grrup". Cek admin:',
      finishReason: "tool-calls",
      responseMessages: [{ role: "assistant", content: "Cek admin:" }],
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    });
    generateText.mockResolvedValueOnce({
      text: "Admin grup ini: Indra.",
      finishReason: "stop",
      responseMessages: [],
      usage: { inputTokens: 20, outputTokens: 6, totalTokens: 26 },
    });

    const result = await generateGroupReply({ system: "SYSTEM", prompt: "PROMPT", tools: { group_info: { description: "info" } } as never });

    expect(generateText).toHaveBeenCalledTimes(2);
    const closing = generateText.mock.calls[1]?.[0];
    // No tools in the closing call: the work is done, the answer is what is missing.
    expect(closing?.tools).toBeUndefined();
    expect(closing?.prompt).toBeUndefined();
    expect(closing?.messages).toEqual([
      { role: "assistant", content: "Cek admin:" },
      { role: "user", content: expect.stringContaining("Answer the owner now") },
    ]);
    // The fragment is gone; the answer is what the owner gets, and both calls are counted.
    expect(result).toEqual({
      kind: "ok",
      reply: { text: "Admin grup ini: Indra.", model: "local-model", usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 } },
    });
  });

  test("does not close a turn the model finished itself", async () => {
    baseEnv();
    const tools = { group_info: { description: "info" } } as never;

    await generateGroupReply({ system: "SYSTEM", prompt: "PROMPT", tools });

    expect(generateText).toHaveBeenCalledTimes(1);
  });

  // A response the endpoint failed to shape says nothing about the model, so the
  // question is asked again. Nothing else re-asks: the worker logs a refused
  // callback and moves on, so without this the owner simply gets no answer.
  test("asks again when the endpoint answers with a body its own schema rejects", async () => {
    baseEnv();
    generateText.mockRejectedValueOnce(await protocolFailure());
    generateText.mockResolvedValueOnce(answer("Sudah saya cek.", { inputTokens: 4, outputTokens: 5, totalTokens: 9 }));

    const result = await generateGroupReply({ system: "SYSTEM", prompt: "PROMPT" });

    expect(generateText).toHaveBeenCalledTimes(2);
    // A call that threw reported no figures, and none are invented for it: the
    // answered attempt's own are what the console records.
    expect(result).toEqual({ kind: "ok", reply: { text: "Sudah saya cek.", model: "local-model", usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 } } });
  });

  test("reports both attempts' tokens when the first answered but was refused", async () => {
    baseEnv();
    generateText.mockResolvedValueOnce(answer("<\uFF5CDSML\uFF5Cfunction_calls", { inputTokens: 1, outputTokens: 2, totalTokens: 3 }));
    generateText.mockResolvedValueOnce(answer("Sudah saya cek.", { inputTokens: 4, outputTokens: 5, totalTokens: 9 }));

    const result = await generateGroupReply({ system: "SYSTEM", prompt: "PROMPT" });

    // Both calls answered, so both were paid for and both are counted.
    expect(result).toEqual({ kind: "ok", reply: { text: "Sudah saya cek.", model: "local-model", usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 } } });
  });

  test("gives up after one repeat when the endpoint keeps failing", async () => {
    baseEnv();
    const failure = await protocolFailure();
    generateText.mockRejectedValueOnce(failure);
    generateText.mockRejectedValueOnce(await protocolFailure());

    await expect(generateGroupReply({ system: "SYSTEM", prompt: "PROMPT" })).rejects.toBeTruthy();
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  // An aborted lease or an unreachable host is not a flaky answer: asking again
  // would burn the run's budget for a failure a second call cannot fix.
  test("does not ask again when the failure is not the endpoint's body", async () => {
    baseEnv();
    generateText.mockRejectedValueOnce(new Error("fetch failed"));

    await expect(generateGroupReply({ system: "SYSTEM", prompt: "PROMPT" })).rejects.toThrow("fetch failed");
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  // A tool call that arrived as text is the endpoint's fault too, and the second
  // answer is usually a real one — this is the leak that reached the owner.
  test("asks again when the answer is a tool call written as text", async () => {
    baseEnv();
    generateText.mockResolvedValueOnce({
      text: "<\uFF5CDSML\uFF5Cfunction_calls",
      finishReason: "stop",
      responseMessages: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    generateText.mockResolvedValueOnce(answer("Grup yang dipantau: Test Grrup.", { inputTokens: 2, outputTokens: 3, totalTokens: 5 }));

    const result = await generateGroupReply({ system: "SYSTEM", prompt: "PROMPT" });

    expect(result).toEqual({ kind: "ok", reply: { text: "Grup yang dipantau: Test Grrup.", model: "local-model", usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } } });
  });

  /**
   * Where an image has to end up. Measured against this deployment's gateway: the
   * same image, asked to be read, came back as "HI INDRA 420" as a user-message
   * part and as an empty string inside a tool result — OpenAI-shaped APIs do not
   * carry images in a `role: "tool"` message, and this provider does not convert
   * them. So the step after a tool call gets its images moved, in one copy.
   */
  test("moves a tool result's image into a user message before the next step", async () => {
    baseEnv();
    generateText.mockResolvedValue(answer("done", { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, "stop"));
    const toolMessages: unknown[] = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "media_get_image", input: {} }] },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "media_get_image",
            output: {
              type: "content",
              value: [
                { type: "file", data: { type: "data", data: "aGk=" }, mediaType: "image/png" },
                { type: "text", text: "{\"ok\":true}" },
              ],
            },
          },
        ],
      },
    ];

    await generateGroupReply({ system: "SYSTEM", prompt: "PROMPT", tools: { media_get_image: { description: "img" } } as never });

    const prepareStep = generateText.mock.calls[0]?.[0]?.prepareStep as
      | ((options: { messages: unknown[] }) => { messages?: unknown[] })
      | undefined;
    expect(prepareStep).toBeTypeOf("function");
    const rewritten = prepareStep?.({ messages: toolMessages })?.messages ?? [];

    // The image is a user-message part…
    const last = rewritten.at(-1) as { role: string; content: { type: string }[] };
    expect(last.role).toBe("user");
    expect(last.content.map((part) => part.type)).toEqual(["file", "text"]);
    // …and it is no longer in the tool result, which keeps only the text: no
    // provider is sent two copies of the same bytes.
    const result = rewritten[1] as { content: { output: { value: { type: string; text?: string }[] } }[] };
    expect(result.content[0]?.output.value).toEqual([{ type: "text", text: '{"ok":true}' }]);
  });

  test("leaves the messages alone when no tool returned an image", async () => {
    baseEnv();
    generateText.mockResolvedValue(answer("done", { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, "stop"));

    await generateGroupReply({ system: "SYSTEM", prompt: "PROMPT", tools: { media_read_csv: { description: "csv" } } as never });

    const prepareStep = generateText.mock.calls[0]?.[0]?.prepareStep as
      | ((options: { messages: unknown[] }) => { messages?: unknown[] })
      | undefined;
    const messages = [{ role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "media_read_csv", output: { type: "text", value: "a,b" } }] }];

    expect(prepareStep?.({ messages })?.messages).toBeUndefined();
  });

  test("refuses rather than sends when the markup survives the second answer", async () => {
    baseEnv();
    generateText.mockResolvedValue({
      text: "<\uFF5CDSML\uFF5Cfunction_calls",
      finishReason: "stop",
      responseMessages: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });

    const result = await generateGroupReply({ system: "SYSTEM", prompt: "PROMPT" });

    // Two attempts, then no text at all: human review, never garbage on WhatsApp.
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ kind: "rejected", code: "model_markup" });
  });

  // A link the group never supplied is the model's own doing, so it is refused
  // once and stands — asking again would be asking the model to try harder.
  test("does not ask again for a refusal that is the model's own", async () => {
    baseEnv();
    generateText.mockResolvedValue({
      text: "join https://wa.me/628999999",
      finishReason: "stop",
      responseMessages: [],
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    });

    const result = await generateGroupReply({ system: "SYSTEM", prompt: "PROMPT" });

    expect(generateText).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ kind: "rejected", code: "unsafe_link" });
  });

  // The gate compares the answer's links against the scoped evidence: a link the
  // group supplied passes, and one the model invented is refused rather than
  // thrown, so the caller can route it to human review.
  test("sanitizes against the scoped source links and reports a refusal", async () => {
    baseEnv();
    generateText.mockResolvedValueOnce(answer("see https://wa.me/628120000", { inputTokens: 1, outputTokens: 2, totalTokens: 3 }));

    const allowed = await generateGroupReply({
      system: "SYSTEM",
      prompt: "PROMPT",
      sourceLinks: new Set(["https://wa.me/628120000"]),
    });
    expect(allowed).toEqual({ kind: "ok", reply: { text: "see https://wa.me/628120000", model: "local-model", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } } });

    generateText.mockResolvedValueOnce(answer("see https://wa.me/628120000", { inputTokens: 1, outputTokens: 2, totalTokens: 3 }));
    const refused = await generateGroupReply({ system: "SYSTEM", prompt: "PROMPT", sourceLinks: new Set() });
    expect(refused).toEqual({ kind: "rejected", code: "unsafe_link" });
  });
});
