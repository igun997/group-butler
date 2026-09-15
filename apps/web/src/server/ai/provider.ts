import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

/**
 * The deployment's model endpoint, as every caller configures it.
 *
 * One factory, because the request body is not as portable as the SDK assumes
 * and a second construction would drift. The endpoint is any OpenAI-compatible
 * base URL, but the wire behaviour is the deployment's to state, and this
 * deployment needs one thing said explicitly — see below.
 */
export interface ProviderConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

/**
 * Builds the chat provider for an OpenAI-compatible endpoint.
 *
 * `stream: false` is pinned on every non-streaming request because the field is
 * optional in the OpenAI schema and this gateway does not default it the way the
 * schema implies: with the field absent it answers `text/event-stream` for most
 * of its models, and the SDK's non-streaming reader rejects that body as invalid
 * JSON ("AI_APICallError: Invalid JSON response"). Sending the field is also what
 * makes such a gateway answer a normal completion.
 *
 * A caller that asked to stream keeps its `stream: true`: the option only fills
 * in what was left unsaid, so the streaming path the provider supports keeps
 * working.
 */
export function createCompatibleProvider(config: ProviderConfig) {
  return createOpenAICompatible({
    name: "group-butler",
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    transformRequestBody: (args) => (args.stream === true ? args : { ...args, stream: false }),
  });
}

/**
 * True when the endpoint answered with a body its own schema does not allow.
 *
 * This gateway answers `200` with an error envelope — `{"error":…,"object":
 * "chat.completion","created":…}` and no `choices` — so the SDK's response
 * validation is what fails, not the model. Observed in production as
 * `Invalid input: expected array, received undefined` at `choices`.
 *
 * It is distinguished from the deployment's own structured-output validation
 * because the two mean opposite things: this one says nothing about the model's
 * answer and is worth asking again, while a failed parse of the model's own
 * output is a refusal. The distinction is a class, not a message: matching on
 * text here would decay the first time the SDK rewords itself.
 */
const TYPE_VALIDATION_MARKER = Symbol.for("vercel.ai.error.AI_TypeValidationError");

export function isProviderProtocolFailure(error: unknown): boolean {
  return isMarkedError(error, TYPE_VALIDATION_MARKER);
}

/**
 * The SDK marks each of its error classes with a `Symbol.for`-registered
 * well-known symbol, and asks all of its own `isInstance` questions that way.
 * This deployment asks the same question through the same door deliberately: a
 * `Next` server build bundles its own copy of the SDK, and `instanceof` is false
 * across two copies of one class. It is also what keeps this check honest in
 * tests, which stand in for the SDK by replacing the module.
 */
function isMarkedError(error: unknown, marker: symbol): boolean {
  return typeof error === "object" && error !== null && (error as Record<symbol, unknown>)[marker] === true;
}
