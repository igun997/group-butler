/**
 * Next.js startup hook: `register` runs once per server process when the BFF
 * boots, before any request is handled. Automatic replies only measure with a
 * counter this process has registered (`selectTokenCounter` has no implicit
 * default), so this is where the bundled one is put on the reply path — a
 * deployment that left it unregistered would fail every reply closed with
 * `token_counter_unavailable`.
 *
 * The import is deferred and node-only. It cannot be static: Next also builds an
 * edge instrumentation bundle for this app's middleware, and a static import
 * would put the tokenizer's multi-megabyte vocabulary table in it, where there
 * is no reply path to measure. A dynamic, guarded import keeps it in the node
 * server only.
 *
 * What it registers has to be visible from the route handlers, which Next
 * compiles as their own module layer: the counter registry therefore lives on
 * `globalThis` (see `server/memory/recall.ts`), not in module state that this
 * layer would only share with itself.
 */
export async function register(): Promise<void> {
  // The condition is written so each layer's bundler can evaluate it: Next
  // defines NEXT_RUNTIME per layer, and the edge bundle then drops this branch
  // instead of following the import into node-only modules.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerReplyTokenCounter } = await import("./server/memory/tokenizer");
    registerReplyTokenCounter();
  }
}
