import { timingSafeEqual } from "node:crypto";
import type { Db } from "mongodb";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { authorizedJidsOf, normalizeAuthorizedJid } from "../authorized-jids";
import { COLLECTIONS } from "../collections";
import { getDb } from "../mongo";
import { ORG_DEFAULT_ID } from "../bootstrap";
import { type GroupToolDeps, registerGroupTools } from "./group-tools";
import { type MediaToolDeps, registerMediaTools, type ToolChatContext } from "./media-tools";

/**
 * What one external agent is allowed to reach, resolved from the deployment's
 * own environment rather than from the request. Every tool the endpoint offers
 * is scoped by this and by nothing the caller sends: the agent can name a group
 * only if this instance monitors it, and can read a message only if it belongs
 * to this tenant. An agent that has not been granted an instance and at least
 * one owner address therefore gets no tool at all, which is the same refusal a
 * reply job with no accepted owner gets.
 */
export interface ButlerMcpScope {
  organizationId: string;
  instanceId: string;
  authorizedJids: readonly string[];
}

/** Both families' seams, so one endpoint can be given one set of test doubles. */
export type ButlerToolDeps = GroupToolDeps & MediaToolDeps;

const TOKEN_ENV = "MCP_BUTLER_TOKEN";
const ORGANIZATION_ENV = "MCP_BUTLER_ORGANIZATION_ID";
const INSTANCE_ENV = "MCP_BUTLER_INSTANCE_ID";
const OWNERS_ENV = "MCP_BUTLER_OWNER_JIDS";

/**
 * The scope, resolved from the deployment's own data.
 *
 * An instance id and an owner list as environment values are two facts that already
 * live in MongoDB — and they drift. Wiping the database, recreating the instance, or
 * re-pairing all change the instance id, and a stale one made every tool answer
 * "nothing" without a single error anywhere: the console's scope panel still looked
 * correct, because it reads the live row. Deriving them removes the settings rather
 * than asking an operator to keep them in step.
 *
 * Both environment variables remain as overrides, which is what a deployment serving
 * more than one instance would use.
 */
export async function readButlerMcpScope(env: NodeJS.ProcessEnv = process.env): Promise<ButlerMcpScope | null> {
  const db = await getDb();
  const organizationId = (env[ORGANIZATION_ENV] ?? "").trim() || ORG_DEFAULT_ID;

  const organization = await db
    .collection<{ config?: { autoReplyAuthorizedJids?: unknown } }>(COLLECTIONS.organizations)
    .findOne({ _id: organizationId as never }, { projection: { _id: 0, "config.autoReplyAuthorizedJids": 1 } });

  const configuredOwners = (env[OWNERS_ENV] ?? "").trim();
  const authorizedJids =
    configuredOwners !== ""
      ? dedupeOwners(configuredOwners.split(","))
      : authorizedJidsOf(organization?.config?.autoReplyAuthorizedJids);
  const [owner] = authorizedJids;
  if (owner === undefined) return null;

  const configuredInstance = (env[INSTANCE_ENV] ?? "").trim();
  const instanceId = configuredInstance !== "" ? configuredInstance : await soleInstanceId(db, organizationId);
  if (instanceId === null) return null;

  return { organizationId, instanceId, authorizedJids };
}

/** The same normalisation the environment path uses, so both agree on what an owner is. */
function dedupeOwners(values: readonly string[]): string[] {
  return [
    ...new Set(
      values
        .map((value) => normalizeAuthorizedJid(value))
        .filter((jid): jid is string => jid !== null),
    ),
  ].sort();
}

/**
 * The organisation's only live instance, or `null` when there is not exactly one.
 *
 * Ambiguity refuses rather than guesses: two instances and one token would mean the
 * assistant silently answers about whichever row came first, which is the class of
 * bug this function exists to remove. A deployment with several instances names the
 * one it means in the environment.
 */
async function soleInstanceId(db: Db, organizationId: string): Promise<string | null> {
  const instances = await db
    .collection(COLLECTIONS.instances)
    .find({ organizationId, deletedAt: null }, { projection: { _id: 1 }, limit: 2 })
    .toArray();
  const [only] = instances;
  if (instances.length !== 1 || only === undefined) return null;
  return String(only._id);
}

/**
 * The descriptor both tool families scope themselves by. An external agent
 * speaks for the owner's own chat, which is the only shape that lets it name a
 * group: `chatKind: "user"` with no group of its own is exactly the direct-chat
 * descriptor, so a call must name a group this instance monitors and the live
 * re-authorization decides whether it may.
 */
export function butlerChatContext(scope: ButlerMcpScope): ToolChatContext {
  return {
    organizationId: scope.organizationId,
    instanceId: scope.instanceId,
    chatKind: "user",
    chatJid: scope.authorizedJids[0] ?? "",
    groupJid: null,
    authorizedJids: scope.authorizedJids,
  };
}

/** One server offering both families, so an external agent needs one endpoint. */
export function createButlerMcpServer(context: ToolChatContext, deps: ButlerToolDeps = {}): McpServer {
  const server = new McpServer({ name: "butler", version: "1.0.0" });
  registerGroupTools(server, context, deps);
  registerMediaTools(server, context, deps);
  return server;
}

/**
 * The one credential this endpoint accepts: a bearer token compared in constant
 * time, so a caller cannot learn the token's length or prefix from how long a
 * refusal took. An unset token refuses everything — the endpoint is never
 * accidentally open because an operator forgot to set it.
 */
export function butlerTokenMatches(authorization: string | null, expected: string | undefined): boolean {
  if (!authorization?.startsWith("Bearer ") || !expected) return false;
  const supplied = Buffer.from(authorization.slice(7));
  const want = Buffer.from(expected);
  return supplied.length === want.length && timingSafeEqual(supplied, want);
}

export { TOKEN_ENV, ORGANIZATION_ENV, INSTANCE_ENV, OWNERS_ENV };
