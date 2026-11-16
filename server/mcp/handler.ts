// The MCP endpoint (Streamable HTTP, stateless, plain JSON responses), for
// teammates' own agents. Written by hand rather than with an SDK: four
// methods, no server-initiated messages, nothing to stream.
//
// Auth: `Authorization: Bearer <token>`. Tokens come from MCP_TOKENS in the
// server's .env as `label:token:TENANT,label2:token2:TENANT2`; each token
// works on one bank only.
import { timingSafeEqual } from 'node:crypto';
import { MCP_TOOLS, callTool, isToolError, type Caller } from './tools';

export const PROTOCOL_VERSION = '2025-06-18';

const INSTRUCTIONS = `Hyperface Campaign Designer. Hyperface's own campaign agent designs card campaigns (buckets of customers, a message journey per bucket) from a plain-language idea. You do not design anything yourself: you pass the idea on, relay its questions and changes, and show your human the canvas link.
Flow: start_campaign(idea, questions: "ask" if your human can answer a few clarifying questions, "assume" for a fast first draft) → get_campaign(waitSeconds: 50) until the status changes → if "needs_answers", answer_questions (ask your human what you do not know; skip the rest and the agent assumes and says so) → when "ready", show the summary and link → request_changes for anything they want different → submit_campaign only after they explicitly say it is good to go and confirm the start and end dates. To pause or pull back a submitted campaign, withdraw_campaign (resubmit to resume). delete_campaign removes drafts only. For a variant of an existing campaign (new season, audience, channel mix), copy_campaign then request_changes; for a different goal, start_campaign. A design takes a few minutes. Full guide: https://ai.product.hyperface.co/campaigndesigneragent/mcp/guide`;

export interface TokenEntry {
  label: string;
  token: string;
  tenantId: string;
}

export function parseTokens(raw: string | undefined): TokenEntry[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [label, token, tenantId] = s.split(':').map((x) => x.trim());
      return { label, token, tenantId };
    })
    .filter((t) => t.label && t.token && t.tenantId && t.token.length >= 16);
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function callerFor(authHeader: string | undefined, tokens: TokenEntry[], appUrl: string): Caller | null {
  const m = /^Bearer\s+(.+)$/i.exec(authHeader ?? '');
  if (!m) return null;
  const hit = tokens.find((t) => same(t.token, m[1].trim()));
  return hit ? { label: hit.label, tenantId: hit.tenantId, appUrl } : null;
}

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const ok = (id: RpcRequest['id'], result: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result });
const fail = (id: RpcRequest['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/** One JSON-RPC message. Returns null for a notification (nothing to send back). */
export async function handleRpc(msg: RpcRequest, caller: Caller): Promise<unknown | null> {
  const isNotification = msg.id === undefined;
  switch (msg.method) {
    case 'initialize':
      return ok(msg.id, {
        protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'hyperface-campaign-designer', version: '1.0.0' },
        instructions: INSTRUCTIONS,
      });
    case 'ping':
      return ok(msg.id, {});
    case 'tools/list':
      return ok(msg.id, { tools: MCP_TOOLS });
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const result = await callTool(caller, name, args);
        return ok(msg.id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result });
      } catch (e) {
        // A tool that could not do what was asked is a result the caller's agent reads, not a protocol error.
        if (isToolError(e)) return ok(msg.id, { content: [{ type: 'text', text: e.message }], isError: true });
        return ok(msg.id, { content: [{ type: 'text', text: `Something went wrong: ${(e as Error).message}` }], isError: true });
      }
    }
    default:
      if (isNotification) return null; // notifications/initialized and the like
      return fail(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

/** The whole HTTP exchange for POST /mcp. */
export async function handleMcpHttp(input: { method: string; auth: string | undefined; body: unknown; tokens: TokenEntry[]; appUrl: string }): Promise<{ status: number; json?: unknown; headers?: Record<string, string> }> {
  if (input.method === 'GET' || input.method === 'DELETE') return { status: 405, headers: { allow: 'POST' } };
  if (input.method !== 'POST') return { status: 405, headers: { allow: 'POST' } };
  if (!input.tokens.length) return { status: 503, json: { error: 'The MCP is not set up on this server (no MCP_TOKENS).' } };
  const caller = callerFor(input.auth, input.tokens, input.appUrl);
  if (!caller) return { status: 401, json: { error: 'Missing or wrong token. Send Authorization: Bearer <token>.' } };
  const body = input.body;
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handleRpc(m as RpcRequest, caller)))).filter((x) => x !== null);
    return out.length ? { status: 200, json: out } : { status: 202 };
  }
  if (!body || typeof body !== 'object') return { status: 400, json: fail(null, -32700, 'Parse error') };
  const res = await handleRpc(body as RpcRequest, caller);
  return res === null ? { status: 202 } : { status: 200, json: res };
}
