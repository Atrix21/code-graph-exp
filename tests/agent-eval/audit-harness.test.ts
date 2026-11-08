/**
 * Independent audit of the experiment-2 agentic harness (accounting, exclusion, resumability, billing guard).
 * Written by the auditor. NO model call is possible here: `claude` is replaced by a fake executable (AGENT_EVAL_CLAUDE_BIN)
 * that prints canned stream-json, and every run is in mock mode (localhost mock API + dummy key).
 *
 * `it(...)` = a DEFECT: the assertion states the behaviour we want and passes only while the defect exists.
 * Flip to `it(...)` once fixed. Finding ids refer to experiments/02-agent-diagnosis/AUDIT.md.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { runAgentic } from '../../src/agent-eval/agentic.js';
import { BillableGuard, DUMMY_API_KEY, isLocalUrl } from '../../src/agent-eval/backends/claude-code.js';
import { startMockServer } from '../../src/agent-eval/mock-anthropic/server.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-harness-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const cfg = loadConfig();
const TASK = 'auth_refresh_expiry_01'; // a dev task

const GOOD = { candidates: [{ file: 'src/auth/auth.service.ts', symbol: 'AuthService.getTokensData', start_line: 632, end_line: 632, explanation: 'x' }] };
const USAGE = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 };
const MODEL_USAGE = { 'claude-sonnet-5-5': { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 100, cacheCreationInputTokens: 50, costUSD: 0.01 } };

/** A fake `claude`: prints --version, else an init event + result event described by `scenario`. */
function fakeClaude(name: string, init: Record<string, unknown> | null, result: Record<string, unknown> | null, exitCode = 0): string {
  const p = path.join(tmp, `fake-claude-${name}.mjs`);
  const lines = [
    ...(init ? [{ type: 'system', subtype: 'init', ...init }] : []),
    ...(result ? [{ type: 'result', ...result }] : []),
  ].map((x) => JSON.stringify(x));
  fs.writeFileSync(p, `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('9.9.9 (Fake Claude)'); process.exit(0); }
process.stdin.resume(); process.stdin.on('data', () => {}); process.stdin.on('end', () => {
  ${lines.map((l) => `console.log(${JSON.stringify(l)});`).join('\n  ')}
  process.exit(${exitCode});
});
`);
  fs.chmodSync(p, 0o755);
  return p;
}

const BASELINE_INIT = { tools: ['Glob', 'Grep', 'Read', 'StructuredOutput'], mcp_servers: [], model: 'claude-sonnet-5-5', skills: [], slash_commands: [], plugins: [], apiKeySource: 'none' };
const OK_RESULT = { subtype: 'success', is_error: false, num_turns: 3, total_cost_usd: 0.01, duration_api_ms: 100, structured_output: GOOD, usage: USAGE, modelUsage: MODEL_USAGE };

async function runWith(bin: string, tag: string, extra: Partial<Parameters<typeof runAgentic>[1]> = {}) {
  const prev = process.env.AGENT_EVAL_CLAUDE_BIN;
  process.env.AGENT_EVAL_CLAUDE_BIN = bin;
  try {
    return await runAgentic(cfg, { runId: tag, split: 'dev', conditions: ['baseline'], repeats: 1, model: 'claude-sonnet-5-5', profile: 'restricted-oauth', mockApi: 'echo-structured', taskIds: [TASK], resultsRoot: tmp, log: () => undefined, ...extra });
  } finally { if (prev === undefined) delete process.env.AGENT_EVAL_CLAUDE_BIN; else process.env.AGENT_EVAL_CLAUDE_BIN = prev; }
}
const readJsonl = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

describe('AUDIT harness: accounting works on a well-formed run', () => {
  it('usage is the modelUsage sum with the four token classes separate; cost is the result event total; latency is measured; scored', async () => {
    const { runs } = await runWith(fakeClaude('ok', BASELINE_INIT, OK_RESULT), 'ok');
    expect(runs).toHaveLength(1);
    const r = runs[0];
    expect(r.usage).toEqual({ input: 10, output: 20, cache_read: 100, cache_write: 50 });
    expect(r.cost_usd).toBe(0.01);
    expect(r.usage_source).toBe('api-reported');
    expect(r.latency_ms).toBeGreaterThan(0);
    expect(r.api_duration_ms).toBe(100);
    expect(r.score.rc_line_at_1).toBe(1);
    expect(r.backend).toBe('claude-code-mock');
  }, 120_000);

  it('F-09 (fixed): the per-run record carries the init fingerprint, wall/api durations, MCP start-up and index-build fields, both cost numbers, effort and version', async () => {
    const { runs } = await runWith(fakeClaude('ok2', BASELINE_INIT, OK_RESULT), 'ok2');
    const r: any = runs[0];
    expect(r.init.tools).toEqual(BASELINE_INIT.tools);
    for (const k of ['wall_ms', 'duration_ms', 'api_duration_ms', 'init_ms', 'mcp_startup_ms', 'index_build_ms', 'cost_reported_usd', 'cost_list_usd', 'cost_ledger_usd', 'effort', 'claude_version', 'position', 'attempt', 'status', 'condition_label']) expect(Object.keys(r)).toContain(k);
    expect(r.effort).toBe('high');
    expect(r.claude_version).toBe('9.9.9');
    expect(r.cost_list_usd).toBeCloseTo((10 * 2 + 20 * 10 + 100 * 0.2 + 50 * 2.5) / 1e6, 10);
    expect(r.cost_ledger_usd).toBeGreaterThanOrEqual(r.cost_reported_usd); // the larger of reported and list-price
    expect(r.status).toBe('submitted');
  }, 120_000);
});

describe('AUDIT harness: exclusion of runs that did not test the condition (F-03, F-04)', () => {
  // protocol.md: "a run whose tool set differs from its condition's expected set is excluded and reported".
  it('F-03: a run whose init tool list contains Bash, whose model differs, or that loaded a skill is excluded', async () => {
    const drift = { ...BASELINE_INIT, tools: [...BASELINE_INIT.tools, 'Bash'], model: 'claude-opus-4-1', skills: ['graphify'] };
    const { runs } = await runWith(fakeClaude('drift', drift, OK_RESULT), 'drift');
    expect(runs).toHaveLength(0);
    const excluded = readJsonl(path.join(tmp, 'drift', 'excluded.jsonl'));
    expect(excluded).toHaveLength(1);
    expect(excluded[0].excluded).toMatch(/init_mismatch:.*extra_tool/);
    expect(excluded[0].excluded_kind).toBe('init_mismatch');
  }, 120_000);

  it('F-04: an infrastructure failure (no result event, exit 1) is excluded/retried, not scored as a wrong diagnosis', async () => {
    const { runs, excluded } = await runWith(fakeClaude('crash', BASELINE_INIT, null, 1), 'crash');
    expect(runs).toHaveLength(0);
    expect(excluded.map((e) => e.excluded)).toEqual(['infra_error:crash', 'infra_error:crash']); // retried at most once
  }, 120_000);

  it('F-04: a usage-limit / rate-limit error result ("is_error" with an error text) is excluded and halts the run, not scored 0', async () => {
    const limited = { subtype: 'success', is_error: true, num_turns: 1, total_cost_usd: 0, result: "You've hit your usage limit. Resets at 9pm.", usage: USAGE, modelUsage: MODEL_USAGE };
    const { runs, excluded, halted } = await runWith(fakeClaude('limited', BASELINE_INIT, limited), 'limited');
    expect(runs).toHaveLength(0);
    expect(halted).toMatch(/usage-limit/);
    expect(excluded).toHaveLength(1); // halted immediately: no retry
  }, 120_000);
});

describe('AUDIT harness: resumability (F-05)', () => {
  it('re-running the same run id must not delete the results of the previous invocation', async () => {
    const dir = path.join(tmp, 'resume');
    fs.mkdirSync(path.join(dir, 'transcripts'), { recursive: true });
    const paid = path.join(dir, 'raw-runs.jsonl');
    fs.writeFileSync(paid, JSON.stringify({ run_id: 'paid-for-run', cost_usd: 1.23 }) + '\n');
    await runWith(fakeClaude('resume', BASELINE_INIT, OK_RESULT), 'resume');
    expect(fs.existsSync(paid) && fs.readFileSync(paid, 'utf8')).toContain('paid-for-run');
    // and the run is resumable: a second invocation skips what is already scored
    const again = await runWith(fakeClaude('resume2', BASELINE_INIT, OK_RESULT), 'resume');
    expect(again.runs).toHaveLength(1);
    expect(readJsonl(path.join(dir, 'ledger.jsonl'))).toHaveLength(1);
  }, 120_000);
});

describe('AUDIT harness: billing guard (F-06, F-07)', () => {
  const approval = path.join(tmp, 'approval.json');
  const realEnv = { PATH: '/usr/bin' }; // no ANTHROPIC_BASE_URL => the real API
  const mk = (ledger: string, runUsd?: number) => new BillableGuard({ protocol: 'agentic', conditions: ['baseline'], model: 'claude-sonnet-5-5', split: 'test', max_total_usd: 1 }, { approvalPath: approval, env: { AGENT_EVAL_BILLABLE: '1' }, ledgerPath: ledger, runUsd });

  it('isLocalUrl accepts only literal loopback hosts (userinfo / suffix / IPv4-mapped tricks are rejected)', () => {
    for (const u of ['http://127.0.0.1:1', 'http://localhost:8080', 'http://[::1]:9', 'http://127.1/']) expect(isLocalUrl(u)).toBe(true);
    for (const u of ['https://api.anthropic.com', 'http://localhost.evil.com', 'http://127.0.0.1.evil.com', 'http://127.0.0.1@evil.com', 'http://0.0.0.0:1', 'http://[::ffff:127.0.0.1]/', 'http://localhost./', undefined, '', 'not a url']) expect(isLocalUrl(u as string)).toBe(false);
  });

  it('F-06 (fixed): a loopback URL + the dummy key is NOT mock unless it is the port of a mock server this process started', async () => {
    fs.rmSync(approval, { force: true }); // no approval at all
    const g = mk(path.join(tmp, 'l0.jsonl'));
    expect(() => g.assertAllowed({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000', ANTHROPIC_API_KEY: DUMMY_API_KEY })).toThrow(/not a mock server started by this process/);
    const mock = await startMockServer({ policy: { kind: 'echo-structured' } });
    try { expect(g.assertAllowed({ ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: DUMMY_API_KEY })).toBe(true); } finally { await mock.close(); }
  });

  it('F-07: with N workers the cap must account for runs in flight (reservation); today every worker is granted the whole remaining budget', () => {
    fs.writeFileSync(approval, JSON.stringify({ approvals: [{ protocol: 'agentic', conditions: '*', model: '*', split: 'all', max_total_usd: 1 }] }));
    const g = mk(path.join(tmp, 'l1.jsonl'), 0.1);
    for (let i = 0; i < 4; i++) g.assertAllowed(realEnv); // four workers start before any run has finished
    expect(g.remaining(realEnv)).toBeCloseTo(0.6);
    for (let i = 0; i < 6; i++) g.assertAllowed(realEnv); // 10 x $0.1 reserved = the whole cap
    expect(() => g.assertAllowed(realEnv)).toThrow(/cost cap/); // desired: reservations shrink what the next run may spend
  });

  it('a run that dies without a result event is recorded in the ledger as $0 (its tokens are unaccounted)', () => {
    fs.writeFileSync(approval, JSON.stringify({ approvals: [{ protocol: 'agentic', conditions: '*', model: '*', split: 'all', max_total_usd: 1 }] }));
    const ledger = path.join(tmp, 'l2.jsonl');
    const g = mk(ledger);
    g.record('killed-run', null, realEnv);
    expect(g.remaining(realEnv)).toBe(1); // (the harness charges the reservation / stream usage for such runs, see claude-code.ts runClaude)
    expect(JSON.parse(fs.readFileSync(ledger, 'utf8').trim())).toMatchObject({ run_id: 'killed-run', cost_usd: null });
  });
});

afterEach(() => undefined);
