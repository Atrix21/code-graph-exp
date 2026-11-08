/**
 * Independent audit: can the agent reach anything outside its workspace (dataset, idx dir, node_modules symlink, git
 * history, the owner's Claude config) under the profile the protocol uses (`restricted-oauth`)?
 * Driven by the local MOCK Anthropic API (scripted tool calls); the real `claude` binary runs, but no model is called.
 * Skipped when `claude` is not installed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { abs, loadConfig } from '../../src/config.js';
import { conditionServer } from '../../src/agent-eval/agentic.js';
import { BillableGuard, buildClaudeCommand, parseStreamJson, runClaude } from '../../src/agent-eval/backends/claude-code.js';
import { FIXED_DIAGNOSIS, startMockServer } from '../../src/agent-eval/mock-anthropic/server.js';
import { buildWorkspace, checkWorkspaceIsolation } from '../../src/agent-eval/workspace.js';

const hasClaude = spawnSync('claude', ['--version']).status === 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-leak-'));
let cleanup: string | null = null;
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); if (cleanup) fs.rmSync(cleanup, { recursive: true, force: true }); });

describe.skipIf(!hasClaude)('AUDIT leakage: restricted-oauth profile, mock API, scripted probes (graphify condition: has an ../idx dir)', () => {
  it('every out-of-workspace probe is denied or empty; .git holds one neutral commit; init shows exactly the expected tools / MCP server / no skills', async () => {
    const cfg = loadConfig();
    const ws = buildWorkspace(cfg, 'auth_reset_sessions_01', 'audit-leak-test');
    cleanup = path.dirname(ws.dir);
    expect(checkWorkspaceIsolation(ws, cfg)).toEqual([]);
    // the corpus contains no symlinks; plant one to prove the tools would refuse to follow it anyway
    fs.symlinkSync(abs('evaluation/dataset'), path.join(ws.dir, 'link_out'));
    const mcp = await conditionServer('graphify', ws, { budget: 4000, logFile: path.join(tmp, 'ret.jsonl') });
    expect(fs.existsSync(path.join(path.dirname(ws.dir), 'idx', 'graphify-out', 'graph.json'))).toBe(true);
    const ccd = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
    const outside = [
      { tool: 'Read', input: { file_path: '../idx/graphify-out/graph.json' } },
      { tool: 'Read', input: { file_path: `${path.dirname(ws.dir)}/idx/graphify-out/graph.json` } },
      { tool: 'Read', input: { file_path: '../../node_modules/typescript/package.json' } },
      { tool: 'Read', input: { file_path: '/tmp/work/node_modules/typescript/package.json' } },
      { tool: 'Read', input: { file_path: '~/.claude/CLAUDE.md' } },
      { tool: 'Read', input: { file_path: path.join(ccd, 'CLAUDE.md') } },
      { tool: 'Read', input: { file_path: abs('evaluation/dataset/bugs/auth_reset_sessions_01.patch') } },
      { tool: 'Read', input: { file_path: 'link_out/tasks/auth_reset_sessions_01.json' } },
      { tool: 'Grep', input: { pattern: 'root_cause', path: '..' } },
      { tool: 'Grep', input: { pattern: 'root_cause', path: 'link_out' } },
      { tool: 'Grep', input: { pattern: 'secret', path: '/tmp/work' } },
      { tool: 'Glob', input: { pattern: '/tmp/work/*/app/src/auth/*.ts' } },
    ];
    const inside = [
      { tool: 'Read', input: { file_path: '.git/logs/HEAD' } },
      { tool: 'Glob', input: { pattern: '../../**/*.json' } },
      { tool: 'Glob', input: { pattern: 'link_out/**/*' } },
      { tool: 'Glob', input: { pattern: '**/*' } },
    ];
    const mock = await startMockServer({ policy: { kind: 'scripted', steps: [...outside, ...inside, { structured: FIXED_DIAGNOSIS }] } });
    try {
      const spec = buildClaudeCommand({ protocol: 'agentic', profile: 'restricted-oauth', model: 'claude-sonnet-5-5', cwd: ws.dir, mcp, mcpConfigPath: path.join(tmp, 'mcp.json'), mockUrl: mock.url, maxTurns: 60 });
      const r = await runClaude(spec, 'probe', { run_id: 'p', task_id: 't', condition: 'c', repeat: 0, model: 'm', workspace_hash: '' }, {
        guard: new BillableGuard({ protocol: 'agentic', conditions: ['x'], model: 'm', split: 'dev', max_total_usd: 1 }, { env: {} }), timeoutMs: 180_000,
      });
      const p = parseStreamJson(r.raw);
      const calls = new Map(p.toolCalls.map((c) => [c.id, c]));
      const results = p.toolResults.map((t) => ({ call: calls.get(t.tool_use_id)!, ...t })).filter((x) => x.call && x.call.name !== 'StructuredOutput');
      expect(results).toHaveLength(outside.length + inside.length);

      for (const x of results.slice(0, outside.length)) {
        expect(x.is_error, `${x.call.name} ${JSON.stringify(x.call.input)} must be denied: ${x.text.slice(0, 120)}`).toBe(true);
        expect(x.text).toMatch(/outside|resolves through a symlink/);
        expect(x.text).not.toMatch(/root_cause|secretOrKey|"nodes"/); // no file content
      }
      const [gitlog, upGlob, linkGlob, glob] = results.slice(outside.length).map((x) => x.text);
      expect(gitlog.match(/commit \(/g)).toHaveLength(1); // exactly one reflog entry: no history to diff against
      expect(gitlog).toMatch(/commit \(initial\): initial/);
      expect(gitlog).toMatch(/dev <dev@localhost>/);
      expect(upGlob).toMatch(/No files found/);
      expect(linkGlob).toMatch(/No files found/);
      expect(glob).not.toMatch(/idx\/|link_out|node_modules|evaluation|\.patch/);

      // what the model is offered (the isolation fingerprint the first real run must reproduce)
      expect([...p.init.tools].sort()).toEqual(['Glob', 'Grep', 'Read', 'StructuredOutput', 'mcp__graphify__get_community', 'mcp__graphify__get_neighbors', 'mcp__graphify__get_node', 'mcp__graphify__god_nodes', 'mcp__graphify__graph_stats', 'mcp__graphify__query_graph', 'mcp__graphify__shortest_path'].sort());
      expect(p.init.mcp_servers.map((m: any) => `${m.name}:${m.status}`)).toEqual(['graphify:connected']);
      expect(p.init.skills).toEqual([]);
      expect(p.init.slash_commands).toEqual([]);
      expect(p.init.plugins.every((pl: any) => pl.path === 'builtin')).toBe(true);
      // no request ever carried the owner's instructions
      // (first agent request only: later requests echo the probes' own paths)
      const first = mock.requests().find((q) => q.path === '/v1/messages' && q.body?.tools?.length)!;
      const sent = JSON.stringify({ system: first.body.system, tools: first.body.tools, messages: first.body.messages });
      for (const needle of ['adityareddy', 'any input to knowledge graph', "user's private global instructions", 'code-graphs']) expect(sent.includes(needle), needle).toBe(false);
    } finally { await mock.close(); }
  }, 180_000);
});
