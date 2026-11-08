/**
 * Experiment 2: inspect every MCP server an agent condition can use (no LLM involved).
 *
 *   npx tsx src/agent-eval/mcp/inspect-servers.ts [--budget 4000] [--max-results 20] [--skip-embed-check] [--out <json>]
 *
 * For each of {our search_code server for hybrid, custom_graph, embeddings, bm25; Graphify native; CRG native}, on the
 * workspaces of task `auth_jwt_secret_01` and `base`: start the server, `initialize`, `tools/list`, one `tools/call` with
 * a fixed sample query (twice: cold and warm), and record start-up time, tool names and the proxy-token size of the
 * tools/list payload (tool schemas are sent to the model on every turn). Also measures the cosine similarity between
 * query vectors from the persistent embedding process and from the experiment-1 batch path.
 * Writes experiments/02-agent-diagnosis/results/mcp-inspection.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { abs, loadConfig, PROJECT_ROOT } from '../../config.js';
import { countTokens, TOKENIZER_ID } from '../../evaluation/token-accounting.js';
import { buildWorkspace, type Workspace } from '../workspace.js';
import { competitorServerSpec } from './competitor-servers.js';
import { embeddingConsistency } from './retrieval-server.js';

export const SAMPLE_QUERY = 'Users get 401 Unauthorized on every request after logging in; the JWT token verification seems to reject valid tokens';

export interface LaunchSpec { command: string; args: string[]; env?: Record<string, string>; cwd?: string }

export interface ProbeResult {
  server: string;
  workspace: string;
  launch: LaunchSpec;
  build_ms: number | null;
  /** spawn -> server ready to answer search calls (ours: "[ready]" on stderr; native: end of `initialize`). */
  startup_ms: number;
  /** spawn -> `initialize` response. */
  initialize_ms: number;
  server_info: unknown;
  tool_count: number;
  tool_names: string[];
  /** Proxy tokens (o200k_base) of [{name, description, input_schema}] for all tools = what the model is sent each turn. */
  tools_list_tokens: number;
  tools_list_payload_tokens: number;
  tool_tokens: Record<string, number>;
  sample: { tool: string; args: unknown; cold_latency_ms: number; warm_latency_ms: number; result_tokens: number; result_chars: number; is_error: boolean; preview: string };
  /** Matches of project/host path fragments in the sample call result (what the agent would read). Must be empty. */
  path_leak_hits: string[];
  stderr_tail: string;
}

/** Fragments that would disclose the experiment / host layout to the agent. */
export const LEAK_PATTERN = /code-graphs|experiments|adityareddy|\.cache\b|evaluation\/|\/home\//gi;

function toolTokens(tools: any[]) {
  const model = tools.map((t) => ({ name: t.name, description: t.description ?? '', input_schema: t.inputSchema }));
  const per: Record<string, number> = {};
  for (const t of model) per[t.name] = countTokens(JSON.stringify(t));
  return { total: countTokens(JSON.stringify(model)), payload: countTokens(JSON.stringify(tools)), per };
}

function resultText(r: any): string {
  return (r.content ?? []).map((c: any) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
}

/** Start `launch`, run initialize -> tools/list -> sample call (x2) and close. */
export async function probeServer(server: string, workspace: string, launch: LaunchSpec, sample: { tool: string; args: unknown }, opts: { build_ms?: number | null; waitReadyLine?: boolean } = {}): Promise<ProbeResult> {
  const transport = new StdioClientTransport({ command: launch.command, args: launch.args, env: launch.env, cwd: launch.cwd, stderr: 'pipe' });
  let stderr = '';
  let readyAt = 0;
  let resolveReady!: () => void;
  const readyLine = new Promise<void>((r) => { resolveReady = r; });
  const t0 = performance.now();
  transport.stderr?.on('data', (d: Buffer) => {
    const s = d.toString();
    stderr = (stderr + s).slice(-20000);
    if (!readyAt && /\[ready\]/.test(stderr)) { readyAt = performance.now(); resolveReady(); }
  });
  const client = new Client({ name: 'mcp-inspector', version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport, { timeout: 300_000 });
    const initialize_ms = performance.now() - t0;
    if (opts.waitReadyLine) {
      let timer: NodeJS.Timeout | undefined;
      try { await Promise.race([readyLine, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('server never became ready')), 600_000); })]); } finally { clearTimeout(timer); }
    }
    const startup_ms = opts.waitReadyLine ? readyAt - t0 : initialize_ms;
    const listed = await client.listTools(undefined, { timeout: 60_000 });
    const tt = toolTokens(listed.tools);
    const call = async () => {
      const t = performance.now();
      const r = await client.callTool({ name: sample.tool, arguments: sample.args as Record<string, unknown> }, undefined, { timeout: 600_000 });
      return { ms: performance.now() - t, text: resultText(r), isError: !!(r as any).isError };
    };
    const cold = await call();
    const warm = await call();
    return {
      server, workspace, launch: { command: launch.command, args: launch.args, env: launch.env }, build_ms: opts.build_ms ?? null,
      startup_ms: Math.round(startup_ms), initialize_ms: Math.round(initialize_ms), server_info: client.getServerVersion(),
      tool_count: listed.tools.length, tool_names: listed.tools.map((t) => t.name), tools_list_tokens: tt.total, tools_list_payload_tokens: tt.payload, tool_tokens: tt.per,
      sample: {
        tool: sample.tool, args: sample.args, cold_latency_ms: Math.round(cold.ms), warm_latency_ms: Math.round(warm.ms),
        result_tokens: countTokens(cold.text), result_chars: cold.text.length, is_error: cold.isError, preview: cold.text.slice(0, 400),
      },
      path_leak_hits: [...new Set([...(cold.text.match(LEAK_PATTERN) ?? [])])],
      stderr_tail: stderr.slice(-1500),
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

export function ourServerLaunch(method: string, ws: Workspace, budget: number, maxResults: number, logPath: string): LaunchSpec {
  return {
    command: abs('node_modules/.bin/tsx'),
    args: [abs('src/agent-eval/mcp/retrieval-server.ts'), '--method', method, '--workspace', ws.dir, '--budget', String(budget), '--max-results', String(maxResults), '--log', logPath],
    cwd: PROJECT_ROOT,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const g = (k: string, d?: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
  const budget = Number(g('budget', '4000')), maxResults = Number(g('max-results', '20'));
  const outPath = g('out', abs('experiments/02-agent-diagnosis/results/mcp-inspection.json'))!;
  const cfg = loadConfig();
  const logDir = path.join(abs(cfg.cache_dir), 'agent-ws', 'inspect-logs');
  fs.mkdirSync(logDir, { recursive: true });

  const results: ProbeResult[] = [];
  const failures: { server: string; workspace: string; error: string }[] = [];
  for (const taskId of ['auth_jwt_secret_01', 'base']) {
    const ws = buildWorkspace(cfg, taskId, 'mcp-inspect');
    const run = async (server: string, fn: () => Promise<ProbeResult>) => {
      process.stderr.write(`[inspect] ${server} on ${taskId} ...\n`);
      try { const r = await fn(); results.push(r); process.stderr.write(`[inspect]   startup ${r.startup_ms} ms, ${r.tool_count} tools, schema ${r.tools_list_tokens} tok, call ${r.sample.cold_latency_ms}/${r.sample.warm_latency_ms} ms, ${r.sample.result_tokens} tok\n`); }
      catch (e) { failures.push({ server, workspace: taskId, error: (e as Error).message }); process.stderr.write(`[inspect]   FAILED: ${(e as Error).message}\n`); }
    };
    for (const method of ['hybrid', 'custom_graph', 'embeddings', 'bm25']) {
      await run(`search_code:${method}`, () => probeServer(`search_code:${method}`, taskId, ourServerLaunch(method, ws, budget, maxResults, path.join(logDir, `${taskId}-${method}.jsonl`)), { tool: 'search_code', args: { query: SAMPLE_QUERY } }, { waitReadyLine: true }));
    }
    for (const kind of ['graphify', 'crg'] as const) {
      await run(kind === 'graphify' ? 'graphify-native' : 'crg-native', async () => {
        const spec = await competitorServerSpec(kind, ws);
        const sample = kind === 'graphify' ? { tool: 'query_graph', args: { question: SAMPLE_QUERY } } : { tool: 'semantic_search_nodes_tool', args: { query: SAMPLE_QUERY } };
        return probeServer(kind === 'graphify' ? 'graphify-native' : 'crg-native', taskId, { command: spec.command, args: spec.args, env: spec.env, cwd: ws.dir }, sample, { build_ms: spec.build_ms });
      });
    }
  }

  let embedding_consistency: unknown = null;
  if (!argv.includes('--skip-embed-check')) {
    process.stderr.write('[inspect] embedding consistency ...\n');
    const qs = [
      SAMPLE_QUERY,
      'Refresh token endpoint returns the same token pair twice and old sessions are never invalidated',
      'password reset link can be reused after the password was already changed',
      'AuthService.validateLogin',
      'TypeError: Cannot read properties of undefined (reading \'id\') at UsersService.findOne',
      'Social login creates a duplicate user when the email already exists in the database',
    ];
    const res = await embeddingConsistency(qs, path.join(abs(cfg.cache_dir), 'agent-ws', 'embcheck'));
    embedding_consistency = { reference: 'embed.py one-batch path (experiment 1 Embedder) vs embed_server.py one-at-a-time', min_cosine: Math.min(...res.map((r) => r.cosine)), results: res };
  }

  const out = { generated_at: new Date().toISOString(), tokenizer: TOKENIZER_ID, sample_query: SAMPLE_QUERY, our_server_budget: { maxResults, maxContextTokens: budget }, servers: results, failures, embedding_consistency };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
  process.stderr.write(`[inspect] wrote ${outPath}\n`);
  process.exit(failures.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { process.stderr.write(`${(e as Error).stack ?? e}\n`); process.exit(1); });
}
