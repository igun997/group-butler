import { describe, expect, test } from "vitest";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import { accountedCount, assembleReplyPrompt, selectTokenCounter, type TokenCounter } from "./recall";
import {
  REPLY_TOKEN_COUNTER,
  REPLY_TOKEN_COUNTER_ID,
  REPLY_TOKEN_COUNTER_MULTIPLIER,
  registerReplyTokenCounter,
} from "./tokenizer";

describe("the bundled reply token counter", () => {
  test("is a bound, never an exact count, and says which tokenizer it is not", () => {
    expect(REPLY_TOKEN_COUNTER.kind).toBe("upper_bound");
    expect(REPLY_TOKEN_COUNTER.multiplier).toBe(REPLY_TOKEN_COUNTER_MULTIPLIER);
    expect(REPLY_TOKEN_COUNTER_MULTIPLIER).toBeGreaterThan(1);
    // The deployed model family is not the one this tokenizer was trained for,
    // so the note has to name both the encoding and the mismatch.
    expect(REPLY_TOKEN_COUNTER.note).toMatch(/o200k/);
    expect(REPLY_TOKEN_COUNTER.note).toMatch(/deepseek/i);
    expect(REPLY_TOKEN_COUNTER.note).toMatch(/upper bound/i);
  });

  test("counts with the bundled o200k BPE rather than a stand-in measure", () => {
    expect(REPLY_TOKEN_COUNTER.count("hello world")).toBe(countTokens("hello world"));
    expect(REPLY_TOKEN_COUNTER.count("👋🏽 deploy finished")).toBe(countTokens("👋🏽 deploy finished"));
    // A raw count that already carried the multiplier would not match the BPE.
    expect(REPLY_TOKEN_COUNTER.count("hello world")).not.toBe(Math.ceil(countTokens("hello world") * REPLY_TOKEN_COUNTER_MULTIPLIER));
  });

  test("becomes selectable only once the startup hook has registered it", () => {
    registerReplyTokenCounter();
    expect(selectTokenCounter({ tokenizer: REPLY_TOKEN_COUNTER_ID })).toBe(REPLY_TOKEN_COUNTER);
    // Registering twice is harmless: the map holds one counter per id.
    registerReplyTokenCounter();
    expect(selectTokenCounter({ tokenizer: REPLY_TOKEN_COUNTER_ID })).toBe(REPLY_TOKEN_COUNTER);
    // An id that merely looks like an encoding name is still not this counter.
    expect(selectTokenCounter({ tokenizer: "o200k_base" })).toBeNull();
  });

  test("accounts the multiplier on top of the raw count", () => {
    const text = "The deploy finished and the group was told about it.";
    expect(accountedCount(REPLY_TOKEN_COUNTER, text)).toBe(Math.ceil(countTokens(text) * REPLY_TOKEN_COUNTER_MULTIPLIER));
    expect(accountedCount(REPLY_TOKEN_COUNTER, text)).toBeGreaterThan(countTokens(text));
  });

  test("bounds an assembled prompt by the multiplied count, not the raw one", () => {
    const rawCount: TokenCounter = { ...REPLY_TOKEN_COUNTER, multiplier: 1 };
    const input = { chatKind: "group" as const, currentRequest: "@butler status?", messages: [], recall: { summaries: [], facts: [] } };
    const bounded = assembleReplyPrompt({ ...input, counter: REPLY_TOKEN_COUNTER });
    const raw = assembleReplyPrompt({ ...input, counter: rawCount });

    if (!bounded.ok || !raw.ok) throw new Error("expected assembly to succeed");
    expect(bounded.tokenizerId).toBe(REPLY_TOKEN_COUNTER_ID);
    expect(bounded.inputTokens).toBeGreaterThan(raw.inputTokens);
    expect(bounded.accountedTokens).toBe(bounded.inputTokens + bounded.reserveTokens);
  });
});
