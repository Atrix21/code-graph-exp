/**
 * Experiment 2: stdio MCP server exposing ONE retrieval method of experiment 1 as a single tool, `search_code`.
 *
 *   npx tsx src/agent-eval/mcp/retrieval-server.ts --method <hybrid|custom_graph|embeddings|bm25|ripgrep> \
 *       --workspace <abs dir> --budget <tokens> [--max-results 20] --log <abs jsonl path>
 *
 * Fairness properties:
 *  - the tool name, description and input schema are byte-identical for every method;
 *  - the method comes from REGISTRY, so the frozen experiment-1 configuration is used unchanged;
 *  - the tool result is the method's native `context` text for budget {maxResults, maxContextTokens: --budget};
 *  - stdout carries MCP protocol messages only (console.* is redirected to stderr).
 *
 * Start-up: the MCP transport is connected immediately (so the client's `initialize` is answered at once) and tool
 * calls wait for the method to finish preparing. "[ready]" with the prepare time is written to stderr when done.
 *
 * Embedding-based methods (embeddings, hybrid) embed queries with a persistent Python process
 * (scripts/embeddings/embed_server.py, same model/revision/fp16/instruction as embed.py) instead of spawning Python
 * per query. Document vectors come from the experiment-1 content-hash cache (.cache/embeddings/vectors.jsonl).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { abs, listCorpusFiles, loadConfig } from '../../config.js';
import { countTokens } from '../../evaluation/token-accounting.js';
import { REGISTRY } from '../../evaluation/methods.js';
import { EmbeddingRetriever, type QueryEmbedder } from '../../retrieval/embeddings.js';
import type { Corpus, RetrievalMethod } from '../../types.js';
import { workspaceHash } from '../workspace.js';

export const TOOL_NAME = 'search_code';
export const TOOL_DESCRIPTION =
  'Search this codebase for the code most relevant to a natural-language description, error message or identifier. Returns ranked code snippets with file paths and line numbers.';
export const TOOL_INPUT_SCHEMA = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } as const;
export const SERVER_METHODS = ['hybrid', 'custom_graph', 'embeddings', 'bm25', 'ripgrep'] as const;
export type ServerMethod = (typeof SERVER_METHODS)[number];

/* ------------------------- persistent query embedder ------------------------- */

/** Client for scripts/embeddings/embed_server.py (JSON lines over stdin/stdout). */
export class PersistentQueryEmbedder implements QueryEmbedder {
  private child!: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { resolve: (v: { vector: Float32Array; tokens: number }) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private seq = 0;
  private readyResolve!: (info: Record<string, unknown>) => void;
  private readyReject!: (e: Error) => void;
  readonly ready: Promise<Record<string, unknown>> = new Promise((res, rej) => { this.readyResolve = res; this.readyReject = rej; });
  private dead = false;
  constructor(private timeoutMs = 120_000) {
    const cfg = loadConfig();
    this.child = spawn(abs(cfg.embeddings.python), [abs('scripts/embeddings/embed_server.py'), '--model', cfg.embeddings.model, '--revision', cfg.embeddings.revision, '--max-seq', String(cfg.embeddings.max_seq)], {
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HF_HUB_OFFLINE: '1', TOKENIZERS_PARALLELISM: 'false' },
    });
    this.child.stderr.on('data', (d) => process.stderr.write(`[embed_server] ${d}`));
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => this.onLine(line));
    this.child.on('exit', (code, sig) => this.onExit(new Error(`embed_server exited (code ${code}, signal ${sig})`)));
    this.child.on('error', (e) => this.onExit(e));
    this.child.stdin.on('error', () => { /* surfaced via exit */ });
  }
  private onExit(err: Error) {
    this.dead = true;
    this.readyReject(err);
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(err); this.pending.delete(id); }
  }
  private onLine(line: string) {
    let d: any;
    try { d = JSON.parse(line); } catch { process.stderr.write(`[embed_server] non-JSON stdout line: ${line.slice(0, 200)}\n`); return; }
    if (d.ready) { this.readyResolve(d); return; }
    const p = this.pending.get(d.id);
    if (!p) return;
    this.pending.delete(d.id);
    clearTimeout(p.timer);
    if (d.error) p.reject(new Error(d.error));
    else p.resolve({ vector: Float32Array.from(d.vector), tokens: d.tokens });
  }
  embed(text: string, kind: 'query' | 'doc' = 'query'): Promise<{ vector: Float32Array; tokens: number }> {
    if (this.dead) return Promise.reject(new Error('embed_server is not running'));
    const id = String(++this.seq);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('embed_server request timed out')); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, text, kind }) + '\n');
    });
  }
  embedQuery(text: string) { return this.embed(text, 'query'); }
  close() {
    this.dead = true;
    try { this.child.stdin.end(); } catch { /* ignore */ }
    setTimeout(() => this.child.kill('SIGKILL'), 2000).unref();
  }
}

/** Compare server-computed query vectors with the experiment-1 path (embed.py, one batch, content-hash cache). */
export async function embeddingConsistency(queries: string[], scratchCacheDir: string): Promise<{ query: string; cosine: number; tokens_server: number; tokens_cached: number }[]> {
  const { Embedder } = await import('../../retrieval/embeddings.js');
  // Reference first (embed.py exits when done) so only one model copy is on the GPU at a time.
  const ref = new Embedder(scratchCacheDir).embed(queries.map((q, i) => ({ id: `q${i}`, text: q, kind: 'query' as const })));
  const srv = new PersistentQueryEmbedder();
  try {
    await srv.ready;
    const out = [];
    for (let i = 0; i < queries.length; i++) {
      const s = await srv.embedQuery(queries[i]);
      const r = ref.vectors.get(`q${i}`)!;
      let dot = 0, na = 0, nb = 0;
      for (let k = 0; k < r.length; k++) { dot += r[k] * s.vector[k]; na += r[k] * r[k]; nb += s.vector[k] * s.vector[k]; }
      out.push({ query: queries[i], cosine: dot / Math.sqrt(na * nb), tokens_server: s.tokens, tokens_cached: ref.tokens.get(`q${i}`)! });
    }
    return out;
  } finally { srv.close(); }
}

/* ------------------------------- the server ------------------------------- */

export interface ServerOptions { method: ServerMethod; workspace: string; budget: number; maxResults: number; logPath: string }

interface Prewarmable { prewarmQuery?(q: string): Promise<void> }

export async function runServer(o: ServerOptions): Promise<void> {
  // Protocol hygiene: nothing but MCP messages may reach stdout.
  console.log = console.error; console.info = console.error; console.debug = console.error;

  const cfg = loadConfig();
  const dir = path.resolve(o.workspace);
  const files = listCorpusFiles(dir, cfg.target.include_dirs);
  const hash = workspaceHash(dir, files);
  const cacheDir = path.join(abs(cfg.cache_dir), 'agent-ws', hash.slice(0, 12));
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(path.dirname(path.resolve(o.logPath)), { recursive: true });
  const corpus: Corpus = { repoRoot: dir, commit: hash.slice(0, 40), files, cacheDir };

  const t0 = performance.now();
  let embedder: PersistentQueryEmbedder | null = null;
  let method: RetrievalMethod | null = null;

  let readyResolve!: () => void, readyReject!: (e: Error) => void;
  const ready = new Promise<void>((res, rej) => { readyResolve = res; readyReject = rej; });
  ready.catch(() => { setTimeout(() => process.exit(1), 200); });
  const prepare = async () => {
    if (o.method === 'embeddings' || o.method === 'hybrid') {
      embedder = new PersistentQueryEmbedder();
      EmbeddingRetriever.defaultQueryEmbedder = embedder;
      EmbeddingRetriever.embeddingCacheDir = path.join(abs(cfg.cache_dir), 'embeddings'); // experiment-1 vector cache
    }
    const m = await REGISTRY[o.method]();
    const stats = await m.prepare(corpus);
    if (embedder) await embedder.ready;
    method = m;
    const ms = performance.now() - t0;
    process.stderr.write(`[ready] method=${o.method} files=${files.length} workspace_hash=${hash.slice(0, 12)} prepare_ms=${ms.toFixed(0)} index_ms=${stats.index_ms.toFixed(0)}\n`);
  };

  const server = new Server({ name: 'code-search', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: TOOL_NAME, description: TOOL_DESCRIPTION, inputSchema: TOOL_INPUT_SCHEMA as unknown as { type: 'object'; properties: Record<string, unknown>; required: string[] } }],
  }));

  let chain: Promise<unknown> = Promise.resolve(); // serialise calls: methods keep per-query mutable caches
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const run = async () => {
      if (req.params.name !== TOOL_NAME) return { isError: true, content: [{ type: 'text' as const, text: `Unknown tool: ${req.params.name}` }] };
      const query = (req.params.arguments as { query?: unknown } | undefined)?.query;
      if (typeof query !== 'string' || !query.trim()) return { isError: true, content: [{ type: 'text' as const, text: 'Invalid arguments: "query" must be a non-empty string.' }] };
      try { await ready; } catch (e) { return { isError: true, content: [{ type: 'text' as const, text: `Search index failed to initialise: ${(e as Error).message}` }] }; }
      const ts = new Date().toISOString();
      const t = performance.now();
      try {
        const m = method!;
        await (m as unknown as Prewarmable).prewarmQuery?.(query);
        const out = await m.retrieve({ task_id: 'agent', query }, { maxResults: o.maxResults, maxContextTokens: o.budget });
        const text = out.context && out.context.trim() ? out.context : 'No results.';
        const latency = performance.now() - t;
        const line = {
          ts, query, latency_ms: Math.round(latency * 10) / 10, result_tokens: countTokens(text), n_results: out.results.length,
          top_results: out.results.slice(0, 10).map((r) => ({ file: r.file, symbol: r.symbol, start_line: r.start_line })),
        };
        fs.appendFileSync(o.logPath, JSON.stringify(line) + '\n');
        return { content: [{ type: 'text' as const, text }] };
      } catch (e) {
        fs.appendFileSync(o.logPath, JSON.stringify({ ts, query, latency_ms: Math.round((performance.now() - t) * 10) / 10, error: (e as Error).message }) + '\n');
        return { isError: true, content: [{ type: 'text' as const, text: `Search failed: ${(e as Error).message}` }] };
      }
    };
    const p = chain.then(run, run);
    chain = p.catch(() => undefined);
    return p;
  });

  const shutdown = () => { try { embedder?.close(); } catch { /* ignore */ } try { void method?.close?.(); } catch { /* ignore */ } };
  server.onclose = () => { shutdown(); setTimeout(() => process.exit(0), 100).unref(); };
  process.on('SIGTERM', () => { shutdown(); process.exit(0); });
  process.on('SIGINT', () => { shutdown(); process.exit(0); });
  process.on('exit', shutdown);
  // The SDK's stdio transport does not notice a closed stdin: exit when the client goes away.
  process.stdin.on('end', () => { shutdown(); setTimeout(() => process.exit(0), 50).unref(); });
  process.stdin.on('close', () => { shutdown(); setTimeout(() => process.exit(0), 50).unref(); });
  await server.connect(new StdioServerTransport());
  process.stderr.write(`[listening] method=${o.method} budget=${o.budget} max_results=${o.maxResults}\n`);
  // Let the event loop answer `initialize` before the (synchronous, CPU-heavy) index preparation starts.
  await new Promise((r) => setTimeout(r, 20));
  prepare().then(readyResolve, (e) => {
    const err = e instanceof Error ? e : new Error(String(e));
    process.stderr.write(`[fatal] prepare failed: ${err.stack ?? err.message}\n`);
    readyReject(err);
  });
}

/* ---------------------------------- CLI ---------------------------------- */

function parseArgs(argv: string[]): ServerOptions {
  const g = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  const method = g('method') as ServerMethod | undefined;
  const workspace = g('workspace'), budget = g('budget'), log = g('log');
  if (!method || !(SERVER_METHODS as readonly string[]).includes(method)) throw new Error(`--method must be one of ${SERVER_METHODS.join('|')}`);
  if (!workspace || !path.isAbsolute(workspace)) throw new Error('--workspace <abs dir> is required');
  if (!budget || !(Number(budget) > 0)) throw new Error('--budget <tokens> is required');
  if (!log || !path.isAbsolute(log)) throw new Error('--log <abs jsonl path> is required');
  const maxResults = Number(g('max-results') ?? 20);
  if (!(maxResults > 0)) throw new Error('--max-results must be > 0');
  return { method, workspace, budget: Number(budget), maxResults, logPath: log };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let opts: ServerOptions;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { process.stderr.write(`${(e as Error).message}\n`); process.exit(2); }
  runServer(opts).catch((e) => { process.stderr.write(`[fatal] ${(e as Error).stack ?? e}\n`); process.exit(1); });
}
