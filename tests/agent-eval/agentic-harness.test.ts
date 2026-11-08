/** Harness behaviour of `runAgentic` with a fake `claude` binary (mock mode, no model): plan, resume, halting rules. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { runAgentic } from '../../src/agent-eval/agentic.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-harness-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const cfg = loadConfig();
const TASK = 'auth_refresh_expiry_01';
const GOOD = { candidates: [{ file: 'src/auth/auth.service.ts', symbol: 'AuthService.getTokensData', start_line: 632, end_line: 632, explanation: 'x' }] };
const USAGE = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 };
const INIT = { tools: ['Glob', 'Grep', 'Read', 'StructuredOutput'], mcp_servers: [], model: 'claude-sonnet-5-5', skills: [], slash_commands: [], plugins: [], apiKeySource: 'none', claude_code_version: '9.9.9' };
const OK = { subtype: 'success', is_error: false, num_turns: 2, total_cost_usd: 0.01, structured_output: GOOD, usage: USAGE, modelUsage: { 'claude-sonnet-5-5': { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 100, cacheCreationInputTokens: 50, costUSD: 0.01 } } };

function fake(name: string, init: object | null, result: object | null, exit = 0, version = '9.9.9'): string {
  const p = path.join(tmp, `fake-${name}.mjs`);
  const lines = [...(init ? [{ type: 'system', subtype: 'init', ...init }] : []), ...(result ? [{ type: 'result', ...result }] : [])].map((x) => JSON.stringify(x));
  fs.writeFileSync(p, `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('${version} (Fake)'); process.exit(0); }
process.stdin.resume(); process.stdin.on('data', () => {}); process.stdin.on('end', () => { ${lines.map((l) => `console.log(${JSON.stringify(l)});`).join(' ')} process.exit(${exit}); });
`);
  fs.chmodSync(p, 0o755);
  return p;
}
async function run(bin: string, tag: string, repeats = 1) {
  const prev = process.env.AGENT_EVAL_CLAUDE_BIN;
  process.env.AGENT_EVAL_CLAUDE_BIN = bin;
  try { return await runAgentic(cfg, { runId: tag, split: 'dev', conditions: ['baseline'], repeats, profile: 'restricted-oauth', mockApi: 'echo-structured', taskIds: [TASK], resultsRoot: tmp, log: () => undefined }); }
  finally { if (prev === undefined) delete process.env.AGENT_EVAL_CLAUDE_BIN; else process.env.AGENT_EVAL_CLAUDE_BIN = prev; }
}
const jsonl = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

describe('runAgentic harness rules', () => {
  it('writes plan.json (seeded shuffle, positions), appends per-run files, and resumes without re-running scored items', async () => {
    const r1 = await run(fake('ok', INIT, OK), 'ah-plan', 3);
    expect(r1.runs).toHaveLength(3);
    const plan = JSON.parse(fs.readFileSync(path.join(tmp, 'ah-plan', 'plan.json'), 'utf8'));
    expect(plan.seed).toBe(20261108);
    expect(plan.items.map((i: any) => i.position)).toEqual([0, 1, 2]);
    expect(r1.runs.map((r) => r.position).sort()).toEqual([0, 1, 2]);
    expect(jsonl(path.join(tmp, 'ah-plan', 'ledger.jsonl'))).toHaveLength(3);
    const meta = JSON.parse(fs.readFileSync(path.join(tmp, 'ah-plan', 'meta.json'), 'utf8'));
    expect(meta).toMatchObject({ status: 'completed', shuffle_seed: 20261108, model: 'claude-sonnet-5-5', effort: 'high', max_turns: 40 });
    const r2 = await run(fake('ok2', INIT, OK), 'ah-plan', 3);
    expect(r2.runs).toHaveLength(3);
    expect(jsonl(path.join(tmp, 'ah-plan', 'ledger.jsonl'))).toHaveLength(3); // nothing re-run
    await expect(run(fake('ok3', INIT, OK), 'ah-plan', 4)).rejects.toThrow(/different repeats/);
  }, 180_000);

  it('2 consecutive init-fingerprint exclusions with the same reason halt the experiment (never scored, not retried)', async () => {
    const r = await run(fake('ah-drift', { ...INIT, tools: [...INIT.tools, 'Bash'] }, OK), 'ah-drift', 4);
    expect(r.runs).toHaveLength(0);
    expect(r.excluded).toHaveLength(2);
    expect(r.halted).toMatch(/2 consecutive init-fingerprint exclusions: extra_tool/);
    expect(JSON.parse(fs.readFileSync(path.join(tmp, 'ah-drift', 'meta.json'), 'utf8')).status).toBe('halted');
  }, 180_000);

  it('a Claude Code version change halts at once', async () => {
    const r = await run(fake('ah-ver', { ...INIT, claude_code_version: '1.0.0' }, OK), 'ah-ver', 3);
    expect(r.excluded).toHaveLength(1);
    expect(r.halted).toMatch(/version changed/);
  }, 180_000);

  it('3 consecutive infrastructure errors halt (each item retried once); auth errors halt at once', async () => {
    const r = await run(fake('crash', INIT, null, 1), 'ah-infra', 4);
    expect(r.runs).toHaveLength(0);
    expect(r.excluded).toHaveLength(3); // item 1 twice (retry), item 2 once
    expect(r.halted).toMatch(/3 consecutive infrastructure errors/);
    const a = await run(fake('ah-auth', INIT, { subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login', usage: USAGE }), 'ah-auth', 3);
    expect(a.excluded).toHaveLength(1);
    expect(a.halted).toMatch(/auth/);
  }, 180_000);

  it('an error result with no usage is infra, but max_turns and a missing structured output are scored (model failures)', async () => {
    const mt = await run(fake('ah-mt', INIT, { subtype: 'error_max_turns', is_error: true, num_turns: 41, total_cost_usd: 0.5, usage: USAGE, modelUsage: OK.modelUsage }), 'ah-mt', 1);
    expect(mt.runs).toHaveLength(1);
    expect(mt.runs[0].status).toBe('max_turns');
    expect(mt.runs[0].score.valid).toBe(0);
    const ns = await run(fake('ah-ns', INIT, { ...OK, structured_output: undefined, result: 'I could not decide.' }), 'ah-ns', 1);
    expect(ns.runs[0].status).toBe('no_structured_output');
    expect(ns.runs[0].score.valid).toBe(0);
  }, 180_000);

  it('refuses billable-mode violations before building anything', async () => {
    const base = { runId: 'ah-bill', split: 'dev' as const, conditions: ['baseline'], repeats: 1, profile: 'restricted-oauth' as const, taskIds: [TASK], resultsRoot: tmp, log: () => undefined };
    await expect(runAgentic(cfg, { ...base, profile: 'bare' })).rejects.toThrow(/restricted-oauth/);
    await expect(runAgentic(cfg, { ...base, model: 'sonnet', perRunUsd: 1 })).rejects.toThrow(/pinned model id/);
    await expect(runAgentic(cfg, base)).rejects.toThrow(/--run-usd/);
    expect(fs.existsSync(path.join(tmp, 'ah-bill'))).toBe(false);
  });
});
