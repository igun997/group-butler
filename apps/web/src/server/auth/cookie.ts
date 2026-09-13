/**
 * The session cookie's identity, kept in a module that imports nothing: it is
 * the one auth value the edge middleware needs, and `next/headers` runs it in a
 * runtime that has no `node:crypto`. The cookie's name and lifetime live here so
 * middleware and the node-side session code can never disagree about them.
 */
export const SESSION_COOKIE = "butler_session";

/** 7 days (docs/architecture-draft.md §11.1). */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
