import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import {
  assertBillablePlan, BillableGuard, BillableRefused, buildClaudeCommand, checkApproval, checkInit, classifyOutcome, claudeSingleShot, usageCost, DUMMY_API_KEY, mapStopReason, parseStreamJson, runClaude, sumModelUsage, toAgentRun,
} from '../../src/agent-eval/backends/claude-code.js';
import { shuffledPlan } from '../../src/agent-eval/agentic.js';
import { FIXED_DIAGNOSIS, startMockServer } from '../../src/agent-eval/mock-anthropic/server.js';

const FIX = path.join(__dirname, 'fixtures');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const hasClaude = spawnSync('claude', ['--version']).status === 0;

const baseEnv = { PATH: '/usr/bin', HOME: '/home/u', CLAUDE_CONFIG_DIR: '/home/u/.cfg', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', ANTHROPIC_AUTH_TOKEN: 'tok', CLAUDE_CODE_OAUTH_TOKEN: 'oat', ANTHROPIC_BASE_URL: 'https://evil.example', ANTHROPIC_API_KEY: 'sk-ant-real' };
const flagVal = (a: string[], f: string) => a[a.indexOf(f) + 1];

describe('buildClaudeCommand', () => {
  const agentic = (o: object = {}) => buildClaudeCommand({ protocol: 'agentic', profile: 'restricted-oauth', model: 'sonnet', cwd: '/tmp/work/x/app', baseEnv, mcpConfigPath: '/tmp/m.json', ...o });

  it('agentic restricted-oauth: read-only tools, strict MCP, restricted flags, schema, prompt from prompt.ts', () => {
    const c = agentic({ maxTurns: 25, maxBudgetUsd: 0.5 });
    expect(c.cwd).toBe('/tmp/work/x/app');
    expect(c.args).toEqual(expect.arrayContaining(['-p', '--restricted', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']));
    expect(flagVal(c.args, '--tools')).toBe('Read,Grep,Glob');
    expect(flagVal(c.args, '--allowedTools')).toBe('Read,Grep,Glob');
    expect(flagVal(c.args, '--max-turns')).toBe('25');
    expect(flagVal(c.args, '--max-budget-usd')).toBe('0.5');
    expect(flagVal(c.args, '--mcp-config')).toBe('/tmp/m.json');
    expect(JSON.parse(flagVal(c.args, '--settings'))).toEqual({ permissions: { blockReadsOutsideWorkingDirectories: true } });
    expect(JSON.parse(flagVal(c.args, '--json-schema')).required).toEqual(['candidates']);
    expect(flagVal(c.args, '--system-prompt')).toMatch(/senior software engineer diagnosing a bug/);
    expect(c.mcpConfig).toEqual({ path: '/tmp/m.json', json: '{"mcpServers":{}}' });
    expect(c.args.join(' ')).not.toMatch(/--bare|--safe-mode|--dangerously/);
  });

  it('attaches the condition MCP server and allows exactly its tools', () => {
    const c = agentic({ mcp: { name: 'retrieval', command: '/x/tsx', args: ['server.ts', '--method', 'hybrid'], env: { A: '1' } } });
    expect(flagVal(c.args, '--allowedTools')).toBe('Read,Grep,Glob,mcp__retrieval__*');
    expect(JSON.parse(c.mcpConfig.json).mcpServers.retrieval).toEqual({ type: 'stdio', command: '/x/tsx', args: ['server.ts', '--method', 'hybrid'], env: { A: '1' } });
  });

  it('denies write/network-capable MCP tools by exact name, allows the rest of the server', () => {
    const c = agentic({ mcp: { name: 'code-review-graph', command: 'x', args: [], denyTools: ['apply_refactor_tool', 'generate_wiki_tool'] } });
    expect(flagVal(c.args, '--allowedTools')).toBe('Read,Grep,Glob,mcp__code-review-graph__*');
    const denied = flagVal(c.args, '--disallowedTools').split(',');
    expect(denied).toEqual(expect.arrayContaining(['Bash', 'mcp__code-review-graph__apply_refactor_tool', 'mcp__code-review-graph__generate_wiki_tool']));
    expect(JSON.parse(c.mcpConfig.json).mcpServers['code-review-graph'].denyTools).toBeUndefined();
  });

  it('single-shot: no tools, schema, no MCP servers even if one is passed', () => {
    const c = buildClaudeCommand({ protocol: 'single_shot', profile: 'restricted-oauth', model: 'sonnet', cwd: '/tmp/s', baseEnv, mcp: { name: 'r', command: 'x', args: [] }, mcpConfigPath: '/tmp/m.json' });
    expect(c.args[c.args.indexOf('--tools') + 1]).toBe('');
    expect(c.args).not.toContain('--allowedTools');
    expect(c.mcpConfig.json).toBe('{"mcpServers":{}}');
    expect(flagVal(c.args, '--system-prompt')).toMatch(/JSON only/);
    expect(flagVal(c.args, '--max-turns')).toBe('3');
  });

  it('profiles map to the right mode flag', () => {
    expect(agentic({ profile: 'bare', mockUrl: 'http://127.0.0.1:1' }).args).toContain('--bare');
    expect(agentic({ profile: 'safe-mode' }).args).toContain('--safe-mode');
  });

  it('env is a whitelist: nothing from the calling Claude session leaks; isolation vars are set', () => {
    const c = agentic();
    expect(c.env.CLAUDECODE).toBeUndefined();
    expect(c.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(c.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(c.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(c.env.ANTHROPIC_API_KEY).toBeUndefined(); // OAuth profile: a stray API key must not take over
    expect(c.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oat'); // setup-token logins are allowed through
    expect(c.env.CLAUDE_CONFIG_DIR).toBe('/home/u/.cfg');
    expect(c.env).toMatchObject({ CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1', ENABLE_CLAUDEAI_MCP_SERVERS: 'false' });
    expect(c.mock).toBe(false);
  });

  it('mock mode: localhost base URL + dummy key, no tokens; non-local mock URL rejected', () => {
    const c = agentic({ mockUrl: 'http://127.0.0.1:4567' });
    expect(c.env).toMatchObject({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:4567', ANTHROPIC_API_KEY: DUMMY_API_KEY });
    expect(c.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(c.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(c.mock).toBe(true);
    expect(() => agentic({ mockUrl: 'https://api.anthropic.com' })).toThrow(/localhost/);
  });

  it("'bare' needs a real API key outside mock mode", () => {
    expect(() => buildClaudeCommand({ protocol: 'agentic', profile: 'bare', model: 'sonnet', cwd: '/x', baseEnv: { PATH: '/usr/bin' } })).toThrow(/ANTHROPIC_API_KEY/);
    const c = buildClaudeCommand({ protocol: 'agentic', profile: 'bare', model: 'sonnet', cwd: '/x', baseEnv });
    expect(c.env.ANTHROPIC_API_KEY).toBe('sk-ant-real');
  });

  it('is deterministic', () => {
    expect(JSON.stringify(agentic())).toBe(JSON.stringify(agentic()));
  });
});

describe('stream-json parser (recorded fixtures from the mock API)', () => {
  const read = (n: string) => fs.readFileSync(path.join(FIX, n), 'utf8');
  const meta = { run_id: 'r', task_id: 't', condition: 'agentic:baseline', repeat: 0, model: 'sonnet', workspace_hash: 'h' };

  it('agentic success: usage with cache separated, cost, turns, tool calls without StructuredOutput', () => {
    const p = parseStreamJson(read('stream-agentic-success.jsonl'));
    expect(p.init.tools).toContain('StructuredOutput');
    const { run, detail } = toAgentRun(p, meta, { latency_ms: 10, mock: true });
    expect(run.stop_reason).toBe('submitted');
    expect(run.diagnosis?.candidates[0].file).toBe('src/auth/auth.service.ts');
    expect(run.backend).toBe('claude-code-mock');
    expect(run.usage_source).toBe('api-reported');
    expect(run.usage!.cache_read).toBeGreaterThan(1000);
    expect(run.usage!.cache_write).toBeGreaterThan(1000);
    expect(run.usage!.input).toBeLessThan(100);
    expect(run.cost_usd).toBeGreaterThan(0);
    expect(run.turns).toBe(p.result.num_turns);
    expect(run.tool_calls.StructuredOutput).toBeUndefined();
    expect(run.tool_calls.Grep).toBeGreaterThanOrEqual(1);
    expect(run.retrieval_calls).toBe(0);
    expect(detail.permission_denials.length).toBeGreaterThan(0);
    expect(detail.tool_denials_text.join('\n')).toMatch(/--restricted confines the file tools/);
  });

  it('max turns: subtype error_max_turns -> stop_reason max_turns, no diagnosis', () => {
    const p = parseStreamJson(read('stream-max-turns.jsonl'));
    expect(p.result.subtype).toBe('error_max_turns');
    const { run } = toAgentRun(p, meta, { latency_ms: 1, mock: true });
    expect(run.stop_reason).toBe('max_turns');
    expect(run.diagnosis).toBeNull();
    expect(run.usage).not.toBeNull();
  });

  it('single-shot fixture has structured_output', () => {
    const p = parseStreamJson(read('stream-single-shot.jsonl'));
    expect(p.result.structured_output).toBeTruthy();
    expect(toAgentRun(p, meta, { latency_ms: 1, mock: true }).run.diagnosis).not.toBeNull();
  });

  it('counts mcp__ calls as retrieval calls and sums modelUsage across models', () => {
    const lines = [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'mcp__retrieval__search_code', input: { query: 'q' } }, { type: 'tool_use', id: 'b', name: 'Read', input: {} }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'mcp__retrieval__search_code', input: {} }, { type: 'tool_use', id: 'c', name: 'mcp__graphify__query_graph', input: {} }, { type: 'tool_use', id: 'd', name: 'StructuredOutput', input: {} }] } },
      { type: 'result', subtype: 'success', is_error: false, num_turns: 3, total_cost_usd: 0.5, result: '```json\n{"candidates":[{"file":"a.ts","symbol":"f","explanation":"e"}]}\n```',
        usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
        modelUsage: { m1: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40, costUSD: 0.3 }, m2: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 1, cacheCreationInputTokens: 1, costUSD: 0.2 } } },
    ].map((x) => JSON.stringify(x)).join('\n');
    const { run, detail } = toAgentRun(parseStreamJson(lines), meta, { latency_ms: 1, mock: false });
    expect(run.retrieval_calls).toBe(2); // 'a' deduplicated by id
    expect(run.tool_calls).toEqual({ 'mcp__retrieval__search_code': 1, Read: 1, 'mcp__graphify__query_graph': 1 });
    expect(run.usage).toEqual({ input: 11, output: 21, cache_read: 31, cache_write: 41 });
    expect(detail.usage_result).toEqual({ input: 1, output: 2, cache_read: 3, cache_write: 4 });
    expect(run.diagnosis?.candidates[0].symbol).toBe('f'); // lenient parse of fenced `result` text
    expect(run.backend).toBe('claude-code');
    expect(sumModelUsage({})).toBeNull();
  });

  it('no result event -> error with the exit info; timeout wins over everything', () => {
    const p = parseStreamJson('{"type":"system","subtype":"init","tools":[]}\nnot json\n');
    expect(p.badLines).toBe(1);
    const { run } = toAgentRun(p, meta, { latency_ms: 1, mock: false, exit_code: 1, stderr: 'boom' });
    expect(run.stop_reason).toBe('error');
    expect(run.parse_error).toMatch(/no result event \(exit 1\): boom/);
    expect(run.usage).toBeNull();
    expect(run.usage_source).toBe('unavailable');
    expect(mapStopReason({ subtype: 'success', is_error: false }, true, true)).toBe('timeout');
    expect(mapStopReason({ subtype: 'error_max_budget_usd' }, false, false)).toBe('budget');
    expect(mapStopReason({ subtype: 'success', is_error: false }, false, false)).toBe('no_structured_output');
  });

  it('list-price recomputation (Sonnet 2/10/0.20/2.50, Haiku, Opus; unknown models priced as Opus)', () => {
    const u = { input: 1e6, output: 1e6, cache_read: 1e6, cache_write: 1e6 };
    expect(usageCost(u, 'claude-sonnet-5-5')).toBeCloseTo(2 + 10 + 0.2 + 2.5);
    expect(usageCost(u, 'claude-haiku-5-5')).toBeCloseTo(0.1 + 0.5 + 0.01 + 0.125);
    expect(usageCost(u, 'claude-opus-5-5')).toBeCloseTo(4 + 20 + 0.2 + 5);
    expect(usageCost(u, 'mystery')).toBeCloseTo(4 + 20 + 0.2 + 5);
  });
});

describe('init fingerprint (F-03)', () => {
  const base = { tools: ['Glob', 'Grep', 'Read', 'StructuredOutput'], mcp_servers: [] as any[], model: 'claude-sonnet-5-5', skills: [], slash_commands: [], plugins: [{ name: 'cc-plugin-privacy', path: 'builtin' }], permissionMode: 'dontAsk', claude_code_version: '2.1.319' };
  const exp = { mcp: null, model: 'claude-sonnet-5-5', version: '2.1.319', mock: true };
  const crg = { name: 'code-review-graph', command: 'x', args: [], denyTools: ['apply_refactor_tool'] };
  it('accepts the expected baseline', () => { expect(checkInit(base, exp).categories).toEqual([]); });
  it('flags extra tools, skills, non-builtin plugins, model, version, mcp servers', () => {
    const m = checkInit({ ...base, tools: [...base.tools, 'Bash', 'Skill'], skills: ['x'], plugins: [{ name: 'p', path: '/x' }], model: 'claude-opus-4-1', claude_code_version: '9', mcp_servers: [{ name: 'claude.ai Docs', status: 'connected' }] }, exp);
    expect(m.categories).toEqual(['extra_tool', 'mcp_servers', 'model', 'plugins', 'skills', 'version']);
    expect(m.details.join('\n')).toMatch(/unexpected tool: Bash/);
  });
  it('flags a missing expected tool and a denied MCP tool; accepts exactly the allowed set', () => {
    expect(checkInit({ ...base, tools: ['Glob', 'Grep', 'StructuredOutput'] }, exp).categories).toEqual(['missing_tool']);
    const names = ['get_minimal_context_tool', 'query_graph_tool'];
    const ok = { ...base, tools: [...base.tools, ...['get_minimal_context_tool', 'get_impact_radius_tool', 'query_graph_tool', 'get_review_context_tool', 'semantic_search_nodes_tool', 'list_graph_stats_tool', 'get_docs_section_tool', 'find_large_functions_tool', 'list_flows_tool', 'get_flow_tool', 'get_affected_flows_tool', 'list_communities_tool', 'get_community_tool', 'get_architecture_overview_tool', 'detect_changes_tool', 'refactor_tool', 'get_wiki_page_tool', 'get_hub_nodes_tool', 'get_bridge_nodes_tool', 'get_knowledge_gaps_tool', 'get_surprising_connections_tool', 'get_suggested_questions_tool', 'traverse_graph_tool'].map((t) => `mcp__code-review-graph__${t}`)], mcp_servers: [{ name: 'code-review-graph', status: 'connected' }] };
    expect(checkInit(ok, { ...exp, mcp: crg }).categories).toEqual([]);
    expect(checkInit({ ...ok, tools: [...ok.tools, 'mcp__code-review-graph__apply_refactor_tool'] }, { ...exp, mcp: crg }).categories).toEqual(['denied_mcp_tool']);
    expect(checkInit({ ...ok, mcp_servers: [{ name: 'code-review-graph', status: 'pending' }] }, { ...exp, mcp: crg }).categories).toEqual(['mcp_not_connected']);
    void names;
  });
  it('in real mode an API-key auth source is a mismatch', () => {
    expect(checkInit({ ...base, apiKeySource: 'ANTHROPIC_API_KEY' }, { ...exp, mock: false }).categories).toEqual(['api_key_source']);
    expect(checkInit({ ...base, apiKeySource: 'ANTHROPIC_API_KEY' }, exp).categories).toEqual([]);
  });
});

describe('outcome classification (F-04)', () => {
  const P = (result: any) => ({ init: {}, result, toolCalls: [], toolResults: [], assistantMessages: 0, lastStructured: undefined, badLines: 0, messageUsage: new Map() });
  const c = (o: object = {}) => ({ exitCode: 0, timedOut: false, hasDiagnosis: true, ...o });
  it('agent outcomes are scored; infrastructure failures are not', () => {
    expect(classifyOutcome(P({ subtype: 'success', is_error: false }), c()).status).toBe('submitted');
    expect(classifyOutcome(P({ subtype: 'success', is_error: false }), c({ hasDiagnosis: false })).status).toBe('no_structured_output');
    expect(classifyOutcome(P({ subtype: 'error_max_turns', is_error: true }), c({ hasDiagnosis: false })).status).toBe('max_turns');
    expect(classifyOutcome(P({ subtype: 'error_max_budget_usd', is_error: true }), c({ hasDiagnosis: false })).status).toBe('budget');
    expect(classifyOutcome(P(null), c({ exitCode: 1, hasDiagnosis: false }))).toMatchObject({ status: 'infra_error', infra_kind: 'crash' });
    expect(classifyOutcome(P(null), c({ hasDiagnosis: false }))).toMatchObject({ status: 'infra_error', infra_kind: 'no_result' });
    expect(classifyOutcome(P({ subtype: 'success', is_error: false }), c({ timedOut: true }))).toMatchObject({ status: 'infra_error', infra_kind: 'timeout' });
    expect(classifyOutcome(P({ subtype: 'success', is_error: true, result: "You've hit your usage limit. Resets at 9pm." }), c({ hasDiagnosis: false }))).toMatchObject({ status: 'infra_error', infra_kind: 'limit' });
    expect(classifyOutcome(P({ subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login' }), c({ hasDiagnosis: false }))).toMatchObject({ infra_kind: 'auth' });
    expect(classifyOutcome(P({ subtype: 'success', is_error: true, result: 'API Error: 529 overloaded' }), c({ hasDiagnosis: false }))).toMatchObject({ infra_kind: 'api_error' });
    expect(classifyOutcome(P({ subtype: 'success', is_error: false }), c({ initMismatch: 'extra_tool' }))).toMatchObject({ status: 'init_mismatch', reason: 'extra_tool' });
  });
});

describe('run order (F-16)', () => {
  it('seeded shuffle: deterministic, a permutation, interleaves conditions, positions recorded', () => {
    const a = shuffledPlan(['t1', 't2', 't3'], ['baseline', 'hybrid', 'crg'], 2);
    const b = shuffledPlan(['t1', 't2', 't3'], ['baseline', 'hybrid', 'crg'], 2);
    expect(a).toEqual(b);
    expect(a).toHaveLength(18);
    expect(new Set(a.map((x) => x.run_id)).size).toBe(18);
    expect(a.map((x) => x.position)).toEqual([...Array(18).keys()]);
    expect(a.slice(0, 6).map((x) => x.condition)).not.toEqual(['baseline', 'baseline', 'hybrid', 'hybrid', 'crg', 'crg']);
    expect(shuffledPlan(['t1', 't2', 't3'], ['baseline', 'hybrid', 'crg'], 2, 1).map((x) => x.run_id)).not.toEqual(a.map((x) => x.run_id));
  });
});

describe('approval gate', () => {
  const req = { protocol: 'agentic' as const, conditions: ['baseline', 'hybrid'], model: 'sonnet', split: 'dev', max_total_usd: 10 };
  const write = (name: string, v: unknown) => { const p = path.join(tmp, name); fs.writeFileSync(p, JSON.stringify(v)); return p; };
  const guard = (approvalPath: string, env: NodeJS.ProcessEnv, ledger = path.join(tmp, `ledger-${Math.random()}.jsonl`)) => new BillableGuard(req, { approvalPath, env, ledgerPath: ledger, runUsd: 0.5 });
  const realEnv = { PATH: '/usr/bin' }; // no ANTHROPIC_BASE_URL => would hit the real API

  it('refuses without APPROVAL.json', () => {
    const g = guard(path.join(tmp, 'missing.json'), { AGENT_EVAL_BILLABLE: '1' });
    expect(() => g.assertAllowed(realEnv)).toThrow(/no approval file/);
    expect(checkApproval(req, path.join(tmp, 'missing.json')).ok).toBe(false);
  });

  it('refuses without AGENT_EVAL_BILLABLE=1 even with a covering approval', () => {
    const p = write('ok.json', { approvals: [{ protocol: 'agentic', conditions: ['agentic:baseline', 'hybrid'], model: 'sonnet', split: 'dev', max_total_usd: 20 }] });
    expect(() => guard(p, {}).assertAllowed(realEnv)).toThrow(/AGENT_EVAL_BILLABLE/);
    expect(guard(p, { AGENT_EVAL_BILLABLE: '1' }).assertAllowed(realEnv)).toBe(false);
  });

  it('refuses when the approval does not cover protocol / condition / model / split / cap', () => {
    const entry = { protocol: 'agentic', conditions: ['baseline', 'hybrid'], model: 'sonnet', split: 'dev', max_total_usd: 10 };
    expect(checkApproval(req, write('a.json', entry)).ok).toBe(true);
    expect(checkApproval({ ...req, protocol: 'single_shot' }, write('b.json', entry)).reason).toMatch(/protocol/);
    expect(checkApproval({ ...req, conditions: ['baseline', 'crg'] }, write('c.json', entry)).reason).toMatch(/conditions not approved: crg/);
    expect(checkApproval({ ...req, model: 'opus' }, write('d.json', entry)).reason).toMatch(/model/);
    expect(checkApproval({ ...req, split: 'test' }, write('e.json', entry)).reason).toMatch(/split/);
    expect(checkApproval({ ...req, max_total_usd: 11 }, write('f.json', entry)).reason).toMatch(/cap/);
    expect(checkApproval({ ...req, split: 'test' }, write('g.json', { ...entry, split: 'all' })).ok).toBe(true);
  });

  it('stops starting runs once the recorded total reaches the cap', () => {
    const p = write('cap.json', { protocol: 'agentic', conditions: '*', model: '*', split: 'all', max_total_usd: 1 });
    const ledger = path.join(tmp, 'cap-ledger.jsonl');
    const mk = () => new BillableGuard({ ...req, max_total_usd: 1 }, { approvalPath: p, env: { AGENT_EVAL_BILLABLE: '1' }, ledgerPath: ledger, runUsd: 0.2 });
    const g = mk();
    expect(g.assertAllowed(realEnv)).toBe(false);
    g.record('r1', 0.6, realEnv); // releases its reservation
    expect(g.inFlight).toBe(0);
    expect(g.assertAllowed(realEnv)).toBe(false); // reserves 0.2
    expect(g.remaining(realEnv)).toBeCloseTo(0.2); // 1 - 0.6 spent - 0.2 in flight
    g.record('r2', 0.5, realEnv);
    expect(() => g.assertAllowed(realEnv)).toThrow(/cost cap/); // 1.1 spent
    expect(() => mk().assertAllowed(realEnv)).toThrow(/cost cap/); // persists across invocations
  });

  it('billable runs need --run-usd, reserve it per run in flight, and refuse any other profile or an alias model', () => {
    const p = write('res.json', { protocol: 'agentic', conditions: '*', model: '*', split: 'all', max_total_usd: 1 });
    const noRun = new BillableGuard({ ...req, max_total_usd: 1 }, { approvalPath: p, env: { AGENT_EVAL_BILLABLE: '1' }, ledgerPath: path.join(tmp, 'nr.jsonl') });
    expect(() => noRun.assertAllowed(realEnv)).toThrow(/--run-usd/);
    const g = new BillableGuard({ ...req, max_total_usd: 1 }, { approvalPath: p, env: { AGENT_EVAL_BILLABLE: '1' }, ledgerPath: path.join(tmp, 'rs.jsonl'), runUsd: 0.4 });
    g.assertAllowed(realEnv); g.assertAllowed(realEnv); // 2 x 0.4 in flight
    expect(() => g.assertAllowed(realEnv)).toThrow(/cost cap/); // 3 x 0.4 > 1
    g.release(realEnv);
    expect(g.assertAllowed(realEnv)).toBe(false);
    expect(() => assertBillablePlan({ profile: 'bare', model: 'claude-sonnet-5-5' })).toThrow(/restricted-oauth/);
    expect(() => assertBillablePlan({ profile: 'safe-mode', model: 'claude-sonnet-5-5' })).toThrow(/restricted-oauth/);
    expect(() => assertBillablePlan({ profile: 'restricted-oauth', model: 'sonnet' })).toThrow(/pinned model id/);
    expect(() => assertBillablePlan({ profile: 'restricted-oauth', model: 'claude-sonnet-5-5', injected: 'Bash' })).toThrow(/mock mode only/);
    expect(() => assertBillablePlan({ profile: 'restricted-oauth', model: 'claude-sonnet-5-5' })).not.toThrow();
  });

  it('mock mode bypasses the gate only for a mock server started by THIS process, with the dummy key and no tokens', async () => {
    const g = guard(path.join(tmp, 'missing.json'), {});
    const mock = await startMockServer({ policy: { kind: 'echo-structured' } });
    try {
      expect(g.assertAllowed({ ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: DUMMY_API_KEY })).toBe(true);
      expect(() => g.assertAllowed({ ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: 'sk-ant-real' })).toThrow(/dummy/);
      expect(() => g.assertAllowed({ ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: DUMMY_API_KEY, CLAUDE_CODE_OAUTH_TOKEN: 't' })).toThrow(/tokens/);
    } finally { await mock.close(); }
    // after close the port is no longer ours
    expect(() => g.assertAllowed({ ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: DUMMY_API_KEY })).toThrow(BillableRefused);
    expect(() => g.assertAllowed({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_API_KEY: DUMMY_API_KEY })).toThrow(BillableRefused);
  });

  it('F-06: a localhost "gateway" in the environment (no mock server started) is NOT mock mode: the billable gate refuses without APPROVAL.json', () => {
    const gateway = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000', ANTHROPIC_API_KEY: DUMMY_API_KEY };
    expect(() => guard(path.join(tmp, 'missing.json'), { AGENT_EVAL_BILLABLE: '1' }).assertAllowed(gateway)).toThrow(/not a mock server started by this process/);
    // the same URL in the harness's own process env is ignored by the builder: the child env is a whitelist and never inherits it
    const c = buildClaudeCommand({ protocol: 'agentic', profile: 'restricted-oauth', model: 'claude-sonnet-5-5', cwd: '/x', baseEnv: { PATH: '/usr/bin', ...gateway } });
    expect(c.mock).toBe(false);
    expect(c.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(() => guard(path.join(tmp, 'missing.json'), { AGENT_EVAL_BILLABLE: '1' }).assertAllowed(c.env)).toThrow(/no approval file/);
  });

  it('runClaude refuses BEFORE spawning anything (binary does not exist, yet the error is the refusal)', async () => {
    const spec = buildClaudeCommand({ protocol: 'agentic', profile: 'restricted-oauth', model: 'sonnet', cwd: tmp, baseEnv: { PATH: '/usr/bin' }, claudeBin: '/nonexistent/claude', mcpConfigPath: path.join(tmp, 'm.json') });
    await expect(runClaude(spec, 'x', { run_id: 'r', task_id: 't', condition: 'c', repeat: 0, model: 'sonnet', workspace_hash: '' }, { guard: guard(path.join(tmp, 'missing.json'), { AGENT_EVAL_BILLABLE: '1' }) })).rejects.toBeInstanceOf(BillableRefused);
  });

  it('claudeSingleShot is billable and refuses without approval', async () => {
    const saved = process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_BASE_URL;
    try {
      const b = claudeSingleShot('claude-sonnet-5-5', { guard: guard(path.join(tmp, 'missing.json'), { AGENT_EVAL_BILLABLE: '1' }) });
      expect(b.billable).toBe(true);
      expect(b.name).toBe('claude-code');
      await expect(b.run([{ id: 't|single:none@8000|0', system: 's', prompt: 'p', context: '' }], path.join(tmp, 'ss'))).rejects.toBeInstanceOf(BillableRefused);
    } finally { if (saved !== undefined) process.env.ANTHROPIC_BASE_URL = saved; }
  });
});

describe('mock Anthropic server', () => {
  it('SSE sequence, non-streaming JSON, count_tokens, logging without headers, stateless step choice', async () => {
    const log = path.join(tmp, 'mock.jsonl');
    const mock = await startMockServer({ logFile: log, policy: { kind: 'scripted', steps: [{ tool: 'Grep', input: { pattern: 'x' } }, { structured: FIXED_DIAGNOSIS }] } });
    try {
      const body = { model: 'claude-sonnet-5-5', stream: true, system: 's', tools: [{ name: 'Grep', input_schema: {} }, { name: 'StructuredOutput', input_schema: {} }], messages: [{ role: 'user', content: 'hello' }] };
      const post = (b: object, p = '/v1/messages') => fetch(mock.url + p, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer SECRET-TOKEN', 'x-api-key': 'SECRET-KEY' }, body: JSON.stringify(b) });
      const sseText = await (await post(body)).text();
      const events = [...sseText.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
      expect(events).toEqual(['message_start', 'ping', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
      expect(sseText).toContain('"type":"input_json_delta"');
      expect(sseText).toContain('"stop_reason":"tool_use"');
      // second request carries one tool_result -> step 1 (structured)
      const body2 = { ...body, stream: false, messages: [...body.messages, { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Grep', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'r' }] }] };
      const j: any = await (await post(body2)).json();
      expect(j.content[0]).toMatchObject({ type: 'tool_use', name: 'StructuredOutput', input: FIXED_DIAGNOSIS });
      expect(j.usage.cache_read_input_tokens).toBeGreaterThan(0);
      expect(j.usage.output_tokens).toBeGreaterThan(0);
      const ct: any = await (await post(body, '/v1/messages/count_tokens')).json();
      expect(ct.input_tokens).toBeGreaterThan(0);
      expect(await (await post({}, '/api/whatever')).json()).toEqual({});
      const aux: any = await (await post({ model: 'haiku', messages: [{ role: 'user', content: 'title?' }] })).json();
      expect(aux.content[0].type).toBe('text');
      const logged = fs.readFileSync(log, 'utf8');
      expect(logged).not.toMatch(/SECRET/);
      expect(logged.split('\n').filter(Boolean).map((l) => JSON.parse(l).path)).toEqual(['/v1/messages', '/v1/messages', '/v1/messages/count_tokens', '/api/whatever', '/v1/messages']);
      expect(mock.paths()).toContain('POST /api/whatever');
    } finally { await mock.close(); }
  });
});

describe.skipIf(!hasClaude)('end-to-end against the mock API (real `claude` binary, no billable call)', () => {
  const run = async (profile: 'restricted-oauth', steps: any[] | null, withMcp: boolean) => {
    const ws = fs.mkdtempSync(path.join(tmp, 'ws-'));
    fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'src/a.ts'), 'export const a = 1;\n');
    const mock = await startMockServer({ logFile: path.join(tmp, `e2e-${Math.random()}.jsonl`), policy: steps ? { kind: 'scripted', steps } : { kind: 'echo-structured' } });
    try {
      const spec = buildClaudeCommand({
        protocol: 'agentic', profile, model: 'sonnet', cwd: ws, mockUrl: mock.url, mcpConfigPath: path.join(tmp, `mcp-${Math.random()}.json`),
        mcp: withMcp ? { name: 'retrieval', command: process.execPath, args: [path.join(FIX, 'stub-mcp-server.mjs')] } : null,
      });
      return await runClaude(spec, 'find the bug', { run_id: 'e2e', task_id: 't', condition: 'agentic:x', repeat: 0, model: 'sonnet', workspace_hash: 'h' }, {
        guard: new BillableGuard({ protocol: 'agentic', conditions: ['x'], model: 'sonnet', split: 'dev', max_total_usd: 1 }, { approvalPath: path.join(tmp, 'none.json'), env: {} }),
        timeoutMs: 90_000, transcriptPath: path.join(tmp, 'e2e.transcript.jsonl'),
      });
    } finally { await mock.close(); }
  };

  it('echo-structured: immediate structured diagnosis, mock backend marker, usage reported', async () => {
    const r = await run('restricted-oauth', null, false);
    expect(r.run.backend).toBe('claude-code-mock');
    expect(r.run.stop_reason).toBe('submitted');
    expect(r.run.diagnosis).toEqual(FIXED_DIAGNOSIS);
    expect(r.run.usage_source).toBe('api-reported');
    expect(r.run.usage!.output).toBeGreaterThan(0);
    expect(r.detail.init_tools.sort()).toEqual(['Glob', 'Grep', 'Read', 'StructuredOutput']);
    expect(fs.existsSync(path.join(tmp, 'e2e.transcript.jsonl'))).toBe(true);
  }, 120_000);

  it('injected extra tool: the real init event lists Bash and the run is killed with an init mismatch (never reaches the API)', async () => {
    const ws = fs.mkdtempSync(path.join(tmp, 'ws-'));
    const mock = await startMockServer({ policy: { kind: 'scripted', steps: [{ tool: 'Bash', input: { command: 'ls' } }, { structured: FIXED_DIAGNOSIS }] } });
    try {
      const spec = buildClaudeCommand({ protocol: 'agentic', profile: 'restricted-oauth', model: 'claude-sonnet-5-5', cwd: ws, mockUrl: mock.url, mcpConfigPath: path.join(tmp, 'mcp-inj.json'), injectExtraTool: 'Bash' });
      const r = await runClaude(spec, 'x', { run_id: 'inj', task_id: 't', condition: 'agentic:baseline', repeat: 0, model: 'claude-sonnet-5-5', workspace_hash: '' }, {
        guard: new BillableGuard({ protocol: 'agentic', conditions: ['baseline'], model: 'claude-sonnet-5-5', split: 'dev', max_total_usd: 1 }, { approvalPath: path.join(tmp, 'none.json'), env: {} }),
        timeoutMs: 60_000, onInit: (init) => { const m = checkInit(init, { mcp: null, model: 'claude-sonnet-5-5', mock: true }); return m.categories.length ? m.categories.join(',') : null; },
      });
      expect(r.init!.tools).toContain('Bash');
      expect(r.outcome).toMatchObject({ status: 'init_mismatch', reason: 'extra_tool' });
    } finally { await mock.close(); }
  }, 120_000);

  it('mock infra fault (HTTP 401): classified as an infrastructure error, not a wrong diagnosis', async () => {
    const ws = fs.mkdtempSync(path.join(tmp, 'ws-'));
    const mock = await startMockServer({ policy: { kind: 'fault', status: 401, error_type: 'authentication_error', message: 'invalid x-api-key' } });
    try {
      const spec = buildClaudeCommand({ protocol: 'agentic', profile: 'restricted-oauth', model: 'claude-sonnet-5-5', cwd: ws, mockUrl: mock.url, mcpConfigPath: path.join(tmp, 'mcp-f.json') });
      const r = await runClaude(spec, 'x', { run_id: 'f', task_id: 't', condition: 'agentic:baseline', repeat: 0, model: 'claude-sonnet-5-5', workspace_hash: '' }, {
        guard: new BillableGuard({ protocol: 'agentic', conditions: ['baseline'], model: 'claude-sonnet-5-5', split: 'dev', max_total_usd: 1 }, { approvalPath: path.join(tmp, 'none.json'), env: {} }), timeoutMs: 90_000,
      });
      expect(r.outcome.status).toBe('infra_error');
      expect(r.run.diagnosis).toBeNull();
    } finally { await mock.close(); }
  }, 120_000);

  it('scripted with an MCP server: retrieval call counted, outside-workspace read denied, no Bash', async () => {
    const r = await run('restricted-oauth', [
      { tool: 'mcp__retrieval__search_code', input: { query: 'a' } },
      { tool: 'Read', input: { file_path: 'src/a.ts' } },
      { tool: 'Read', input: { file_path: '/etc/hostname' } },
      { tool: 'Bash', input: { command: 'ls' } },
      { structured: FIXED_DIAGNOSIS },
    ], true);
    expect(r.run.retrieval_calls).toBe(1);
    expect(r.run.tool_calls).toMatchObject({ 'mcp__retrieval__search_code': 1, Read: 2, Bash: 1 });
    expect(r.detail.init_tools).toContain('mcp__retrieval__search_code');
    expect(r.detail.tool_denials_text.join('\n')).toMatch(/outside .* confines the file tools/);
    expect(r.detail.tool_denials_text.join('\n')).toMatch(/No such tool available: Bash/);
    expect(r.run.stop_reason).toBe('submitted');
  }, 120_000);
});
