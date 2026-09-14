/**
 * The BFF transport seam of the resource layer (docs/ui-decision.md §2.2
 * invariant 2, §4.5 R-X1).
 *
 * A view never calls `fetch`. Every read is a `ResourceDescriptor` whose `fetch`
 * runs through here, and every write goes through a view's model on top of it,
 * so the three things every call shares live in one place: the request shape
 * (same-origin credentials, an `accept` header the caller can extend), the rule
 * that a failed answer contributes its own stable `code` and nothing else, and
 * the rule that a body this build cannot read becomes a declared `decode_error`
 * rather than an exception that reaches React.
 *
 * Nothing a response says about itself survives this module except its code: no
 * message, no stack, no driver text. That is R-X1's first sentence made
 * structural — a surface can only render what the error map knows about.
 */

/**
 * One failed call, carrying the server's own stable code. It is deliberately not
 * per-view: the error map is the only reader, and it reads `code`.
 */
export class BffRequestError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BffRequestError";
  }
}

/** The stable code of an answer this build cannot read (§4.5: raw codes only). */
export const UNREADABLE_BODY = "decode_error";

/** The server's own code for a failed answer, or the best one this build can name. */
async function failureCode(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    const code = (body as { code?: unknown } | null)?.code;
    if (typeof code === "string" && code.length > 0) return code;
  } catch {
    // The body was not JSON, so the status is the only evidence there is.
  }
  return response.status === 401 ? "unauthorized" : "unknown";
}

/** One request whose answer is JSON, with the two failures every call can have named. */
export async function readJson(input: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(input, {
    ...init,
    credentials: "same-origin",
    headers: { accept: "application/json", ...init.headers },
  });
  if (!response.ok) throw new BffRequestError(await failureCode(response));
  try {
    return await response.json();
  } catch {
    throw new BffRequestError(UNREADABLE_BODY);
  }
}
