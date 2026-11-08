/**
 * Local mock of the Anthropic Messages API, used to test Claude Code integration WITHOUT any billable call.
 *
 *  - POST /v1/messages (SSE streaming and plain JSON), POST /v1/messages/count_tokens, anything else -> harmless `{}`.
 *  - Every request body is appended to a JSONL file (`{ts, method, path, body}`). Request HEADERS ARE NEVER STORED
 *    (they may carry credentials).
 *  - Replies follow a scripted policy, chosen statelessly from the number of tool_result blocks in the request:
 *      echo-structured : immediately call `StructuredOutput` with a fixed valid diagnosis
 *      scripted        : steps[k] answers the request that carries k tool_results; past the end, the last
 *                        `structured` step (or the fixed diagnosis) is repeated.
 *  - Requests without tools (title / summary generation, quota probes, `claude -p "hi" --tools ""`) get a short text
 *    reply (or minimal JSON when the request asks for a json_schema output format).
 *  - `usage` numbers are derived from the request with the proxy tokenizer, split into uncached / cache-read /
 *    cache-creation tokens the way a prompt-cached agent loop reports them.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { countTokens } from '../../evaluation/token-accounting.js';

export interface MockDiagnosis { candidates: { file: string; symbol: string; start_line?: number; end_line?: number; explanation: string }[]; fix?: { file: string; description: string } }

export const FIXED_DIAGNOSIS: MockDiagnosis = {
  candidates: [{ file: 'src/auth/auth.service.ts', symbol: 'AuthService.refreshToken', start_line: 1, end_line: 2, explanation: 'mock diagnosis (no model was called)' }],
};

export type MockStep =
  /** `tool: 'mcp:auto'` picks an offered `mcp__*` tool (search-like names first); `input: {$fill: 'text'}` fills its required string fields. */
  | { tool: string; input: Record<string, unknown>; text?: string }
  | { structured: unknown }
  | { text: string };

export type MockPolicy =
  | { kind: 'echo-structured'; diagnosis?: unknown }
  | { kind: 'scripted'; steps: MockStep[] }
  /** Infrastructure failure: every /v1/messages request gets this HTTP error (e.g. 401 authentication_error, 429 rate_limit_error, 529 overloaded_error). */
  | { kind: 'fault'; status: number; error_type: string; message: string };

export interface MockOptions {
  /** JSONL file receiving one record per request (bodies only). */
  logFile?: string;
  policy: MockPolicy | ((conversationKey: string) => MockPolicy);
  port?: number;
  /** Artificial delay per reply (ms). */
  delayMs?: number;
}

export interface MockRequestRecord { ts: string; method: string; path: string; conversation: string; tool_results: number; body: any }

export interface MockServer {
  url: string;
  port: number;
  /** Paths hit so far, in order (with counts available via `paths()`). */
  paths(): string[];
  requests(): MockRequestRecord[];
  close(): Promise<void>;
}

/**
 * Ports of mock servers started BY THIS PROCESS. The billing gate treats a child as "mock" only if its base URL is one of these;
 * mock mode is never inferred from the environment (a localhost gateway / ssh tunnel that injects a real key must not pass).
 */
const ownPorts = new Set<number>();
export function isOwnMockUrl(u: string | undefined): boolean {
  if (!u) return false;
  try { const x = new URL(u); return x.protocol === 'http:' && x.hostname === '127.0.0.1' && !x.username && !x.password && ownPorts.has(Number(x.port)) && (x.pathname === '/' || x.pathname === ''); } catch { return false; }
}

/* ------------------------------ body inspection ------------------------------ */

const blocks = (m: any): any[] => (Array.isArray(m?.content) ? m.content : typeof m?.content === 'string' ? [{ type: 'text', text: m.content }] : []);

export function countToolResults(body: any): number {
  let n = 0;
  for (const m of body?.messages ?? []) for (const b of blocks(m)) if (b?.type === 'tool_result') n++;
  return n;
}

export function firstUserText(body: any): string {
  const m = (body?.messages ?? []).find((x: any) => x.role === 'user');
  return blocks(m).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

export function conversationKey(body: any): string {
  return crypto.createHash('sha1').update(firstUserText(body)).digest('hex').slice(0, 12);
}

export function toolNames(body: any): string[] { return (body?.tools ?? []).map((t: any) => t.name); }

/** Minimal instance of a JSON schema (for auxiliary structured-output requests). */
export function fillSchema(s: any, str = 'Mock'): unknown {
  if (!s || typeof s !== 'object') return 'ok';
  if (s.enum?.length) return s.enum[0];
  switch (s.type) {
    case 'object': {
      const o: Record<string, unknown> = {};
      for (const k of s.required ?? Object.keys(s.properties ?? {})) o[k] = fillSchema(s.properties?.[k], str);
      return o;
    }
    case 'array': return s.minItems ? Array.from({ length: s.minItems }, () => fillSchema(s.items, str)) : [];
    case 'integer': case 'number': return 0;
    case 'boolean': return false;
    default: return str;
  }
}

/* ------------------------------- reply building ------------------------------ */

interface Reply { content: any[]; stop_reason: 'end_turn' | 'tool_use' }

const toolId = () => `toolu_${crypto.randomBytes(12).toString('hex')}`;

function chooseStep(policy: MockPolicy, k: number): MockStep {
  if (policy.kind === 'fault') return { text: 'unreachable' };
  if (policy.kind === 'echo-structured') return { structured: policy.diagnosis ?? FIXED_DIAGNOSIS };
  const steps = policy.steps;
  if (k < steps.length) return steps[k];
  const lastStructured = [...steps].reverse().find((s) => 'structured' in s);
  return lastStructured ?? { structured: FIXED_DIAGNOSIS };
}

function buildReply(body: any, policy: MockPolicy): Reply {
  const names = toolNames(body);
  if (!names.length) {
    const schema = body?.output_config?.format?.schema ?? body?.response_format?.schema;
    return { content: [{ type: 'text', text: schema ? JSON.stringify(fillSchema(schema)) : 'OK' }], stop_reason: 'end_turn' };
  }
  const step = chooseStep(policy, countToolResults(body));
  if ('structured' in step) {
    const name = 'StructuredOutput';
    return { content: [{ type: 'tool_use', id: toolId(), name, input: step.structured }], stop_reason: 'tool_use' };
  }
  if ('text' in step) return { content: [{ type: 'text', text: step.text }], stop_reason: 'end_turn' };
  const content: any[] = [];
  if (step.text) content.push({ type: 'text', text: step.text });
  let { tool, input } = step;
  if (tool === 'mcp:auto') {
    // Pick an MCP tool actually offered in this request (prefer search-like names) and fill its required inputs.
    const offered: any[] = (body?.tools ?? []).filter((t: any) => String(t.name).startsWith('mcp__'));
    const pick = offered.find((t) => /search|query|find|explore/i.test(t.name)) ?? offered[0];
    tool = pick ? pick.name : 'mcp__none__not_offered';
    if (pick && (input as any)?.$fill) input = fillSchema(pick.input_schema, String((input as any).$fill)) as Record<string, unknown>;
  }
  content.push({ type: 'tool_use', id: toolId(), name: tool, input });
  return { content, stop_reason: 'tool_use' };
}

export interface MockUsage { input_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number; output_tokens: number }

/** Usage as a prompt-cached agent loop would report it: everything before the last message is a cache read. */
export function mockUsage(body: any, reply: Reply): MockUsage {
  const sys = JSON.stringify(body?.system ?? '');
  const tools = JSON.stringify(body?.tools ?? []);
  const msgs: any[] = body?.messages ?? [];
  const prefix = countTokens(sys + tools + JSON.stringify(msgs.slice(0, -1)));
  const last = countTokens(JSON.stringify(msgs.slice(-1)));
  const out = Math.max(1, countTokens(JSON.stringify(reply.content)));
  const cacheRead = msgs.length > 1 ? prefix : 0;
  return { input_tokens: 3, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: msgs.length > 1 ? last : prefix + last, output_tokens: out };
}

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export function sseEvents(body: any, reply: Reply, usage: MockUsage): string {
  const id = `msg_${crypto.randomBytes(12).toString('hex')}`;
  let out = sse('message_start', {
    type: 'message_start',
    message: { id, type: 'message', role: 'assistant', model: body?.model ?? 'mock', content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } },
  });
  out += sse('ping', { type: 'ping' });
  reply.content.forEach((b, index) => {
    if (b.type === 'text') {
      out += sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      for (let i = 0; i < b.text.length; i += 24) out += sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text.slice(i, i + 24) } });
    } else {
      out += sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      const json = JSON.stringify(b.input);
      for (let i = 0; i < json.length; i += 40) out += sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(i, i + 40) } });
    }
    out += sse('content_block_stop', { type: 'content_block_stop', index });
  });
  out += sse('message_delta', { type: 'message_delta', delta: { stop_reason: reply.stop_reason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
  out += sse('message_stop', { type: 'message_stop' });
  return out;
}

export function jsonMessage(body: any, reply: Reply, usage: MockUsage) {
  return { id: `msg_${crypto.randomBytes(12).toString('hex')}`, type: 'message', role: 'assistant', model: body?.model ?? 'mock', content: reply.content, stop_reason: reply.stop_reason, stop_sequence: null, usage };
}

/* ---------------------------------- server ---------------------------------- */

export async function startMockServer(opts: MockOptions): Promise<MockServer> {
  const recs: MockRequestRecord[] = [];
  if (opts.logFile) fs.writeFileSync(opts.logFile, '');
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        const path = (req.url ?? '').split('?')[0];
        let body: any = null;
        const raw = Buffer.concat(chunks);
        if (raw.length) { try { body = JSON.parse(raw.toString('utf8')); } catch { body = { _unparsed: raw.toString('utf8').slice(0, 2000) }; } }
        const rec: MockRequestRecord = { ts: new Date().toISOString(), method: req.method ?? '', path, conversation: body ? conversationKey(body) : '', tool_results: body ? countToolResults(body) : 0, body };
        recs.push(rec);
        if (opts.logFile) fs.appendFileSync(opts.logFile, JSON.stringify(rec) + '\n');
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        if (req.method === 'POST' && path === '/v1/messages/count_tokens') {
          const n = countTokens(JSON.stringify(body?.system ?? '') + JSON.stringify(body?.messages ?? []) + JSON.stringify(body?.tools ?? []));
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: n }));
          return;
        }
        if (req.method === 'POST' && path === '/v1/messages') {
          const policy = typeof opts.policy === 'function' ? opts.policy(rec.conversation) : opts.policy;
          if (policy.kind === 'fault') {
            res.writeHead(policy.status, { 'content-type': 'application/json', 'retry-after': '0', 'x-should-retry': 'false' }).end(JSON.stringify({ type: 'error', error: { type: policy.error_type, message: policy.message } }));
            return;
          }
          const reply = buildReply(body, policy);
          const usage = mockUsage(body, reply);
          if (body?.stream) {
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }).end(sseEvents(body, reply, usage));
          } else {
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(jsonMessage(body, reply, usage)));
          }
          return;
        }
        if (req.method === 'GET' && path.startsWith('/v1/models')) {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [], has_more: false, first_id: null, last_id: null }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      })().catch((e) => { try { res.writeHead(500).end(String(e)); } catch { /* ignore */ } });
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  ownPorts.add(port);
  return {
    url: `http://127.0.0.1:${port}`, port,
    paths: () => recs.map((r) => `${r.method} ${r.path}`),
    requests: () => recs,
    close: () => new Promise<void>((resolve) => { ownPorts.delete(port); server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
