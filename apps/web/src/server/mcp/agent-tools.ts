import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { dynamicTool, jsonSchema, type ToolSet } from "ai";
import { clipScalars, sourceLinksOf } from "../ai/sanitize-whatsapp";
import { clipToTokens, REPLY_TOOL_RESULT_RESERVE_TOKENS, type TokenCounter } from "../memory/recall";
import { MEDIA_TOOL_LIMITS } from "./media-tools";

/**
 * Every text block of one tool result, joined; a media result is one JSON
 * document in one text block. The MCP result is external data whose content
 * union also carries images and embedded resources, so it is read structurally
 * rather than trusted to a type.
 */
function toolResultText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const candidate = block as { type?: unknown; text?: unknown };
    if (candidate.type === "text" && typeof candidate.text === "string") parts.push(candidate.text);
  }
  return parts.join("\n");
}

/** What this bridge returns from `execute`, and what `toModelOutput` reads back. */
interface BridgedToolResult {
  text: string;
  images: { data: string; mediaType: string }[];
}

/**
 * The bridge's own result, or the nearest honest reading of something else: the
 * tool API types an output as `unknown`, and a value that is not this shape is
 * text by definition.
 */
function bridgedResult(output: unknown): BridgedToolResult {
  const candidate = output as Partial<BridgedToolResult> | null;
  if (typeof candidate?.text === "string" && Array.isArray(candidate.images)) {
    return { text: candidate.text, images: candidate.images };
  }
  return { text: String(output), images: [] };
}

/**
 * One tool result, split into the text the model reads and the images it should
 * see. The image fields are ours — `dataUrl` from `media_get_image`, `imageDataUrl`
 * from a video frame — and each is replaced in the text by a note, so a reader
 * (and the model) still knows an image was delivered rather than finding a hole
 * where a field used to be. A result that is not JSON is text, unchanged.
 */
function liftImages(raw: string): { text: string; images: { data: string; mediaType: string }[] } {
  if (!raw.startsWith("{")) return { text: raw, images: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { text: raw, images: [] };
  }
  const images: { data: string; mediaType: string }[] = [];
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node !== "object" || node === null) return node;
    const entries: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if ((key === "dataUrl" || key === "imageDataUrl") && typeof value === "string") {
        const match = /^data:([^;,]+);base64,(.+)$/u.exec(value);
        if (match?.[1] !== undefined && match[2] !== undefined) {
          images.push({ mediaType: match[1], data: match[2] });
          entries[key] = `<image: ${match[1]}, sent to you as an image>`;
          continue;
        }
      }
      entries[key] = walk(value);
    }
    return entries;
  };
  return { text: JSON.stringify(walk(parsed)), images };
}

/**
 * What the agent sees once this reply's tool-result budget is spent. An empty
 * string would read as an empty document, and the uniform unavailable code would
 * claim a read that actually succeeded, so the adapter says what happened. The
 * wording names no tool family: one allowance is shared by every set one reply
 * runs with.
 */
const TOOL_BUDGET_SPENT = "[tool result omitted: this reply's tool budget is exhausted]";

/**
 * One reply's whole tool-result allowance, shared by every call in its tool
 * loop. The unit is the caller's choice; the reply path spends it with the same
 * counter (`tokenResultBudget`) that bounded the assembled prompt, so the
 * aggregate the model receives over all turns is exactly what the prompt budget
 * held back for it.
 */
export interface ToolResultBudget {
  /** True once nothing is left; the next call must not reach the tool. */
  spent(): boolean;
  /** Clips one result to what remains and spends what it returns. */
  clip(text: string): string;
}

/** The plan's per-result character cap, taken as the whole-reply allowance. */
export function charResultBudget(maxChars: number = MEDIA_TOOL_LIMITS.resultChars): ToolResultBudget {
  const remaining = { chars: maxChars };
  return {
    spent: () => remaining.chars <= 0,
    clip: (text) => {
      const clipped = clipScalars(text, remaining.chars).value;
      remaining.chars -= clipped.length;
      return clipped;
    },
  };
}

/**
 * The reply path's budget: the plan's aggregate media-tool-result reserve, spent
 * in the token counter's own unit. A result that would not fit is clipped rather
 * than dropped, and no later result can push the total past the reserve — so the
 * second and later model calls of a tool loop stay under the same 180k ceiling
 * the assembler enforced for the first.
 */
export function tokenResultBudget(counter: TokenCounter, tokens: number = REPLY_TOOL_RESULT_RESERVE_TOKENS): ToolResultBudget {
  const remaining = { tokens };
  return {
    spent: () => remaining.tokens <= 0,
    clip: (text) => {
      const clipped = clipToTokens(counter, text, remaining.tokens);
      remaining.tokens -= clipped.used;
      // Not one code point fits: the allowance is spent too, so the next call
      // reports the exhausted budget instead of asking again.
      if (clipped.text.length === 0 && text.length > 0) remaining.tokens = 0;
      return clipped.text;
    },
  };
}

/**
 * The one bridge from an in-process MCP session to the AI SDK, shared by every
 * tool set a reply runs with.
 *
 * The MCP definitions are passed through verbatim, so the model is offered
 * exactly the schemas the server registered — the tools of a group job carry
 * their own action params and nothing else, a direct chat's group tools name one
 * group, and no schema carries a tenant or an instance at all. Nothing is
 * restated from the job, and no generic query, URL, key, or path field exists
 * for the model to widen its own access with. Execution goes back through the
 * same session, so every call still re-runs the tool's own scope check.
 *
 * `budget` is the plan's tool-result segment for the whole reply, not a per-call
 * allowance: what the tools return in total can never exceed it, whatever the
 * model asks for and however many rounds it takes. Every set of one reply must
 * be handed the same budget object, or the aggregate would be a multiple of what
 * the prompt held back. Each result is also added to `links`, because tool output
 * is scoped evidence too — a link a group's own text or attachment contained may
 * be reused in the answer.
 */
async function toolSetOf(client: Client, links: Set<string>, budget: ToolResultBudget): Promise<ToolSet> {
  const { tools } = await client.listTools();
  const entries = await Promise.all(
    tools.map(async (definition): Promise<[string, ToolSet[string]]> => {
      const name = definition.name;
      return [
        name,
        dynamicTool({
          description: definition.description ?? name,
          inputSchema: jsonSchema<Record<string, unknown>>(definition.inputSchema),
          execute: async (input: unknown) => {
            if (budget.spent()) return { text: TOOL_BUDGET_SPENT, images: [] };
            // The tool's own JSON schema already promised an object, and the MCP
            // server re-checks it with its zod schema, so this only refuses a
            // shape that could not have come from the model in the first place.
            const args = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
            const result = await client.callTool({ name, arguments: args });
            const { text: withoutImages, images } = liftImages(toolResultText(result.content));
            const text = budget.clip(withoutImages);
            // An empty string would read as an empty document; if the allowance
            // could not fit a single code point, say the budget is spent.
            if (text.length === 0 && withoutImages.length > 0) return { text: TOOL_BUDGET_SPENT, images: [] };
            for (const link of sourceLinksOf([text])) links.add(link);
            return { text, images };
          },
          /**
           * An image a tool returned is sent as an image.
           *
           * `media_get_image` hands back a data URL, and `media_describe_video` a
           * frame per entry. Carried as text — which is what a tool result is by
           * default — those bytes reach the model as a base64 paragraph it cannot
           * decode, so a vision model is asked to look at a very long word and
           * answers from the file name. As a file part the provider sends the
           * pixels, which is the entire point of the tool.
           *
           * The base64 is also taken out of the text: it is not prose, it costs
           * nothing of the reply's text allowance, and leaving both copies would
           * spend that allowance twice.
           */
          toModelOutput: ({ output }) => {
            const bridged = bridgedResult(output);
            return bridged.images.length === 0
              ? { type: "text", value: bridged.text }
              : {
                  type: "content",
                  value: [
                    ...bridged.images.map((image) => ({
                      type: "file" as const,
                      data: { type: "data" as const, data: image.data },
                      mediaType: image.mediaType,
                    })),
                    { type: "text" as const, text: bridged.text },
                  ],
                };
          },
        }),
      ];
    }),
  );
  return Object.fromEntries(entries);
}

/**
 * The media MCP tools as the AI SDK's tool set, for one reply-job session: the
 * bridge above, applied to the session `connectMediaTools` opened.
 */
export async function mediaToolSet(client: Client, links: Set<string>, budget: ToolResultBudget = charResultBudget()): Promise<ToolSet> {
  return toolSetOf(client, links, budget);
}

/**
 * The group-maintenance MCP tools as the AI SDK's tool set, for one reply-job
 * session: the same bridge, applied to the session `connectGroupTools` opened.
 * The two sets are handed the same budget by the caller, so the reads, the
 * stages and the media reads of one reply spend one allowance between them — and
 * the stages carry no more authority here than they do in the server: they only
 * ever add a row the owner must approve.
 */
export async function groupToolSet(client: Client, links: Set<string>, budget: ToolResultBudget = charResultBudget()): Promise<ToolSet> {
  return toolSetOf(client, links, budget);
}
