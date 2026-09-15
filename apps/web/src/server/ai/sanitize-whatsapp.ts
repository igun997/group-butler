const MAX_SCALARS = 3_500;

// This intentionally names the Unicode control ranges removed at the WhatsApp boundary.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

/**
 * Bidi overrides and isolates, zero-width format characters, the soft hyphen and
 * the BOM. They carry no visible content, so a model output that uses them is
 * either mangled or trying to reorder what a reader sees.
 */
const FORBIDDEN_FORMAT = /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/gu;

/** A lone surrogate is invalid UTF-8; under `u` the class never matches a valid pair. */
const LONE_SURROGATE = /[\uD800-\uDFFF]/gu;

/**
 * Any `scheme://…` token, so an arbitrary scheme is refused rather than ignored.
 * The class stops at quotes and angle brackets, not just whitespace, because the
 * scoped evidence includes tool results as JSON: without that, a link inside a
 * JSON string would swallow the rest of the document and never match the plain
 * link the model quotes back.
 */
const ABSOLUTE_URL = /\b([a-z][a-z0-9+.-]*):\/\/[^\s<>"'`]+/giu;

/**
 * Schemes that execute or exfiltrate and are written without the `//` of an
 * absolute URL — `javascript:`, `data:`, `file:/etc/passwd`, `blob:https://…` —
 * which the scan above would miss entirely. A space after the colon is prose
 * (`data: 42 rows`), not a scheme, so the match requires a non-space next.
 */
const BARE_SCHEME = /\b([a-z][a-z0-9+.-]*):\S/giu;

/** The plan's allowlist: the only schemes a reply may carry, `//` or not. */
const ALLOWED_SCHEMES: Record<string, true> = { http: true, https: true, mailto: true, tel: true };

/** A tag or a markdown link is not plain text; neither belongs in a WhatsApp body. */
const HTML_TAG = /<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/iu;
const MARKDOWN_LINK = /!?\[[^\]\n]*\]\([^)\n]*\)/u;

/**
 * A provider control token: the fullwidth vertical line DeepSeek writes as
 * `<｜DSML｜function_calls>`, or any `<|…|>` chat-template token. These are
 * markup the model emits for its own runtime, never prose for a reader, and the
 * endpoint this deployment uses sometimes returns a tool call as text — the
 * leaked body was `<｜DSML｜function_calls`, cut off before its closing bracket.
 * The fullwidth line is also the reason this is a codepoint test and not an
 * angle-bracket one: that truncated form has no bracket to match.
 *
 * A body carrying one is refused rather than stripped. What remains after
 * stripping is the fragment of a turn the model never finished — the observed
 * leak left English tool narration and then markup — and a reader is owed an
 * answer, not a fragment of one.
 */
const MODEL_CONTROL = /\uFF5C|<\|/u;

/** A whole-body JSON object is a tool result escaping into the group. */
function looksLikeToolJson(text: string): boolean {
  if (!/^[{[]/u.test(text)) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * The shared boundary for every untrusted string this deployment displays or
 * hands to a model: NFC, well-formed, and stripped of controls and invisible
 * formatting. It preserves line breaks and tabs because those are content;
 * anything else the reader cannot see is not.
 *
 * Exported because media extraction needs the same stripping — an extracted
 * document is untrusted input in exactly the same way a model answer is.
 */
export function normalizeUntrustedText(value: string): string {
  return value.normalize("NFC").replace(CONTROL, "").replace(FORBIDDEN_FORMAT, "").replace(LONE_SURROGATE, "");
}

/**
 * Caps a string at `maximum` Unicode scalar values, counting code points rather
 * than code units. The two-unit pre-slice is what keeps the cap from spreading
 * an unbounded string into an array of every character just to measure it.
 * Exported because extracted media text is capped the same way.
 */
export function clipScalars(value: string, maximum: number): { value: string; truncated: boolean } {
  if (value.length <= maximum) return { value, truncated: false };
  return { value: [...value.slice(0, maximum * 2)].slice(0, maximum).join(""), truncated: true };
}

/**
 * The absolute URLs that literally occur in the scoped evidence, exactly as the
 * gate compares them. The reply agent feeds the assembled prompt and every tool
 * result through here, so a link the model reuses is one the group itself
 * supplied — and one the model invented is not in the set at all.
 */
export function sourceLinksOf(values: readonly string[]): Set<string> {
  const links = new Set<string>();
  for (const value of values) {
    for (const match of value.matchAll(ABSOLUTE_URL)) links.add(match[0]);
  }
  return links;
}

export type WhatsAppOutputCode = "empty" | "unsafe_link" | "unsafe_markup" | "unsafe_json" | "model_markup";

/**
 * The gate's answer. A rejection carries no text at all: the caller creates no
 * send, so there is nothing a later step could render by mistake.
 */
export type SanitizedWhatsAppOutput = { ok: true; text: string } | { ok: false; code: WhatsAppOutputCode };

/**
 * The last deterministic step before `createAutomaticSendUnderRunLease` (plan §"Injection
 * defense and WhatsApp output sanitization"). Nothing here trusts the model:
 * format characters are removed, blank runs collapsed, length capped, and every
 * URL checked against the allowed schemes and against the links that actually
 * occurred in the scoped source evidence. WhatsApp `wa.me` links are refused
 * unless the group itself supplied that exact link, so a model cannot invite the
 * owner somewhere the conversation never went.
 */
export function sanitizeWhatsAppOutput(value: string, sourceLinks: ReadonlySet<string> = new Set()): SanitizedWhatsAppOutput {
  const text = normalizeUntrustedText(value)
    .replace(/\n[\t ]*\n(?:[\t ]*\n)+/gu, "\n\n")
    .trim();
  if (!text) return { ok: false, code: "empty" };
  // Before anything else, because a body carrying control markup is not prose
  // this deployment may reason about: it is a tool call that arrived as text.
  if (MODEL_CONTROL.test(text)) return { ok: false, code: "model_markup" };
  // Absolute URLs first: the scheme must be one the deployment allows, and a
  // WhatsApp invite must be one the scoped evidence actually carried. The spans
  // they occupy are remembered so the scan below can leave them alone.
  const absoluteUrls: { start: number; end: number }[] = [];
  for (const match of text.matchAll(ABSOLUTE_URL)) {
    const link = match[0];
    const scheme = (match[1] ?? "").toLowerCase();
    if (scheme !== "https" && scheme !== "http") return { ok: false, code: "unsafe_link" };
    if (/^https?:\/\/wa\.me\//iu.test(link) && !sourceLinks.has(link)) return { ok: false, code: "unsafe_link" };
    const start = match.index ?? 0;
    absoluteUrls.push({ start, end: start + link.length });
  }
  // A whole-body JSON object is a tool result escaping into the group, and it is
  // refused before the scan below — whose `"key":value` tokens would otherwise
  // read as schemes of their own.
  if (looksLikeToolJson(text)) return { ok: false, code: "unsafe_json" };
  for (const match of text.matchAll(BARE_SCHEME)) {
    const start = match.index ?? 0;
    // A colon inside an accepted URL is not a scheme of its own; every other
    // one must be a scheme the plan allows, whether or not it carries `//`.
    if (absoluteUrls.some((url) => start >= url.start && start < url.end)) continue;
    if (ALLOWED_SCHEMES[(match[1] ?? "").toLowerCase()] !== true) return { ok: false, code: "unsafe_link" };
  }
  if (HTML_TAG.test(text) || MARKDOWN_LINK.test(text)) return { ok: false, code: "unsafe_markup" };
  return { ok: true, text: clipScalars(text, MAX_SCALARS).value };
}
