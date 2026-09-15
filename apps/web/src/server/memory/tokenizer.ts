import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import { registerTokenCounter, type TokenCounter } from "./recall";

/**
 * The id `AI_TOKENIZER` names to put the bundled counter on the reply path.
 * Registered only by `registerReplyTokenCounter`, which the Next startup hook
 * (`instrumentation.ts`) calls once per server process.
 */
export const REPLY_TOKEN_COUNTER_ID = "o200k-upper-bound";

/**
 * The margin accounting applies on top of the bundled count. It is a declared
 * factor, not a measurement of the deployed tokenizer: `AI_MODEL` is a DeepSeek
 * model behind an OpenAI-compatible gateway, o200k is not its tokenizer, and its
 * own count is not observable from this process.
 *
 * Cross-family drift is real and uneven. Measured here against the bundled
 * vocabularies: the older `cl100k_base` family spends 1.31-1.37x o200k on
 * Indonesian samples and 1.00x on English ones. So this factor is a bound for
 * English-like content and a declared, not proven, bound for the Indonesian
 * traffic this deployment actually carries — the safe direction is upward, where
 * the only cost is dropping context slightly earlier.
 */
export const REPLY_TOKEN_COUNTER_MULTIPLIER = 1.1;

/**
 * The counter automatic replies measure with. `kind` is `upper_bound`, never
 * `exact`: the bundled tokenizer is a stand-in for a family it was not trained
 * for, and its raw count is scaled by `REPLY_TOKEN_COUNTER_MULTIPLIER` before
 * any budget in the assembler uses it.
 */
export const REPLY_TOKEN_COUNTER: TokenCounter = {
  id: REPLY_TOKEN_COUNTER_ID,
  kind: "upper_bound",
  multiplier: REPLY_TOKEN_COUNTER_MULTIPLIER,
  note:
    "gpt-tokenizer o200k_base BPE count x1.1: the deployment's model is a DeepSeek model behind an OpenAI-compatible gateway and o200k is not its tokenizer, " +
    "so this is an upper bound on the request rather than an exact count — the multiplier is the declared margin for that family mismatch, and " +
    "REPLY_STRUCTURAL_RESERVE_TOKENS still covers the prompt's own BOS/role/message-structure tokens, which no input text accounts for",
  count: countTokens,
};

/** Registers the bundled counter under its config id. Idempotent: one id, one counter. */
export function registerReplyTokenCounter(): void {
  registerTokenCounter(REPLY_TOKEN_COUNTER);
}
