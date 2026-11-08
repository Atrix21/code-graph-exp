import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildClaudeCommand, checkApproval, checkInit } from '../../src/agent-eval/backends/claude-code.js';

const base = { PATH: process.env.PATH, HOME: os.homedir(), ANTHROPIC_API_KEY: 'sk-ant-api-test-123', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test' } as NodeJS.ProcessEnv;
const cmd = (billing?: 'subscription' | 'api-key', env = base) => buildClaudeCommand({ protocol: 'agentic', profile: 'restricted-oauth', model: 'claude-sonnet-5-5', cwd: '/tmp', billing, baseEnv: env });

describe('billing path is explicit and cannot fall into the other one', () => {
  it('subscription (default) strips any API key from the child env', () => {
    const e = cmd().env;
    expect(e.ANTHROPIC_API_KEY).toBeUndefined();
    expect(e.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-test');
  });
  it('api-key passes the key and no OAuth token; refuses when no key is set', () => {
    const e = cmd('api-key').env;
    expect(e.ANTHROPIC_API_KEY).toBe('sk-ant-api-test-123');
    expect(e.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(() => cmd('api-key', { PATH: process.env.PATH } as NodeJS.ProcessEnv)).toThrow(/ANTHROPIC_API_KEY/);
  });
  it('the init check expects the key source that matches the approved billing path', () => {
    const init = (apiKeySource: string) => ({ type: 'system', subtype: 'init', tools: ['Read', 'Grep', 'Glob', 'StructuredOutput'], mcp_servers: [], model: 'claude-sonnet-5-5', permissionMode: 'dontAsk', apiKeySource, skills: [], plugins: [], slash_commands: [] });
    const has = (c: string[]) => c.includes('api_key_source');
    expect(has(checkInit(init('ANTHROPIC_API_KEY'), { mcp: null, model: 'claude-sonnet-5-5', mock: false }).categories)).toBe(true);
    expect(has(checkInit(init('none'), { mcp: null, model: 'claude-sonnet-5-5', mock: false, billing: 'api-key' }).categories)).toBe(true);
    expect(has(checkInit(init('ANTHROPIC_API_KEY'), { mcp: null, model: 'claude-sonnet-5-5', mock: false, billing: 'api-key' }).categories)).toBe(false);
  });
  it('an approval for one billing path does not cover the other', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'appr-')), 'APPROVAL.json');
    fs.writeFileSync(f, JSON.stringify({ approvals: [{ protocol: 'agentic', conditions: '*', model: 'claude-sonnet-5-5', split: 'dev', max_total_usd: 5 }] }));
    const req = { protocol: 'agentic' as const, conditions: ['baseline'], model: 'claude-sonnet-5-5', split: 'dev', max_total_usd: 5 };
    expect(checkApproval(req, f).ok).toBe(true);
    expect(checkApproval({ ...req, billing: 'api-key' }, f).ok).toBe(false);
  });
});
