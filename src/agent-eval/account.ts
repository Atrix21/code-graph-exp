/**
 * Binds billable runs to one named Claude Code login ("cc" accounts on this machine, managed by `claude-account`).
 *
 * `claude-account dir <name>` gives the account's config directory. The primary account is `~/.claude` and is used
 * with CLAUDE_CONFIG_DIR *unset* (setting it to ~/.claude would select a different `.claude.json`); every other
 * account is used with CLAUDE_CONFIG_DIR=<dir>. `claude auth status --json` (local, non-billable) then confirms the
 * login. Only the account name, plan type and a short hash of the e-mail are recorded, never the address.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export interface AccountInfo {
  name: string;
  config_dir: string;
  primary: boolean;
  logged_in: boolean;
  auth_method: string | null;
  subscription_type: string | null;
  email_sha: string | null;
  /** Base environment for child processes (CLAUDE_CONFIG_DIR set or removed for this account). */
  env: NodeJS.ProcessEnv;
}

export function accountEnv(configDir: string, base: NodeJS.ProcessEnv = process.env, home = base.HOME ?? os.homedir()): { env: NodeJS.ProcessEnv; primary: boolean } {
  const env: NodeJS.ProcessEnv = { ...base };
  const primary = path.resolve(configDir) === path.resolve(home, '.claude');
  if (primary) delete env.CLAUDE_CONFIG_DIR; else env.CLAUDE_CONFIG_DIR = configDir;
  delete env.CLAUDE_CODE_OAUTH_TOKEN; // a stray token would override the account's own login
  return { env, primary };
}

export function resolveAccount(name: string, base: NodeJS.ProcessEnv = process.env, bins = { account: 'claude-account', claude: process.env.AGENT_EVAL_CLAUDE_BIN ?? 'claude' }): AccountInfo {
  const d = spawnSync(bins.account, ['dir', name], { encoding: 'utf8', env: base });
  const dir = (d.stdout ?? '').trim().split('\n').pop() ?? '';
  if (d.status !== 0 || !dir || !path.isAbsolute(dir)) throw new Error(`cannot resolve Claude Code account '${name}' (\`${bins.account} dir ${name}\`: status ${d.status}, ${(d.stderr ?? '').trim() || d.error?.message || 'no output'})`);
  const { env, primary } = accountEnv(dir, base);
  const minimal: NodeJS.ProcessEnv = { PATH: env.PATH, HOME: env.HOME, ...(env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR } : {}) };
  const s = spawnSync(bins.claude, ['auth', 'status', '--json'], { encoding: 'utf8', env: minimal, cwd: os.tmpdir() });
  let j: any = {};
  try { j = JSON.parse(s.stdout || '{}'); } catch { /* logged out prints text */ }
  if (j.configDirectory && path.resolve(j.configDirectory) !== path.resolve(dir)) throw new Error(`account '${name}': claude reports config dir ${j.configDirectory}, expected ${dir}`);
  return {
    name, config_dir: dir, primary, logged_in: j.loggedIn === true, auth_method: j.authMethod ?? null, subscription_type: j.subscriptionType ?? null,
    email_sha: j.email ? crypto.createHash('sha256').update(String(j.email).toLowerCase()).digest('hex').slice(0, 10) : null, env,
  };
}

/** Throws unless the account is logged in with a claude.ai subscription (the only billing path an account binds). */
export function assertSubscriptionAccount(a: AccountInfo): void {
  if (!a.logged_in) throw new Error(`Claude Code account '${a.name}' is not logged in (run: cc login ${a.name})`);
  if (a.auth_method !== 'claude.ai') throw new Error(`account '${a.name}' authenticates via ${a.auth_method}, not a claude.ai subscription`);
}

/** What is recorded in run metadata (no e-mail address). */
export const accountRecord = (a: AccountInfo) => ({ name: a.name, primary: a.primary, subscription_type: a.subscription_type, email_sha: a.email_sha });
