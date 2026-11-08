/**
 * Experiment 2 MCP layer. Starts real servers (stdio) and talks to them with the official MCP client SDK.
 * No LLM or network is involved. Slow tests (model load, graph builds) carry explicit timeouts.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig } from '../../src/config.js';
import { countTokens } from '../../src/evaluation/token-accounting.js';
import { EmbeddingRetriever, type QueryEmbedder } from '../../src/retrieval/embeddings.js';
import { buildWorkspace, type Workspace } from '../../src/agent-eval/workspace.js';
import { competitorServerSpec } from '../../src/agent-eval/mcp/competitor-servers.js';
import { LEAK_PATTERN, ourServerLaunch } from '../../src/agent-eval/mcp/inspect-servers.js';
import { embeddingConsistency, TOOL_DESCRIPTION } from '../../src/agent-eval/mcp/retrieval-server.js';

const QUERY = 'JWT token verification rejects valid tokens so every request returns 401 Unauthorized';
const BUDGET = 3000;
const cfg = loadConfig();
let ws: Workspace;
let tmp: string;

beforeAll(() => {
  ws = buildWorkspace(cfg, 'base', 'mcp-test');
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
}, 120_000);
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

async function withClient<T>(launch: { command: string; args: string[]; env?: Record<string, string>; cwd?: string }, fn: (c: Client) => Promise<T>): Promise<T> {
  const t = new StdioClientTransport({ command: launch.command, args: launch.args, env: launch.env, cwd: launch.cwd, stderr: 'pipe' });
  const c = new Client({ name: 'vitest', version: '1' }, { capabilities: {} });
  await c.connect(t, { timeout: 120_000 });
  try { return await fn(c); } finally { await c.close().catch(() => undefined); }
}

const text = (r: any): string => (r.content ?? []).map((x: any) => x.text).join('\n');

describe('search_code server (ours)', () => {
  for (const method of ['bm25', 'ripgrep', 'custom_graph']) {
    it(`${method}: lists exactly one search_code tool, answers within budget and logs the call`, async () => {
      const log = path.join(tmp, `${method}.jsonl`);
      await withClient(ourServerLaunch(method, ws, BUDGET, 20, log), async (c) => {
        const tools = (await c.listTools()).tools;
        expect(tools.map((t) => t.name)).toEqual(['search_code']);
        expect(tools[0].description).toBe(TOOL_DESCRIPTION);
        expect(tools[0].inputSchema).toEqual({ type: 'object', properties: { query: { type: 'string' } }, required: ['query'] });

        const r = await c.callTool({ name: 'search_code', arguments: { query: QUERY } }, undefined, { timeout: 120_000 });
        expect(r.isError).toBeFalsy();
        const out = text(r);
        expect(out.length).toBeGreaterThan(0);
        expect(out).not.toBe('No results.');
        expect(countTokens(out)).toBeLessThanOrEqual(BUDGET);
        expect(out.match(LEAK_PATTERN) ?? []).toEqual([]);

        // deterministic: same query, same text
        expect(text(await c.callTool({ name: 'search_code', arguments: { query: QUERY } }))).toBe(out);

        const bad = await c.callTool({ name: 'search_code', arguments: { query: '' } });
        expect(bad.isError).toBe(true);
      });
      const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(lines).toHaveLength(2); // the invalid call is rejected before retrieval and not logged
      const l = lines[0];
      expect(Object.keys(l).sort()).toEqual(['latency_ms', 'n_results', 'query', 'result_tokens', 'top_results', 'ts']);
      expect(l.query).toBe(QUERY);
      expect(l.n_results).toBeGreaterThan(0);
      expect(l.result_tokens).toBeGreaterThan(0);
      expect(l.result_tokens).toBeLessThanOrEqual(BUDGET);
      expect(l.top_results.length).toBeLessThanOrEqual(10);
      expect(l.top_results[0]).toHaveProperty('file');
      expect(ws.files).toContain(l.top_results[0].file);
    }, 180_000);
  }

  for (const method of ['embeddings', 'hybrid']) it(`${method}: persistent query embedding serves results (document vectors from the experiment-1 cache)`, async () => {
    const log = path.join(tmp, `${method}-emb.jsonl`);
    await withClient(ourServerLaunch(method, ws, BUDGET, 20, log), async (c) => {
      const t0 = performance.now();
      const r = await c.callTool({ name: 'search_code', arguments: { query: QUERY } }, undefined, { timeout: 300_000 });
      expect(r.isError).toBeFalsy();
      expect(countTokens(text(r))).toBeLessThanOrEqual(BUDGET);
      const t1 = performance.now();
      const r2 = await c.callTool({ name: 'search_code', arguments: { query: 'where are refresh tokens issued' } }, undefined, { timeout: 60_000 });
      expect(r2.isError).toBeFalsy();
      // second query must not pay a model load (the embedding process is persistent)
      expect(performance.now() - t1).toBeLessThan(5_000);
      void t0;
    });
    expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(2);
  }, 300_000);
});

describe('pluggable query embedder (experiment-1 behaviour unchanged unless opted in)', () => {
  it('defaults to no embedder and no cache override', () => {
    expect(EmbeddingRetriever.defaultQueryEmbedder).toBeNull();
    expect(EmbeddingRetriever.embeddingCacheDir).toBeNull();
  });
  it('uses the configured embedder, and refuses to silently fall back to spawning Python', async () => {
    const calls: string[] = [];
    const fake: QueryEmbedder = { embedQuery: async (t) => { calls.push(t); return { vector: Float32Array.from([1, 0]), tokens: 3 }; } };
    EmbeddingRetriever.defaultQueryEmbedder = fake;
    try {
      const r = new EmbeddingRetriever();
      r.vecs = [Float32Array.from([1, 0]), Float32Array.from([0, 1])];
      expect(() => r.scoreAll('q')).toThrow(/prewarmQuery/);
      await r.prewarmQuery('q');
      await r.prewarmQuery('q');
      expect(calls).toEqual(['q']);
      expect(r.scoreAll('q')).toEqual([1, 0]);
    } finally { EmbeddingRetriever.defaultQueryEmbedder = null; }
  });
});

describe('embed_server.py vs experiment-1 embed.py', () => {
  it('query vectors agree (cosine >= 0.999)', async () => {
    const res = await embeddingConsistency([QUERY, 'AuthService.validateLogin'], path.join(tmp, 'embcheck'));
    for (const r of res) { expect(r.cosine).toBeGreaterThanOrEqual(0.999); expect(r.tokens_server).toBe(r.tokens_cached); }
  }, 300_000);
});

describe('competitor native MCP servers', () => {
  const before = () => spawnSync('git', ['-C', ws.dir, 'status', '--porcelain', '--ignored', '--untracked-files=all'], { encoding: 'utf8' }).stdout;

  it('graphify: builds a graph outside the workspace and serves a non-empty tool list', async () => {
    const state = before();
    const spec = await competitorServerSpec('graphify', ws);
    expect(before()).toBe(state);
    expect(spec.env).toMatchObject({ GRAPHIFY_NO_AUTO_REFRESH: '1', GRAPHIFY_BACKEND: 'none', GRAPHIFY_QUERY_LOG_DISABLE: '1' });
    expect(spec.build_ms).toBeGreaterThan(0);
    expect(spec.args).toContain('-u');
    await withClient({ command: spec.command, args: spec.args, env: spec.env, cwd: ws.dir }, async (c) => {
      const names = (await c.listTools()).tools.map((t) => t.name);
      expect(names.length).toBeGreaterThan(0);
      expect(names).toContain('query_graph');
      const r = await c.callTool({ name: 'query_graph', arguments: { question: QUERY } }, undefined, { timeout: 120_000 });
      expect(r.isError).toBeFalsy();
      expect(text(r).length).toBeGreaterThan(0);
      expect(text(r).match(LEAK_PATTERN) ?? []).toEqual([]);
    });
  }, 300_000);

  it('crg: builds a graph in CRG_DATA_DIR and serves a non-empty tool list', async () => {
    const state = before();
    const spec = await competitorServerSpec('crg', ws);
    expect(before()).toBe(state);
    expect(spec.env.CRG_DATA_DIR).toContain(path.join('agent-ws', ws.hash.slice(0, 12)));
    expect(fs.existsSync(path.join(spec.env.CRG_DATA_DIR, 'graph.db'))).toBe(true);
    await withClient({ command: spec.command, args: spec.args, env: spec.env, cwd: ws.dir }, async (c) => {
      const names = (await c.listTools()).tools.map((t) => t.name);
      expect(names.length).toBeGreaterThan(0);
      expect(names).toContain('semantic_search_nodes_tool');
      const r = await c.callTool({ name: 'semantic_search_nodes_tool', arguments: { query: QUERY } }, undefined, { timeout: 300_000 });
      expect(r.isError).toBeFalsy();
      expect(text(r).length).toBeGreaterThan(0);
      expect(text(r).match(LEAK_PATTERN) ?? []).toEqual([]);
    });
    expect(before()).toBe(state);
  }, 300_000);
});
