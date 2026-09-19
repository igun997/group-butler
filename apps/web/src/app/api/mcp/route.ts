import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  TOKEN_ENV,
  butlerChatContext,
  butlerTokenMatches,
  createButlerMcpServer,
  readButlerMcpScope,
} from "../../../server/mcp/http";

/**
 * The repository's capabilities as one MCP endpoint an external agent can
 * consume.
 *
 * Every request builds its own server and transport, and the transport holds no
 * session: the scope comes from this deployment's environment, so two requests
 * carrying the same token are the same principal and there is nothing to keep
 * between them. That also means a restart cannot strand an agent on a session id
 * that no longer exists.
 *
 * The bearer token is the whole authorization. Without it the endpoint answers
 * `401` and nothing else — no tool list, no schema, no group count — because the
 * schemas alone name what this tenant can be asked about.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function serve(request: Request): Promise<Response> {
  if (!butlerTokenMatches(request.headers.get("authorization"), process.env[TOKEN_ENV])) {
    return new Response("unauthorized", { status: 401, headers: { "www-authenticate": "Bearer" } });
  }
  const scope = await readButlerMcpScope();
  // A configured token with no usable scope is a deployment fault, not a
  // caller's mistake: say so instead of offering a server whose every tool
  // would refuse.
  if (scope === null) {
    return new Response(`${TOKEN_ENV} is set but MCP_BUTLER_INSTANCE_ID and MCP_BUTLER_OWNER_JIDS do not name a scope`, {
      status: 500,
    });
  }

  const server = createButlerMcpServer(butlerChatContext(scope));
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}

export async function POST(request: Request): Promise<Response> {
  return serve(request);
}

export async function GET(request: Request): Promise<Response> {
  return serve(request);
}

export async function DELETE(request: Request): Promise<Response> {
  return serve(request);
}
