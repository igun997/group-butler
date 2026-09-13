import { z } from "zod";
import { GroupStateSchema } from "@butler/shared";
import { INSTANCE_STATES } from "./types";

/**
 * The search-param codecs of spec §1.3: every field a view declares is validated
 * here, and a value that does not validate is **dropped**, not fatal. A stale
 * bookmark is a normal event, so the view renders a working default rather than
 * an error page (§2.3).
 *
 * Scope selectors are deliberately absent: `instance` and `group` are how a
 * *scope* is expressed (in the path, or as the query alias of §1.3), and
 * `scope.ts` consumes them before params are read — `groupJid` is never a loose
 * filter parameter (§2.2 invariant 4).
 */

/** A bounded, trimmed string. Every free-text param is bounded so a URL cannot be a payload. */
const text = (max: number) => z.string().trim().min(1).max(max);

/** `true`/`false` only: a checkbox filter that is neither is not a filter. */
const flag = z.enum(["true", "false"]).transform((value) => value === "true");

/** An opaque cursor. Its content is the server's business; its shape is not. */
export const cursorParam = text(256);

/** The §5.1 message kinds the search and stream filters accept. */
export const MESSAGE_KINDS = [
  "text",
  "image",
  "video",
  "audio",
  "document",
  "sticker",
  "location",
  "contact",
] as const;

/**
 * The params each view declares, keyed by view id. A view that lists a param here
 * gets it validated and dropped when invalid; a param it does not list is
 * dropped as unknown (§2.3).
 */
export const VIEW_PARAMS = {
  overview: z.object({ range: text(32) }),
  instances: z.object({ q: text(200), status: z.enum(INSTANCE_STATES) }),
  instance: z.object({ tab: text(32), q: text(200) }),
  groups: z.object({
    assigned: flag,
    whitelisted: flag,
    state: GroupStateSchema,
    q: text(200),
    activity: text(32),
    sort: text(32),
    cursor: cursorParam,
  }),
  group: z.object({ q: text(200), kinds: text(64), media: text(32), cursor: cursorParam }),
  messages: z.object({
    q: text(200),
    kind: z.enum(MESSAGE_KINDS),
    from: text(32),
    to: text(32),
    cursor: cursorParam,
  }),
  sends: z.object({ status: text(32), peek: text(64), cursor: cursorParam }),
  assistant: z.object({ call: text(64) }),
  stats: z.object({ tab: z.enum(["bots", "groups", "tokens"]), range: text(32), model: text(128) }),
  settings: z.object({ tab: text(32), cursor: cursorParam }),
} as const;

/** A validated param value. Numbers and booleans are the codecs' transformed outputs. */
export type ParamValue = string | number | boolean;

/** The params a view actually received, after validation and dropping. */
export type ViewParams = Record<string, ParamValue>;

/**
 * Validate one URL's search params against a view's schema, dropping unknown keys
 * and values that do not validate. Field-by-field rather than whole-object, so
 * one bad filter cannot blank the others.
 */
export function parseParams(schema: z.ZodType, search: URLSearchParams): ViewParams {
  const shape = (schema as { shape?: Record<string, z.ZodType> }).shape;
  if (!shape) return {};

  const params: ViewParams = {};
  for (const key of Object.keys(shape).sort()) {
    const raw = search.get(key);
    if (raw === null) continue;
    const parsed = shape[key]!.safeParse(raw);
    if (parsed.success) params[key] = parsed.data as ParamValue;
  }
  return params;
}

/** Serialise validated params into a canonical query string, or "" when there are none. */
export function serializeParams(params: ViewParams): string {
  const keys = Object.keys(params).sort();
  if (keys.length === 0) return "";
  const query = new URLSearchParams();
  for (const key of keys) query.set(key, String(params[key]));
  return `?${query.toString()}`;
}
