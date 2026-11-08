/** Account binding (which Claude Code login is billed) and single-shot run discipline (resume, exclusion, halting) with a fake `claude`. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { accountEnv } from '../../src/agent-eval/account.js';
import { bindAccount } from '../../src/agent-eval/agentic.js';
import { checkApproval, checkInit, claudeSingleShot } from '../../src/agent-eval/backends/claude-code.js';
import { startMockServer } from '../../src/agent-eval/mock-anthropic/server.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-ss-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const HOME = '/home/u';

describe('account binding', () => {
  it('the primary account (~/.claude) runs with CLAUDE_CONFIG_DIR unset; others set it; a stray OAuth token is dropped', () => {
    const base = { HOME, PATH: '/bin', CLAUDE_CONFIG_DIR: '/home/u/.config/claude-accounts/work', CLAUDE_CODE_OAUTH_TOKEN: 't' };
    const p = accountEnv('/home/u/.claude', base, HOME);
    expect(p.primary).toBe(true);
    expect(p.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(p.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    const w = accountEnv('/home/u/.config/claude-accounts/akhila', { HOME, PATH: '/bin' }, HOME);
    expect(w.primary).toBe(false);
    expect(w.env.CLAUDE_CONFIG_DIR).toBe('/home/u/.config/claude-accounts/akhila');
  });

  it('an approval that names an account covers only that account', () => {
    const f = path.join(tmp, 'approval.json');
    fs.writeFileSync(f, JSON.stringify({ approvals: [{ protocol: 'agentic', conditions: '*', model: 'claude-sonnet-5-5', split: 'dev', max_total_usd: 5, account: 'personal' }] }));
    const req = { protocol: 'agentic' as const, conditions: ['baseline'], model: 'claude-sonnet-5-5', split: 'dev', max_total_usd: 5 };
    expect(checkApproval({ ...req, account: 'personal' }, f).ok).toBe(true);
    expect(checkApproval({ ...req, account: 'work' }, f).reason).toMatch(/account work not approved/);
    expect(checkApproval(req, f).reason).toMatch(/account \(none\) not approved/);
  });

  it('billable subscription runs must name an account; an account cannot be combined with API-key billing', () => {
    expect(() => bindAccount({ mock: false })).toThrow(/--account/);
    expect(() => bindAccount({ mock: false, account: 'personal', billing: 'api-key' })).toThrow(/cannot be combined/);
    expect(bindAccount({ mock: true })).toBeNull();
    expect(bindAccount({ mock: false, billing: 'api-key' })).toBeNull();
  });

  it('the single-shot init check expects StructuredOutput only', () => {
    const init = (tools: string[]) => ({ tools, mcp_servers: [], model: 'claude-sonnet-5-5', skills: [], slash_commands: [], plugins: [], apiKeySource: 'none' });
    expect(checkInit(init(['StructuredOutput']), { protocol: 'single_shot', mcp: null, model: 'claude-sonnet-5-5', mock: false }).categories).toEqual([]);
    expect(checkInit(init(['Read', 'StructuredOutput']), { protocol: 'single_shot', mcp: null, model: 'claude-sonnet-5-5', mock: false }).categories).toEqual(['extra_tool']);
  });
});

/* ------------------------------------------- single-shot ------------------------------------------- */

const GOOD = { candidates: [{ file: 'src/a.ts', symbol: 'A.b', start_line: 1, end_line: 2, explanation: 'x' }] };
const INIT = { tools: ['StructuredOutput'], mcp_servers: [], model: 'claude-sonnet-5-5', skills: [], slash_commands: [], plugins: [], apiKeySource: 'none', claude_code_version: '9.9.9', permissionMode: 'dontAsk' };
const OK = { subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.01, structured_output: GOOD, usage: { input_tokens: 10, output_tokens: 5 } };
const LIMIT = { subtype: 'success', is_error: true, result: 'Claude usage limit reached. Your limit will reset at 9pm.' };

/** A fake `claude` whose behaviour is read from a JSON file on every call, so a test can change it between runs. */
function fakeClaude(): { bin: string; set: (init: object, result: object) => void } {
  const state = path.join(tmp, `state-${Math.random().toString(36).slice(2)}.json`);
  const bin = path.join(tmp, `fake-${path.basename(state, '.json')}.mjs`);
  fs.writeFileSync(bin, `#!/usr/bin/env node
import fs from 'node:fs';
if (process.argv.includes('--version')) { console.log('9.9.9 (Fake)'); process.exit(0); }
process.stdin.resume(); process.stdin.on('data', () => {}); process.stdin.on('end', () => {
  const s = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
  console.log(JSON.stringify({ type: 'system', subtype: 'init', ...s.init })); console.log(JSON.stringify({ type: 'result', ...s.result })); process.exit(0);
});
`);
  fs.chmodSync(bin, 0o755);
  return { bin, set: (init, result) => fs.writeFileSync(state, JSON.stringify({ init, result })) };
}

async function withBin<T>(bin: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.AGENT_EVAL_CLAUDE_BIN;
  process.env.AGENT_EVAL_CLAUDE_BIN = bin;
  try { return await fn(); } finally { if (prev === undefined) delete process.env.AGENT_EVAL_CLAUDE_BIN; else process.env.AGENT_EVAL_CLAUDE_BIN = prev; }
}

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `auth_refresh_expiry_01|single:m${i}@2000|0`, system: 's', prompt: 'p', context: '' }));

describe('claude-code single-shot run discipline (mock mode, fake binary)', () => {
  it('a usage-limit error halts at once; the same work dir resumes and scores only finished items', async () => {
    const srv = await startMockServer({ policy: { kind: 'echo-structured' } });
    try {
      const f = fakeClaude();
      const dir = path.join(tmp, 'ss-limit');
      const b = claudeSingleShot('claude-sonnet-5-5', { mockUrl: srv.url, version: '9.9.9', log: () => undefined });
      f.set(INIT, LIMIT);
      const r1 = await withBin(f.bin, () => b.run(items(3), dir));
      expect(r1.halted).toMatch(/limit/);
      expect(r1.every((r) => r.excluded === 'pending')).toBe(true); // the failed item was retryable; nothing scored

      f.set(INIT, OK);
      const r2 = await withBin(f.bin, () => b.run(items(3), dir));
      expect(r2.halted).toBeNull();
      expect(r2.filter((r) => !r.excluded).length).toBe(3);
      expect(r2[0].extra?.status).toBe('submitted');

      const r3 = await withBin(f.bin, () => b.run(items(3), dir)); // nothing left: no new calls
      const raw = fs.readFileSync(path.join(dir, 'ss-raw.jsonl'), 'utf8').trim().split('\n');
      expect(r3.filter((r) => !r.excluded).length).toBe(3);
      expect(raw.length).toBe(4); // 1 excluded attempt + 3 finished
    } finally { await srv.close(); }
  });

  it('init-fingerprint mismatches are excluded, never retried, and two identical ones halt', async () => {
    const srv = await startMockServer({ policy: { kind: 'echo-structured' } });
    try {
      const f = fakeClaude();
      f.set({ ...INIT, tools: ['Read', 'StructuredOutput'] }, OK);
      const r = await withBin(f.bin, () => claudeSingleShot('claude-sonnet-5-5', { mockUrl: srv.url, version: '9.9.9', log: () => undefined }).run(items(3), path.join(tmp, 'ss-drift')));
      expect(r.halted).toMatch(/2 consecutive init-fingerprint/);
      expect(r.filter((x) => x.excluded?.startsWith('init_mismatch:extra_tool')).length).toBe(2);
      expect(r.filter((x) => x.excluded === 'pending').length).toBe(1);
      expect(r.some((x) => !x.excluded)).toBe(false);
    } finally { await srv.close(); }
  });

  it('a billable single-shot without approval is refused before any call', async () => {
    const f = fakeClaude();
    f.set(INIT, OK);
    const b = claudeSingleShot('claude-sonnet-5-5', { runUsd: 0.25, account: 'personal', log: () => undefined });
    await expect(withBin(f.bin, () => b.run(items(1), path.join(tmp, 'ss-refuse')))).rejects.toThrow(/AGENT_EVAL_BILLABLE|approval/);
  });
});

describe('prompt variants and list-price recomputation', () => {
  it('p2 is p1 plus exactly the directed sentence; p1 is unchanged', async () => {
    const { agentSystemPrompt, AGENT_SYSTEM_PROMPT, DIRECTED_TOOL_SENTENCE } = await import('../../src/agent-eval/prompt.js');
    expect(agentSystemPrompt('p1')).toBe(AGENT_SYSTEM_PROMPT);
    expect(agentSystemPrompt('p2')).toBe(`${AGENT_SYSTEM_PROMPT} ${DIRECTED_TOOL_SENTENCE}`);
    expect(() => agentSystemPrompt('p3' as any)).toThrow(/unknown/);
  });

  it('1-hour cache writes are priced at 2x input (reconciles a real stage-1 run within the cache-read price difference)', async () => {
    const { usageCost } = await import('../../src/agent-eval/backends/claude-code.js');
    const u = { input: 6, output: 630, cache_read: 8948, cache_write: 5694 };
    expect(usageCost(u, 'claude-sonnet-5-5', 5694)).toBeCloseTo((6 * 2 + 630 * 10 + 8948 * 0.2 + 5694 * 4) / 1e6, 10);
    expect(usageCost(u, 'claude-sonnet-5-5')).toBeCloseTo((6 * 2 + 630 * 10 + 8948 * 0.2 + 5694 * 2.5) / 1e6, 10);
    // Claude Code reported $0.0299828 for this run: the same tokens with cache reads at $0.10/M.
    expect(usageCost(u, 'claude-sonnet-5-5', 5694) - 8948 * 0.1 / 1e6).toBeCloseTo(0.0299828, 7);
  });
});

describe('subscription usage limits', () => {
  it("Claude Code's 5-hour / weekly limit messages are limits (halt at once), and never count as attempts", async () => {
    const { classifyOutcome, isUsageLimitExclusion, parseStreamJson } = await import('../../src/agent-eval/backends/claude-code.js');
    for (const msg of ["You've hit your 5-hour limit · resets 12:30am (Asia/Kolkata)", "You've hit your weekly limit · resets Nov 15, 8:30pm"]) {
      const p = parseStreamJson(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: msg }) + '\n');
      expect(classifyOutcome(p, { exitCode: 1, timedOut: false, hasDiagnosis: false }).infra_kind).toBe('limit');
    }
    // records written before the fix (classified api_error) are still recognised from their detail
    expect(isUsageLimitExclusion({ excluded: 'infra_error:api_error', excluded_detail: "error result: You've hit your 5-hour limit · resets 12:30am" })).toBe(true);
    expect(isUsageLimitExclusion({ excluded: 'infra_error:api_error', excluded_detail: 'error result: Overloaded' })).toBe(false);
    expect(isUsageLimitExclusion({ excluded: 'init_mismatch:extra_tool', excluded_detail: 'limit · resets 1pm' })).toBe(false);
  });

  it('single-shot: a limit-interrupted item is retried on resume even after two limit hits', async () => {
    const srv = await startMockServer({ policy: { kind: 'echo-structured' } });
    try {
      const f = fakeClaude();
      const dir = path.join(tmp, 'ss-limit2');
      const b = claudeSingleShot('claude-sonnet-5-5', { mockUrl: srv.url, version: '9.9.9', log: () => undefined });
      f.set(INIT, { ...LIMIT, result: "You've hit your 5-hour limit · resets 12:30am (Asia/Kolkata)" });
      expect((await withBin(f.bin, () => b.run(items(2), dir))).halted).toMatch(/limit/);
      expect((await withBin(f.bin, () => b.run(items(2), dir))).halted).toMatch(/limit/); // second interruption of the same item
      f.set(INIT, OK);
      const r = await withBin(f.bin, () => b.run(items(2), dir));
      expect(r.filter((x) => !x.excluded).length).toBe(2);
    } finally { await srv.close(); }
  });
});
