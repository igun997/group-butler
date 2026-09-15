import { generateText, stepCountIs, type FilePart, type ModelMessage, type ToolSet } from "ai";
import { NO_TOKEN_USAGE, type TokenUsage } from "../repos/ai-calls";
import { createCompatibleProvider, isProviderProtocolFailure } from "../ai/provider";
import { sanitizeWhatsAppOutput, type WhatsAppOutputCode } from "../ai/sanitize-whatsapp";
import { REPLY_OUTPUT_RESERVE_TOKENS } from "../memory/recall";

/**
 * The configured OpenAI-compatible endpoint (§5.1 `appSettings.ai`, `AI_*` env).
 * Resolved in one place because two callers need it: the generation itself, and
 * the `aiCalls` row that records a call which failed before it reached a model
 * and so has no result to report a model from.
 */
export interface ReplyModelConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  /** Names the token counter the assembler must use, if the deployment sets one. */
  tokenizer?: string;
}

export function replyModelConfig(): ReplyModelConfig | null {
  const baseURL = process.env.AI_BASE_URL;
  const apiKey = process.env.AI_API_KEY;
  const model = process.env.AI_MODEL;
  if (!baseURL || !apiKey || !model) return null;
  return { baseURL, apiKey, model, tokenizer: process.env.AI_TOKENIZER };
}

/**
 * One model call's result: the reply the caller sends, the identity the console
 * records, and the tokens the provider reported — `null` per figure when it
 * reported nothing, which is not a zero (§10).
 */
export interface GeneratedReply {
  text: string;
  model: string;
  usage: TokenUsage;
}

/**
 * One tool-calling generation followed by one final answer. The prompt
 * assembler reserves both the first generation and the follow-up's tool data
 * inside the 180k ceiling, so no further turns are allowed.
 */
export const REPLY_MAX_TOOL_STEPS = 3;

/**
 * What the model is told when the step ceiling cut its turn short — it wanted
 * another tool call and never answered.
 *
 * Without this the deployment sent the fragment: a real reply that arrived in an
 * owner's chat was `Cuma satu grup dimonitor: "Test Grrup". Cek admin:`, which is
 * the model announcing a lookup it never got to make. The tools have already
 * run, so the work that is missing is one sentence of summary, not another
 * search — and it is asked for with the tools removed, so the only thing this
 * generation can produce is an answer.
 */
const ANSWER_NOW =
  "Answer the owner now, in one short message, using only what the tools already returned. Do not call any tool, and do not describe what you would look up next.";

/**
 * One question asked twice at most, because both observed boundary faults are
 * transient and nothing else re-asks.
 *
 * The worker never repeats a reply callback that the BFF refused — it logs the
 * status and moves on — so a failed run is a message the owner asked that never
 * gets an answer. A second attempt is therefore the only recovery there is, and
 * it is bounded to one: this is a flaky gateway, not a retry loop.
 */
const GENERATION_ATTEMPTS = 2;

/**
 * A retry must fit the caller's budget. The worker abandons a callback after
 * 120s, so a second attempt started once the first has already burned most of
 * that window would be abandoned mid-flight — no answer, and no run to reclaim
 * it. Past this, the first answer stands, whatever it was.
 */
const RETRY_BUDGET_MS = 45_000;

/**
 * The model's answer, or a deterministic refusal of it. A sanitizer rejection is
 * an expected outcome with its own path (no automatic send; a human-review
 * queue), so it is returned rather than thrown: only a provider or transport
 * failure is exceptional.
 */
export type ReplyGenerationResult =
  | { kind: "ok"; reply: GeneratedReply }
  | { kind: "rejected"; code: WhatsAppOutputCode };

export async function generateGroupReply(input: {
  system: string;
  prompt: string;
  /** The scoped media MCP tools, already bound to this reply job's identity. */
  tools?: ToolSet;
  /**
   * Every absolute URL that literally occurred in the scoped evidence. A link
   * outside this set — a `wa.me` invite, say — is refused by the sanitizer.
   */
  sourceLinks?: ReadonlySet<string>;
  abortSignal?: AbortSignal;
}): Promise<ReplyGenerationResult> {
  const config = replyModelConfig();
  if (!config) throw new Error("AI_BASE_URL, AI_API_KEY, and AI_MODEL are required for automatic replies");

  const provider = createCompatibleProvider(config);
  // Both attempts' tokens are reported, not just the one that answered: the
  // console's figures are what the deployment spent, and a retry spends twice.
  let spent: TokenUsage = NO_TOKEN_USAGE;
  let refusal: WhatsAppOutputCode | null = null;

  for (let attempt = 1; attempt <= GENERATION_ATTEMPTS; attempt += 1) {
    const startedAt = Date.now();
    try {
      const first = await generateText({
        model: provider(config.model),
        instructions: input.system,
        prompt: input.prompt,
        tools: input.tools,
        // Without tools the provider is asked once, as before. With them the model
        // may take a bounded number of turns so a tool call can be followed by an
        // answer; the tool set still caps the bytes it can receive in total.
        stopWhen: input.tools ? stepCountIs(REPLY_MAX_TOOL_STEPS) : undefined,
        // The assembler reserves this output inside the 180k ceiling; the provider
        // must be told the same bound so it cannot answer past it.
        maxOutputTokens: REPLY_OUTPUT_RESERVE_TOKENS,
        // A lease heartbeat that finds the run reclaimed aborts the in-flight call.
        abortSignal: input.abortSignal,
        // An image a tool returned is moved out of the tool result and into a user
        // message before the next step, because that is the only place a vision
        // model will see it: measured against this deployment's gateway, the same
        // image read "HI INDRA 420" as a user-message part and came back as an
        // empty string inside a tool result. OpenAI-shaped APIs do not carry images
        // in a `role: "tool"` message, and this provider does not convert them.
        prepareStep: input.tools
          ? ({ messages }) => {
              const lifted = liftToolResultImages(messages);
              return lifted === null ? {} : { messages: lifted };
            }
          : undefined,
      });
      let text = first.text;
      spent = addUsage(spent, {
        inputTokens: first.usage.inputTokens ?? null,
        outputTokens: first.usage.outputTokens ?? null,
        totalTokens: first.usage.totalTokens ?? null,
      });
      // `tool-calls` as the final reason means the loop ran out of steps while
      // the model was still working: its last turn asked for a tool instead of
      // answering. What it wrote alongside that call is a fragment of unfinished
      // thinking, so the turn is closed with one tool-less generation rather than
      // sent as it stands.
      if (input.tools && first.finishReason === "tool-calls") {
        const closing = await generateText({
          model: provider(config.model),
          instructions: input.system,
          messages: [...first.responseMessages, { role: "user", content: ANSWER_NOW }],
          maxOutputTokens: REPLY_OUTPUT_RESERVE_TOKENS,
          abortSignal: input.abortSignal,
        });
        text = closing.text;
        spent = addUsage(spent, {
          inputTokens: closing.usage.inputTokens ?? null,
          outputTokens: closing.usage.outputTokens ?? null,
          totalTokens: closing.usage.totalTokens ?? null,
        });
      }
      const sanitized = sanitizeWhatsAppOutput(text, input.sourceLinks);
      if (sanitized.ok) return { kind: "ok", reply: { text: sanitized.text, model: config.model, usage: spent } };
      refusal = sanitized.code;
      // A tool call that arrived as text is worth asking again — the endpoint
      // failed to deliver the call it was sent, and the second answer is usually
      // a proper one. Every other refusal is the model's own doing and stands.
      const retryable = sanitized.code === "model_markup";
      if (!retryable || attempt === GENERATION_ATTEMPTS || Date.now() - startedAt > RETRY_BUDGET_MS) {
        return { kind: "rejected", code: sanitized.code };
      }
    } catch (error) {
      // A response the endpoint could not shape is worth asking again; anything
      // else (a refused key, an aborted lease, an unreachable host) is not.
      if (attempt === GENERATION_ATTEMPTS || !isProviderProtocolFailure(error)) throw error;
    }
  }
  // The loop above returns on its last attempt, so this is unreachable; it exists
  // because the compiler cannot see that.
  return { kind: "rejected", code: refusal ?? "empty" };
}

/**
 * Tool-result images, moved to where a model can see them.
 *
 * Returns the messages to use for the next step, or `null` when there is nothing to
 * move — a reply that read no image keeps the messages the SDK built. The file parts
 * are removed from the tool result as they are taken, so an image is never sent
 * twice: a provider that does carry tool-result images sends the user message's copy,
 * and one that does not, sends the only copy there is.
 */
function liftToolResultImages(messages: readonly ModelMessage[]): ModelMessage[] | null {
  const images: FilePart[] = [];
  const rewritten = messages.map((message): ModelMessage => {
    if (message.role !== "tool") return message;
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== "tool-result" || part.output.type !== "content") return part;
        const files = part.output.value.filter((entry) => entry.type === "file");
        if (files.length === 0) return part;
        for (const file of files) images.push({ type: "file", data: file.data, mediaType: file.mediaType });
        return { ...part, output: { ...part.output, value: part.output.value.filter((entry) => entry.type !== "file") } };
      }),
    };
  });
  if (images.length === 0) return null;
  return [
    ...rewritten,
    {
      role: "user",
      content: [
        ...images,
        {
          type: "text" as const,
          text: "The image(s) the tool returned, sent as images: read them and answer from what they show.",
        },
      ],
    },
  ];
}

/**
 * Sum of what every attempt of one reply spent. `null` means "not reported", so
 * it contributes nothing rather than a zero; a reply whose attempts all reported
 * nothing stays unreported instead of reading as free.
 */
function addUsage(total: TokenUsage, next: TokenUsage): TokenUsage {
  const sum = (a: number | null, b: number | null): number | null => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));
  return {
    inputTokens: sum(total.inputTokens, next.inputTokens),
    outputTokens: sum(total.outputTokens, next.outputTokens),
    totalTokens: sum(total.totalTokens, next.totalTokens),
  };
}
