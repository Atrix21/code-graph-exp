/**
 * Claude Code (headless `claude -p`) backend for experiment 2.
 *
 * SAFETY: every `claude` invocation that would reach the real Anthropic API is gated (see BillableGuard):
 *   - experiments/02-agent-diagnosis/APPROVAL.json must exist and cover {protocol, conditions, model, split, max_total_usd};
 *   - AGENT_EVAL_BILLABLE=1 must be set;
 *   - a running total of reported `total_cost_usd` (persisted in spend-ledger.jsonl) stops new runs at the approved cap.
 * Mock mode (child base URL is the mock server THIS process started, plus the dummy API key; never inferred from the
 * environment, so a localhost gateway/tunnel cannot bypass the gate) bypasses the gate and marks runs
 * `backend: 'claude-code-mock'`. A child env that is neither fully-mock nor fully-approved is refused.
 *
 * The child environment is a WHITELIST (PATH, HOME, ...), never the parent's, so CLAUDECODE / CLAUDE_CODE_* markers,
 * stray tokens and base-URL overrides of the calling session cannot leak into the experiment.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { abs, loadConfig } from '../../config.js';
import { loadTasks } from '../../evaluation/ground-truth.js';
import { isOwnMockUrl } from '../mock-anthropic/server.js';
import { AGENT_SYSTEM_PROMPT, SINGLE_SHOT_SYSTEM_PROMPT } from '../prompt.js';
import { parseDiagnosis } from '../scoring.js';
import { DIAGNOSIS_SCHEMA, type AgentRun, type Diagnosis, type Protocol, type TokenUsage } from '../types.js';
import type { SingleShotBackend, SingleShotItem, SingleShotResult, SingleShotResults } from './single-shot.js';

export const DUMMY_API_KEY = 'sk-ant-dummy-not-a-real-key';
export const EXP_DIR_REL = 'experiments/02-agent-diagnosis';
export const APPROVAL_PATH = abs(`${EXP_DIR_REL}/APPROVAL.json`);
export const LEDGER_PATH = abs(`${EXP_DIR_REL}/spend-ledger.jsonl`);

/* ------------------------------------------------------------------------------------------------ */
/* command builder                                                                                   */
/* ------------------------------------------------------------------------------------------------ */

export type ProfileName = 'bare' | 'restricted-oauth' | 'safe-mode';
export const PROFILE_NAMES: ProfileName[] = ['bare', 'restricted-oauth', 'safe-mode'];

export const AGENT_TOOLS = ['Read', 'Grep', 'Glob'] as const;
export const BLOCK_READS_SETTINGS = JSON.stringify({ permissions: { blockReadsOutsideWorkingDirectories: true } });

export interface McpServerSpec {
  name: string; command: string; args: string[]; env?: Record<string, string>;
  /** Tool basenames of this server that must NOT be offered (write- or network-capable); denied as `mcp__<name>__<tool>`. */
  denyTools?: string[];
}

/** The exact tool policy the builder applies (also recorded in run metadata). */
export function toolPolicy(protocol: Protocol, mcp?: McpServerSpec | null): { tools: string[]; allowed: string[]; denied: string[] } {
  if (protocol !== 'agentic') return { tools: [], allowed: [], denied: [] };
  return {
    tools: [...AGENT_TOOLS],
    allowed: [...AGENT_TOOLS, ...(mcp ? [mcpToolPattern(mcp.name)] : [])],
    denied: [...BASE_DENIED_TOOLS, ...(mcp?.denyTools ?? []).map((t) => `mcp__${mcp!.name}__${t}`)],
  };
}
export const BASE_DENIED_TOOLS = ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'Skill', 'TodoWrite'];

export type Billing = 'subscription' | 'api-key';

export interface ClaudeCommandOpts {
  protocol: Protocol;
  profile: ProfileName;
  model: string;
  /** Working directory of the child (the isolated workspace for agentic; an empty scratch dir for single-shot). */
  cwd: string;
  /** Defaults: AGENT_SYSTEM_PROMPT (agentic) / SINGLE_SHOT_SYSTEM_PROMPT (single-shot). */
  systemPrompt?: string;
  jsonSchema?: object;
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** Agentic only: the condition's retrieval MCP server (omit for the baseline). */
  mcp?: McpServerSpec | null;
  /** Billing path for real (non-mock) runs: the subscription login (default) or an API key from ANTHROPIC_API_KEY. */
  billing?: Billing;
  /** Where the MCP config JSON is to be written (outside the workspace). Default: deterministic path under os.tmpdir(). */
  mcpConfigPath?: string;
  /** Mock mode: base URL of the mock server THIS process started (`MockServer.url`). Absent = real API (gated). Never taken from the environment. */
  mockUrl?: string;
  effort?: string;
  claudeBin?: string;
  /** Environment to take whitelisted variables from. Default process.env. */
  baseEnv?: NodeJS.ProcessEnv;
  extraArgs?: string[];
  /** VERIFICATION ONLY (refused for billable runs): offer one extra built-in tool, to demonstrate the init-fingerprint exclusion. */
  injectExtraTool?: string;
}

export interface ClaudeCommand {
  cmd: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  /** MCP config file to write before spawning (path outside the workspace). */
  mcpConfig: { path: string; json: string };
  profile: ProfileName;
  protocol: Protocol;
  model: string;
  mock: boolean;
  injected?: string;
}

export const PROFILE_DESCRIPTIONS: Record<ProfileName, string> = {
  bare: '--bare: skips hooks, plugins, auto-memory, keychain/OAuth and CLAUDE.md discovery. Requires ANTHROPIC_API_KEY (API-billed).',
  'restricted-oauth': '--restricted: drops code-running tools and WebFetch, ignores user/project/local settings files, confines file tools to the workspace. Works with a subscription (OAuth) login.',
  'safe-mode': '--safe-mode: disables CLAUDE.md, skills, plugins, hooks, MCP servers (see notes: --mcp-config servers), memory. Keeps OAuth.',
};

const ENV_PASSTHROUGH = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'SHELL', 'TERM'];
export const ISOLATION_ENV: Record<string, string> = {
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_AUTOUPDATER: '1',
  NO_COLOR: '1',
  ENABLE_CLAUDEAI_MCP_SERVERS: 'false', // account-level claude.ai connectors (only load under OAuth login; cannot be observed in mock mode)
  MCP_TIMEOUT: '180000', // MCP server start-up (retrieval servers prepare an index; competitors are built beforehand)
  MCP_TOOL_TIMEOUT: '120000',
};

export function isLocalUrl(u: string | undefined): boolean {
  if (!u) return false;
  try { const h = new URL(u).hostname; return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]'; } catch { return false; }
}

/** The `{mcpServers}` JSON for a condition. Always written (strict config), empty for the baseline. */
export function mcpConfigJson(spec: McpServerSpec | null | undefined): string {
  const servers: Record<string, unknown> = {};
  if (spec) servers[spec.name] = { type: 'stdio', command: spec.command, args: spec.args, env: spec.env ?? {} };
  return JSON.stringify({ mcpServers: servers });
}

export function mcpToolPattern(name: string): string { return `mcp__${name}__*`; }

/** Pure: no I/O, no process.env reads unless `baseEnv` is omitted. */
export function buildClaudeCommand(o: ClaudeCommandOpts): ClaudeCommand {
  const base = o.baseEnv ?? process.env;
  const mock = o.mockUrl != null;
  if (mock && !isLocalUrl(o.mockUrl)) throw new Error(`mockUrl must point at localhost, got ${o.mockUrl}`);
  const agentic = o.protocol === 'agentic';
  const mcp = agentic ? o.mcp ?? null : null;
  const json = mcpConfigJson(mcp);
  const mcpPath = o.mcpConfigPath ?? path.join(os.tmpdir(), 'agent-eval-mcp', `${crypto.createHash('sha1').update(json).digest('hex').slice(0, 12)}.json`);

  // --- environment ---
  const env: Record<string, string> = {};
  for (const k of ENV_PASSTHROUGH) if (base[k] != null) env[k] = base[k]!;
  Object.assign(env, ISOLATION_ENV);
  if (mock) {
    env.ANTHROPIC_BASE_URL = o.mockUrl!;
    env.ANTHROPIC_API_KEY = DUMMY_API_KEY;
    // Keep the config dir so the isolation flags are tested against the real user configuration (CLAUDE.md, skills, ...).
    if (base.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = base.CLAUDE_CONFIG_DIR;
  } else if (o.profile === 'bare') {
    if (!base.ANTHROPIC_API_KEY) throw new Error("profile 'bare' needs ANTHROPIC_API_KEY (it never reads OAuth credentials)");
    env.ANTHROPIC_API_KEY = base.ANTHROPIC_API_KEY;
  } else if (o.billing === 'api-key') {
    // API-key billing (explicitly approved): the key is passed through; no OAuth token is forwarded.
    if (!base.ANTHROPIC_API_KEY) throw new Error("billing 'api-key' needs ANTHROPIC_API_KEY in the environment");
    env.ANTHROPIC_API_KEY = base.ANTHROPIC_API_KEY;
    if (base.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = base.CLAUDE_CONFIG_DIR;
  } else {
    // subscription login: credentials come from CLAUDE_CONFIG_DIR (or a setup-token); a stray API key must not take over.
    if (base.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = base.CLAUDE_CONFIG_DIR;
    if (base.CLAUDE_CODE_OAUTH_TOKEN) env.CLAUDE_CODE_OAUTH_TOKEN = base.CLAUDE_CODE_OAUTH_TOKEN;
  }

  // --- arguments ---
  const a: string[] = ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--model', o.model];
  if (o.profile === 'bare') a.push('--bare');
  else if (o.profile === 'restricted-oauth') a.push('--restricted');
  else a.push('--safe-mode');
  a.push('--disable-slash-commands', '--strict-mcp-config', '--mcp-config', mcpPath);
  a.push('--settings', BLOCK_READS_SETTINGS);
  a.push('--system-prompt', o.systemPrompt ?? (agentic ? AGENT_SYSTEM_PROMPT : SINGLE_SHOT_SYSTEM_PROMPT));
  a.push('--system-prompt-snapshot', 'off');
  a.push('--json-schema', JSON.stringify(o.jsonSchema ?? DIAGNOSIS_SCHEMA));
  a.push('--max-turns', String(o.maxTurns ?? (agentic ? 40 : 3)));
  if (o.maxBudgetUsd != null) a.push('--max-budget-usd', String(o.maxBudgetUsd));
  if (o.effort) a.push('--effort', o.effort);
  a.push('--permission-mode', 'dontAsk', '--permission-prompts', 'none');
  if (agentic) {
    const pol = toolPolicy('agentic', mcp);
    const x = o.injectExtraTool;
    a.push('--tools', [...pol.tools, ...(x ? [x] : [])].join(','));
    a.push('--allowedTools', [...pol.allowed, ...(x ? [x] : [])].join(','));
    a.push('--disallowedTools', pol.denied.filter((d) => d !== x).join(','));
  } else {
    a.push('--tools', '');
  }
  if (o.extraArgs) a.push(...o.extraArgs);
  return { cmd: o.claudeBin ?? 'claude', args: a, env, cwd: o.cwd, mcpConfig: { path: mcpPath, json }, profile: o.profile, protocol: o.protocol, model: o.model, mock, injected: o.injectExtraTool };
}

/* ------------------------------------------------------------------------------------------------ */
/* approval gate                                                                                     */
/* ------------------------------------------------------------------------------------------------ */

export interface ApprovalRequest { protocol: Protocol; conditions: string[]; model: string; split: string; max_total_usd: number; billing?: Billing; /** Claude Code account name (`claude-account`) the runs use. */ account?: string }
interface ApprovalEntry { protocol: Protocol | '*'; conditions: string[] | '*'; model: string; split: string; max_total_usd: number; billing?: Billing; account?: string }
export interface ApprovalFile { approved_by?: string; approved_at?: string; approvals?: ApprovalEntry[] }

export const normCondition = (c: string): string => c.replace(/^(agentic|single):/, '').replace(/@\d+k?$/, '');

function readApproval(p: string): ApprovalEntry[] | null {
  if (!fs.existsSync(p)) return null;
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw.approvals ? raw.approvals : [raw];
  return list as ApprovalEntry[];
}

export interface ApprovalCheck { ok: boolean; reason?: string; cap?: number }

/** Does an approval entry cover the request? (split 'all' / conditions '*' / model '*' are wildcards). */
export function checkApproval(req: ApprovalRequest, approvalPath = APPROVAL_PATH): ApprovalCheck {
  let entries: ApprovalEntry[] | null;
  try { entries = readApproval(approvalPath); } catch (e) { return { ok: false, reason: `APPROVAL.json unreadable: ${(e as Error).message}` }; }
  if (!entries) return { ok: false, reason: `no approval file at ${approvalPath}` };
  const why: string[] = [];
  for (const e of entries) {
    const w: string[] = [];
    if (e.protocol !== '*' && e.protocol !== req.protocol) w.push(`protocol ${e.protocol} != ${req.protocol}`);
    if (e.model !== '*' && e.model !== req.model) w.push(`model ${e.model} != ${req.model}`);
    if (e.split !== 'all' && e.split !== req.split) w.push(`split ${e.split} != ${req.split}`);
    if (e.conditions !== '*') {
      const have = new Set(e.conditions.map(normCondition));
      const miss = req.conditions.map(normCondition).filter((c) => !have.has(c));
      if (miss.length) w.push(`conditions not approved: ${miss.join(',')}`);
    }
    if ((e.billing ?? 'subscription') !== (req.billing ?? 'subscription')) w.push(`billing ${req.billing ?? 'subscription'} not approved (entry: ${e.billing ?? 'subscription'})`);
    if (e.account && e.account !== req.account) w.push(`account ${req.account ?? '(none)'} not approved (entry: ${e.account})`);
    if (!(typeof e.max_total_usd === 'number' && e.max_total_usd > 0)) w.push('max_total_usd missing');
    else if (req.max_total_usd > e.max_total_usd) w.push(`requested cap $${req.max_total_usd} > approved $${e.max_total_usd}`);
    if (!w.length) return { ok: true, cap: Math.min(req.max_total_usd, e.max_total_usd) };
    why.push(w.join('; '));
  }
  return { ok: false, reason: `no approval entry covers the request (${why.join(' | ')})` };
}

export class BillableRefused extends Error {}

export interface GuardOptions {
  approvalPath?: string; ledgerPath?: string; env?: NodeJS.ProcessEnv;
  /** Per-run ceiling (`--max-budget-usd`). REQUIRED for billable runs: it is also the reservation held while a run is in flight. */
  runUsd?: number;
}

/**
 * Gate + cost cap. One guard per invocation plan. Billable runs append to the ledger (so the cap holds across
 * invocations) and must satisfy, before starting:  spent + in_flight x run_usd + run_usd <= max_total_usd.
 */
export class BillableGuard {
  private spent = 0;
  private inflight = 0;
  private readonly ledger: string;
  private readonly approvalPath: string;
  private readonly env: NodeJS.ProcessEnv;
  readonly runUsd?: number;
  constructor(readonly req: ApprovalRequest, opts: GuardOptions = {}) {
    this.ledger = opts.ledgerPath ?? LEDGER_PATH;
    this.approvalPath = opts.approvalPath ?? APPROVAL_PATH;
    this.env = opts.env ?? process.env;
    this.runUsd = opts.runUsd;
  }
  get totalSpent(): number { return this.spent; }
  get inFlight(): number { return this.inflight; }

  /**
   * Throws BillableRefused unless the child env is fully mock, or the real-API gate passes. Returns true in mock mode.
   * `reserve` (default) holds `runUsd` for the run being started; release it with `record()` / `release()`.
   */
  assertAllowed(childEnv: Record<string, string>, reserve = true): boolean {
    const base = childEnv.ANTHROPIC_BASE_URL;
    if (base !== undefined) {
      if (!isOwnMockUrl(base)) throw new BillableRefused(`ANTHROPIC_BASE_URL=${base} is not a mock server started by this process (mock mode is never inferred from the environment)`);
      if (childEnv.ANTHROPIC_API_KEY !== DUMMY_API_KEY) throw new BillableRefused('mock mode requires the dummy API key');
      if (childEnv.ANTHROPIC_AUTH_TOKEN || childEnv.CLAUDE_CODE_OAUTH_TOKEN) throw new BillableRefused('mock mode must not carry auth tokens');
      return true;
    }
    if (this.env.AGENT_EVAL_BILLABLE !== '1') throw new BillableRefused('refusing a billable Claude Code run: AGENT_EVAL_BILLABLE=1 is not set');
    const c = checkApproval(this.req, this.approvalPath);
    if (!c.ok) throw new BillableRefused(`refusing a billable Claude Code run: ${c.reason}`);
    if (!(typeof this.runUsd === 'number' && this.runUsd > 0)) throw new BillableRefused('a per-run budget (--run-usd) is required for billable runs');
    const cap = c.cap!;
    const total = this.readLedger();
    if (total + (this.inflight + 1) * this.runUsd > cap) {
      throw new BillableRefused(`cost cap: $${total.toFixed(4)} spent + ${this.inflight + 1} x $${this.runUsd} (in flight + this run) > $${cap}`);
    }
    if (reserve) this.inflight++;
    return false;
  }

  /** Budget still available under the cap after spend and reservations (Infinity in mock mode). */
  remaining(childEnv: Record<string, string>): number {
    if (isOwnMockUrl(childEnv.ANTHROPIC_BASE_URL)) return Infinity;
    const c = checkApproval(this.req, this.approvalPath);
    return c.ok ? Math.max(0, c.cap! - this.readLedger() - this.inflight * (this.runUsd ?? 0)) : 0;
  }

  release(childEnv: Record<string, string>): void {
    if (!isOwnMockUrl(childEnv.ANTHROPIC_BASE_URL) && this.inflight > 0) this.inflight--;
  }

  /** Charge a finished run (releases its reservation). `costUsd` should be the ledger cost (max of reported and list-price). */
  record(runId: string, costUsd: number | null, childEnv: Record<string, string>, extra: Record<string, unknown> = {}): void {
    if (isOwnMockUrl(childEnv.ANTHROPIC_BASE_URL)) return; // mock: nothing is billed or recorded
    this.release(childEnv);
    this.append(runId, costUsd, extra);
  }

  /** Charge the full reservation of a run whose outcome is unknown (crash / abort of the harness). */
  chargeAborted(runId: string, status: string): void {
    if (this.env.AGENT_EVAL_BILLABLE !== '1' || !this.runUsd) return;
    this.append(runId, this.runUsd, { status, estimated: true });
  }

  private append(runId: string, costUsd: number | null, extra: Record<string, unknown>): void {
    this.spent += costUsd ?? 0;
    fs.mkdirSync(path.dirname(this.ledger), { recursive: true });
    fs.appendFileSync(this.ledger, JSON.stringify({ ts: new Date().toISOString(), run_id: runId, cost_usd: costUsd, protocol: this.req.protocol, model: this.req.model, ...extra }) + '\n');
  }

  private readLedger(): number {
    if (!fs.existsSync(this.ledger)) return 0;
    let t = 0;
    for (const l of fs.readFileSync(this.ledger, 'utf8').split('\n').filter(Boolean)) { try { t += JSON.parse(l).cost_usd ?? 0; } catch { /* ignore */ } }
    return t;
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* billable plan checks, pricing                                                                     */
/* ------------------------------------------------------------------------------------------------ */

/** Only `restricted-oauth` is leak-safe (others add /tmp as a working directory); only full model ids are reproducible. */
export function assertBillablePlan(o: { profile: string; model: string; injected?: string }): void {
  if (o.profile !== 'restricted-oauth') throw new BillableRefused(`billable runs require profile 'restricted-oauth' (got '${o.profile}': other profiles allow reads under /tmp, where sibling workspaces live)`);
  if (!/^claude-[a-z0-9.-]*\d/.test(o.model)) throw new BillableRefused(`billable runs require a pinned model id like 'claude-sonnet-5-5', not the alias '${o.model}'`);
  if (o.injected) throw new BillableRefused('fault injection is for mock mode only');
}

/** List prices, USD per million tokens (lead's table, Sonnet/Haiku/Opus 5.5). */
export const LIST_PRICES = {
  sonnet: { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  haiku: { in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  opus: { in: 4, out: 20, cacheRead: 0.2, cacheWrite: 5 },
} as const;
export function priceFor(model: string) {
  if (/haiku/i.test(model)) return LIST_PRICES.haiku;
  if (/sonnet/i.test(model)) return LIST_PRICES.sonnet;
  return LIST_PRICES.opus; // opus, and unknown models: the dearest (conservative for a cap)
}
export const usageCost = (u: TokenUsage, model: string): number => {
  const p = priceFor(model);
  return (u.input * p.in + u.output * p.out + u.cache_read * p.cacheRead + u.cache_write * p.cacheWrite) / 1e6;
};

/* ------------------------------------------------------------------------------------------------ */
/* stream-json parsing                                                                               */
/* ------------------------------------------------------------------------------------------------ */

export interface ParsedStream {
  init: any | null;
  result: any | null;
  toolCalls: { id: string; name: string; input: any }[];
  toolResults: { tool_use_id: string; is_error: boolean; text: string }[];
  assistantMessages: number;
  lastStructured: unknown;
  badLines: number;
  /** Per assistant message id: model and the usage it reported (for runs that die without a result event). */
  messageUsage: Map<string, { model: string; usage: TokenUsage }>;
}

const textOf = (c: unknown): string => typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: any) => b?.text ?? '').join('') : '';

export function parseStreamJson(text: string): ParsedStream {
  const out: ParsedStream = { init: null, result: null, toolCalls: [], toolResults: [], assistantMessages: 0, lastStructured: undefined, badLines: 0, messageUsage: new Map() };
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { out.badLines++; continue; }
    if (ev.type === 'system' && ev.subtype === 'init') out.init = ev;
    else if (ev.type === 'result') out.result = ev;
    else if (ev.type === 'assistant' && !ev.parent_tool_use_id) {
      out.assistantMessages++;
      if (ev.message?.id && ev.message?.usage) out.messageUsage.set(ev.message.id, { model: String(ev.message.model ?? ''), usage: resultUsage(ev.message.usage)! });
      for (const b of ev.message?.content ?? []) {
        if (b?.type !== 'tool_use' || seen.has(b.id)) continue;
        seen.add(b.id);
        out.toolCalls.push({ id: b.id, name: b.name, input: b.input });
        if (b.name === 'StructuredOutput') out.lastStructured = b.input;
      }
    } else if (ev.type === 'user') {
      for (const b of Array.isArray(ev.message?.content) ? ev.message.content : []) {
        if (b?.type === 'tool_result') out.toolResults.push({ tool_use_id: b.tool_use_id, is_error: !!b.is_error, text: textOf(b.content) });
      }
    }
  }
  return out;
}

const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

/** Sum of `modelUsage` over all models (covers auxiliary models too). Null when absent. */
export function sumModelUsage(mu: any): (TokenUsage & { cost: number }) | null {
  if (!mu || typeof mu !== 'object') return null;
  const t = { input: 0, output: 0, cache_read: 0, cache_write: 0, cost: 0 };
  const vals = Object.values(mu) as any[];
  if (!vals.length) return null;
  for (const m of vals) {
    t.input += num(m.inputTokens ?? m.input_tokens);
    t.output += num(m.outputTokens ?? m.output_tokens);
    t.cache_read += num(m.cacheReadInputTokens ?? m.cache_read_input_tokens);
    t.cache_write += num(m.cacheCreationInputTokens ?? m.cache_creation_input_tokens);
    t.cost += num(m.costUSD ?? m.cost_usd);
  }
  return t;
}

export function resultUsage(u: any): TokenUsage | null {
  if (!u || typeof u !== 'object') return null;
  return { input: num(u.input_tokens), output: num(u.output_tokens), cache_read: num(u.cache_read_input_tokens), cache_write: num(u.cache_creation_input_tokens) };
}

export function mapStopReason(result: any, hasDiagnosis: boolean, timedOut: boolean): string {
  if (timedOut) return 'timeout';
  if (!result) return 'error';
  const st = String(result.subtype ?? '');
  if (st === 'error_max_turns') return 'max_turns';
  if (st === 'error_max_budget_usd') return 'budget';
  if (st === 'success' && !result.is_error) return hasDiagnosis ? 'submitted' : 'no_structured_output';
  return 'error';
}

export interface RunMeta { run_id: string; task_id: string; condition: string; repeat: number; model: string; workspace_hash: string; backend?: string }

export interface ClaudeRunDetail {
  usage_result: TokenUsage | null;
  usage_model_sum: TokenUsage | null;
  permission_denials: unknown[];
  duration_api_ms: number | null;
  duration_ms: number | null;
  num_turns_reported: number | null;
  subtype: string | null;
  init_tools: string[];
  mcp_servers: unknown[];
  exit_code: number | null;
  timed_out: boolean;
  stderr_tail: string;
  tool_denials_text: string[];
}

export function toAgentRun(p: ParsedStream, meta: RunMeta, extra: { latency_ms: number; timed_out?: boolean; transcript_path?: string; mock: boolean; exit_code?: number | null; stderr?: string }): { run: AgentRun; detail: ClaudeRunDetail } {
  const res = p.result;
  // diagnosis: structured_output, else lenient parse of `result`, else the last StructuredOutput call seen in the stream.
  let diagnosis: Diagnosis | null = null;
  let parse_error: string | undefined;
  if (res?.structured_output != null) {
    const r = parseDiagnosis(res.structured_output);
    diagnosis = r.diagnosis; parse_error = r.error;
  } else if (typeof res?.result === 'string' && res.result.trim()) {
    const r = parseDiagnosis(res.result);
    diagnosis = r.diagnosis; parse_error = r.error;
  }
  if (!diagnosis && p.lastStructured != null) {
    const r = parseDiagnosis(p.lastStructured);
    if (r.diagnosis) { diagnosis = r.diagnosis; parse_error = undefined; }
  }
  if (!diagnosis && !parse_error) parse_error = res ? 'no structured_output and no parsable result text' : `no result event (exit ${extra.exit_code ?? '?'}): ${(extra.stderr ?? '').slice(-300)}`;
  if (res?.is_error && res.subtype !== 'success') parse_error = `${res.subtype}${parse_error ? '; ' + parse_error : ''}`;

  const uRes = resultUsage(res?.usage);
  const uSum = sumModelUsage(res?.modelUsage);
  const usage: TokenUsage | null = uSum ? { input: uSum.input, output: uSum.output, cache_read: uSum.cache_read, cache_write: uSum.cache_write } : uRes;
  const tool_calls: Record<string, number> = {};
  let retrieval_calls = 0;
  for (const c of p.toolCalls) {
    if (c.name === 'StructuredOutput') continue;
    tool_calls[c.name] = (tool_calls[c.name] ?? 0) + 1;
    if (c.name.startsWith('mcp__')) retrieval_calls++;
  }
  const run: AgentRun = {
    run_id: meta.run_id, task_id: meta.task_id, condition: meta.condition, backend: meta.backend ?? (extra.mock ? 'claude-code-mock' : 'claude-code'), model: meta.model, repeat: meta.repeat,
    diagnosis, parse_error, usage, usage_source: usage ? 'api-reported' : 'unavailable',
    cost_usd: typeof res?.total_cost_usd === 'number' ? res.total_cost_usd : null,
    latency_ms: extra.latency_ms, turns: typeof res?.num_turns === 'number' ? res.num_turns : p.assistantMessages || null,
    tool_calls, retrieval_calls, stop_reason: mapStopReason(res, !!diagnosis, !!extra.timed_out),
    transcript_path: extra.transcript_path, workspace_hash: meta.workspace_hash,
  };
  const detail: ClaudeRunDetail = {
    usage_result: uRes, usage_model_sum: uSum ? { input: uSum.input, output: uSum.output, cache_read: uSum.cache_read, cache_write: uSum.cache_write } : null,
    permission_denials: res?.permission_denials ?? [], duration_api_ms: typeof res?.duration_api_ms === 'number' ? res.duration_api_ms : null, duration_ms: typeof res?.duration_ms === 'number' ? res.duration_ms : null,
    num_turns_reported: typeof res?.num_turns === 'number' ? res.num_turns : null, subtype: res?.subtype ?? null,
    init_tools: p.init?.tools ?? [], mcp_servers: p.init?.mcp_servers ?? [], exit_code: extra.exit_code ?? null, timed_out: !!extra.timed_out,
    stderr_tail: (extra.stderr ?? '').slice(-1000), tool_denials_text: p.toolResults.filter((r) => r.is_error).map((r) => r.text),
  };
  return { run, detail };
}

/* ------------------------------------------------------------------------------------------------ */
/* running                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

/* ---------------------------- init fingerprint (isolation drift) ---------------------------- */

/** Exact MCP tool basenames each condition may expose (shipped tool lists minus the read-only deny list; mcp-notes.md). */
export const EXPECTED_MCP_TOOLS: Record<string, string[]> = {
  retrieval: ['search_code'],
  graphify: ['query_graph', 'get_node', 'get_neighbors', 'get_community', 'god_nodes', 'graph_stats', 'shortest_path'],
  'code-review-graph': ['get_minimal_context_tool', 'get_impact_radius_tool', 'query_graph_tool', 'get_review_context_tool', 'semantic_search_nodes_tool', 'list_graph_stats_tool', 'get_docs_section_tool',
    'find_large_functions_tool', 'list_flows_tool', 'get_flow_tool', 'get_affected_flows_tool', 'list_communities_tool', 'get_community_tool', 'get_architecture_overview_tool', 'detect_changes_tool',
    'refactor_tool', 'get_wiki_page_tool', 'get_hub_nodes_tool', 'get_bridge_nodes_tool', 'get_knowledge_gaps_tool', 'get_surprising_connections_tool', 'get_suggested_questions_tool', 'traverse_graph_tool'],
};

export interface InitFingerprint {
  tools: string[]; mcp_servers: { name: string; status: string }[]; model?: string; skills: unknown[]; slash_commands: unknown[]; plugins: { name: string; path?: string; source?: string }[];
  agents: unknown[]; apiKeySource?: string; claude_code_version?: string; permissionMode?: string;
}
export function fingerprintOf(init: any): InitFingerprint {
  return {
    tools: [...(init?.tools ?? [])], mcp_servers: (init?.mcp_servers ?? []).map((m: any) => ({ name: m.name, status: m.status })), model: init?.model, skills: init?.skills ?? [], slash_commands: init?.slash_commands ?? [],
    plugins: (init?.plugins ?? []).map((p: any) => ({ name: p.name, path: p.path, source: p.source })), agents: init?.agents ?? [], apiKeySource: init?.apiKeySource, claude_code_version: init?.claude_code_version, permissionMode: init?.permissionMode,
  };
}

export interface InitExpectation { mcp: McpServerSpec | null; model: string; version?: string; mock: boolean; billing?: Billing; /** Default agentic. Single-shot offers only StructuredOutput. */ protocol?: Protocol }
export interface InitMismatch { categories: string[]; details: string[] }

/** Compare a `system/init` event with the condition's expected set. Empty `categories` = OK. */
export function checkInit(init: any, exp: InitExpectation): InitMismatch {
  const fp = fingerprintOf(init);
  const cats = new Set<string>();
  const details: string[] = [];
  const flag = (c: string, d: string) => { cats.add(c); details.push(d); };
  const mcpPrefix = exp.mcp ? `mcp__${exp.mcp.name}__` : null;
  const expectedMcp = exp.mcp ? (EXPECTED_MCP_TOOLS[exp.mcp.name] ?? []).map((t) => `${mcpPrefix}${t}`) : [];
  const denied = new Set((exp.mcp?.denyTools ?? []).map((t) => `mcp__${exp.mcp!.name}__${t}`));
  const expected = new Set<string>(exp.protocol === 'single_shot' ? ['StructuredOutput'] : [...AGENT_TOOLS, 'StructuredOutput', ...expectedMcp]);
  const have = new Set(fp.tools);
  for (const t of have) {
    if (denied.has(t)) flag('denied_mcp_tool', `denied tool offered: ${t}`);
    else if (!expected.has(t)) flag('extra_tool', `unexpected tool: ${t}`);
  }
  for (const t of expected) if (!have.has(t)) flag('missing_tool', `missing tool: ${t}`);
  if (fp.skills.length) flag('skills', `skills listed: ${JSON.stringify(fp.skills).slice(0, 120)}`);
  // MCP prompts of the condition's own server (CRG ships five) surface as `mcp__<server>__<prompt>` slash commands; anything else is drift.
  const badCmds = fp.slash_commands.filter((c) => !(mcpPrefix && String(c).startsWith(mcpPrefix)));
  if (badCmds.length) flag('slash_commands', `slash commands listed: ${JSON.stringify(badCmds).slice(0, 120)}`);
  const badPlugins = fp.plugins.filter((p) => p.path !== 'builtin');
  if (badPlugins.length) flag('plugins', `non-builtin plugins: ${badPlugins.map((p) => p.name).join(',')}`);
  const names = fp.mcp_servers.map((m) => m.name).sort();
  const want = exp.mcp ? [exp.mcp.name] : [];
  if (names.join('|') !== want.join('|')) flag('mcp_servers', `mcp servers ${JSON.stringify(names)} != ${JSON.stringify(want)}`);
  for (const m of fp.mcp_servers) if (exp.mcp && m.name === exp.mcp.name && m.status !== 'connected') flag('mcp_not_connected', `mcp server ${m.name} status ${m.status}`);
  if (/^claude-/.test(exp.model) && fp.model && fp.model !== exp.model) flag('model', `model ${fp.model} != ${exp.model}`);
  if (exp.version && fp.claude_code_version && fp.claude_code_version !== exp.version) flag('version', `claude_code_version ${fp.claude_code_version} != ${exp.version}`);
  if (fp.permissionMode && fp.permissionMode !== 'dontAsk') flag('permission_mode', `permissionMode ${fp.permissionMode}`);
  if (!exp.mock && exp.billing === 'api-key' && fp.apiKeySource !== 'ANTHROPIC_API_KEY') flag('api_key_source', `apiKeySource ${fp.apiKeySource} (expected ANTHROPIC_API_KEY for approved API-key billing)`);
  if (!exp.mock && exp.billing !== 'api-key' && (fp.apiKeySource === 'ANTHROPIC_API_KEY' || fp.apiKeySource === 'ANTHROPIC_AUTH_TOKEN')) flag('api_key_source', `apiKeySource ${fp.apiKeySource} (would bill the API, not the subscription)`);
  if (!init) flag('no_init', 'no system/init event');
  return { categories: [...cats].sort(), details };
}

/* --------------------------------- outcome classification --------------------------------- */

export type OutcomeStatus = 'submitted' | 'max_turns' | 'budget' | 'no_structured_output' | 'infra_error' | 'init_mismatch' | 'aborted';
export type InfraKind = 'auth' | 'limit' | 'api_error' | 'crash' | 'no_result' | 'timeout' | 'spawn' | 'harness';
export interface Outcome { status: OutcomeStatus; infra_kind?: InfraKind; reason?: string; text?: string }

const AUTH_RE = /authenticat|unauthori[sz]ed|invalid (x-)?api[ -]?key|invalid bearer|not logged in|\/login|oauth token|credit balance|permission_error|\b40[13]\b/i;
const LIMIT_RE = /usage limit|rate[ _-]?limit|limit reached|quota|resets? at|too many requests|\b429\b|out of (extra )?usage/i;

/** Agent outcomes (submitted / max_turns / budget / no_structured_output) are scored; everything else is infrastructure and never scored. */
export function classifyOutcome(p: ParsedStream, c: { exitCode: number | null; timedOut: boolean; spawnError?: boolean; initMismatch?: string; aborted?: string; hasDiagnosis: boolean; stderr?: string }): Outcome {
  if (c.aborted) return { status: 'aborted', reason: c.aborted };
  if (c.initMismatch) return { status: 'init_mismatch', reason: c.initMismatch };
  if (c.spawnError) return { status: 'infra_error', infra_kind: 'spawn', reason: 'could not spawn claude' };
  if (c.timedOut) return { status: 'infra_error', infra_kind: 'timeout', reason: 'timeout' };
  const res = p.result;
  const text = String(res?.result ?? res?.error ?? '') + ' ' + (res?.errors ?? []).join?.(' ') + ' ' + (c.stderr ?? '').slice(-400);
  if (!res) return { status: 'infra_error', infra_kind: c.exitCode ? 'crash' : 'no_result', reason: `no result event (exit ${c.exitCode ?? '?'})`, text: text.slice(0, 300) };
  const st = String(res.subtype ?? '');
  if (res.is_error && st === 'success') {
    const kind: InfraKind = AUTH_RE.test(text) ? 'auth' : LIMIT_RE.test(text) ? 'limit' : 'api_error';
    return { status: 'infra_error', infra_kind: kind, reason: `error result: ${String(res.result ?? '').slice(0, 160)}`, text: text.slice(0, 300) };
  }
  if (st === 'error_max_turns') return { status: 'max_turns' };
  if (st === 'error_max_budget_usd') return { status: 'budget' };
  if (st === 'error_max_structured_output_retries') return { status: 'no_structured_output' };
  if (st === 'success') return { status: c.hasDiagnosis ? 'submitted' : 'no_structured_output' };
  return { status: 'infra_error', infra_kind: LIMIT_RE.test(text) ? 'limit' : AUTH_RE.test(text) ? 'auth' : 'crash', reason: `result subtype ${st}`, text: text.slice(0, 300) };
}

/* ---------------------------- live children, signals, abort hooks ---------------------------- */

const liveChildren = new Set<ChildProcess>();
const abortHooks = new Set<(why: 'aborted' | 'crashed') => void>();
let handlersInstalled = false;

export function killAllChildren(sig: NodeJS.Signals = 'SIGKILL'): void {
  for (const c of liveChildren) { try { process.kill(-c.pid!, sig); } catch { /* gone */ } }
}
/** Register a hook that runs (synchronously) when the harness is interrupted or crashes. Returns an unregister function. */
export function onHarnessAbort(fn: (why: 'aborted' | 'crashed') => void): () => void { abortHooks.add(fn); return () => abortHooks.delete(fn); }

/** SIGINT/SIGTERM/exit/uncaught errors: record aborted/crashed entries, kill every child process group, then exit. */
export function installSignalHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  let done = false;
  const finish = (why: 'aborted' | 'crashed') => {
    if (done) return;
    done = true;
    for (const h of abortHooks) { try { h(why); } catch { /* best effort */ } }
    killAllChildren('SIGKILL');
  };
  process.on('SIGINT', () => { finish('aborted'); process.exit(130); });
  process.on('SIGTERM', () => { finish('aborted'); process.exit(143); });
  process.on('uncaughtException', (e) => { console.error(e); finish('crashed'); process.exit(1); });
  process.on('unhandledRejection', (e) => { console.error(e); finish('crashed'); process.exit(1); });
  process.on('exit', () => { killAllChildren('SIGKILL'); });
}

/* ------------------------------------------- running ------------------------------------------- */

export interface RunClaudeOptions {
  guard: BillableGuard; timeoutMs?: number; transcriptPath?: string;
  /** Called with the first `system/init` event. A non-empty return value is a mismatch reason: the process group is killed at once. */
  onInit?: (init: any) => string | null;
  /** Aborts the run (kills the group) when this returns a reason; polled while running. */
  shouldAbort?: () => string | null;
}

export interface RunTiming { wall_ms: number; init_ms: number | null; close_ms: number }
export interface RunCost { reported: number | null; list: number | null; ledger: number }
export interface RunClaudeResult { run: AgentRun; detail: ClaudeRunDetail; raw: string; outcome: Outcome; timing: RunTiming; cost: RunCost; init: InitFingerprint | null }

/**
 * Spawns `claude` (own process group), feeds the prompt on stdin, parses the stream. Refuses (BillableRefused) per the gate.
 * Never throws for model/infra failures: they come back as `outcome`.
 */
export async function runClaude(spec: ClaudeCommand, prompt: string, meta: RunMeta, opts: RunClaudeOptions): Promise<RunClaudeResult> {
  const mock = opts.guard.assertAllowed(spec.env, false); // plan checks first, reservation after them
  if (spec.mock !== mock) throw new BillableRefused('command/env mock-mode mismatch');
  if (!mock) assertBillablePlan({ profile: spec.profile, model: spec.model, injected: spec.injected });
  opts.guard.assertAllowed(spec.env, true);
  let reserved = !mock;
  try {
    fs.mkdirSync(path.dirname(spec.mcpConfig.path), { recursive: true });
    fs.writeFileSync(spec.mcpConfig.path, spec.mcpConfig.json);
    let args = spec.args;
    if (!mock) { // per-run ceiling = the reservation
      args = [...args];
      const i = args.indexOf('--max-budget-usd');
      if (i >= 0) args[i + 1] = String(opts.guard.runUsd); else args.push('--max-budget-usd', String(opts.guard.runUsd));
    }
    const t0 = Date.now();
    const child = spawn(spec.cmd, args, { cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    liveChildren.add(child);
    let stdout = '', stderr = '', buf = '', timedOut = false, spawnError = false;
    let initMismatch: string | undefined, aborted: string | undefined, initMs: number | null = null, resultMs: number | null = null, sawInit = false;
    const killGroup = (sig: NodeJS.Signals) => { try { process.kill(-child.pid!, sig); } catch { /* gone */ } };
    const handleLine = (line: string) => {
      if (!sawInit && line.includes('"subtype":"init"') && line.includes('"type":"system"')) {
        sawInit = true; initMs = Date.now() - t0;
        try {
          const ev = JSON.parse(line);
          const why = opts.onInit?.(ev);
          if (why) { initMismatch = why; killGroup('SIGKILL'); }
        } catch { /* parsed again later */ }
      } else if (resultMs == null && line.startsWith('{"type":"result"')) resultMs = Date.now() - t0;
    };
    child.stdout.on('data', (d) => {
      const t = String(d); stdout += t; buf += t;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) { handleLine(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
    });
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdin.on('error', () => undefined);
    child.stdin.end(prompt);
    const timer = setTimeout(() => { timedOut = true; killGroup('SIGTERM'); setTimeout(() => killGroup('SIGKILL'), 5000).unref(); }, opts.timeoutMs ?? 600_000);
    const poll = opts.shouldAbort ? setInterval(() => { const w = opts.shouldAbort!(); if (w && !aborted) { aborted = w; killGroup('SIGKILL'); } }, 250) : null;
    const code = await new Promise<number | null>((resolve) => { child.on('error', () => { spawnError = true; resolve(null); }); child.on('close', (c) => resolve(c)); });
    clearTimeout(timer);
    if (poll) clearInterval(poll);
    if (buf) handleLine(buf);
    killGroup('SIGKILL'); // MCP server children
    liveChildren.delete(child);
    const closeMs = Date.now() - t0;
    if (opts.transcriptPath) { fs.mkdirSync(path.dirname(opts.transcriptPath), { recursive: true }); fs.writeFileSync(opts.transcriptPath, stdout); }
    const parsed = parseStreamJson(stdout);
    const wall = resultMs ?? closeMs;
    const out = toAgentRun(parsed, meta, { latency_ms: wall, timed_out: timedOut, transcript_path: opts.transcriptPath, mock, exit_code: code, stderr });
    const outcome = classifyOutcome(parsed, { exitCode: code, timedOut, spawnError, initMismatch, aborted, hasDiagnosis: !!out.run.diagnosis, stderr });
    // cost: Claude Code's number AND our own list-price recomputation; the ledger takes the larger.
    const res = parsed.result;
    let list: number | null = null;
    if (res?.modelUsage && Object.keys(res.modelUsage).length) {
      list = 0;
      for (const [m, v] of Object.entries<any>(res.modelUsage)) list += usageCost({ input: num(v.inputTokens ?? v.input_tokens), output: num(v.outputTokens ?? v.output_tokens), cache_read: num(v.cacheReadInputTokens ?? v.cache_read_input_tokens), cache_write: num(v.cacheCreationInputTokens ?? v.cache_creation_input_tokens) }, m);
    } else if (res?.usage) list = usageCost(resultUsage(res.usage)!, spec.model);
    else if (parsed.messageUsage.size) { list = 0; for (const v of parsed.messageUsage.values()) list += usageCost(v.usage, v.model || spec.model); }
    const reported = out.run.cost_usd;
    let ledger = Math.max(reported ?? 0, list ?? 0);
    if (!mock && !res && (timedOut || outcome.status === 'aborted') && ledger === 0) ledger = opts.guard.runUsd ?? 0; // unknown spend: charge the reservation
    opts.guard.record(meta.run_id, ledger, spec.env, { status: outcome.status, cost_reported: reported, cost_list: list });
    reserved = false;
    return { ...out, raw: stdout, outcome, timing: { wall_ms: wall, init_ms: initMs, close_ms: closeMs }, cost: { reported, list, ledger }, init: parsed.init ? fingerprintOf(parsed.init) : null };
  } finally { if (reserved) opts.guard.release(spec.env); }
}

/* ------------------------------------------------------------------------------------------------ */
/* single-shot backend                                                                               */
/* ------------------------------------------------------------------------------------------------ */

export interface SingleShotOptions {
  /** Explicit mock server URL (`MockServer.url`); mock mode is never read from ANTHROPIC_BASE_URL. */ mockUrl?: string;
  runUsd?: number; profile?: ProfileName; maxTotalUsd?: number; split?: string; concurrency?: number; timeoutMs?: number; guard?: BillableGuard;
  effort?: string; billing?: Billing;
  /** Claude Code account name (approval) and its child base environment (`resolveAccount(...).env`). */
  account?: string; baseEnv?: NodeJS.ProcessEnv;
  /** Expected Claude Code version (init fingerprint); a change halts the run. */
  version?: string;
  /** Run order seed (seeded shuffle of the items; null keeps the given order). */
  seed?: number | null;
  log?: (s: string) => void;
}

export const SINGLE_SHOT_SEED = 20261108;

function seededShuffle<T>(xs: T[], seed: number): T[] {
  let a = seed >>> 0;
  const rand = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

const readJsonlFile = (p: string): any[] => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : []);

/**
 * Single-shot over Claude Code: no tools (`--tools ""`), json-schema structured output, one call per item.
 * `billable` is always true (the approval gate decides at run time; mock mode only with an explicit mockUrl).
 *
 * Same run discipline as the agentic harness: every finished call is appended to `<workDir>/ss-raw.jsonl` at once,
 * so re-running the same run id resumes; infrastructure failures and init-fingerprint mismatches are excluded (never
 * scored; infra errors get one retry); an auth/usage-limit error, 3 consecutive infra errors, 2 consecutive identical
 * init mismatches or a version change halt the run (remaining items come back as `excluded: 'pending'`).
 */
export function claudeSingleShot(model: string, opts: SingleShotOptions = {}): SingleShotBackend {
  const mockUrl = opts.mockUrl;
  const profile = opts.profile ?? (process.env.AGENT_EVAL_PROFILE as ProfileName | undefined) ?? 'restricted-oauth';
  const log = opts.log ?? ((m: string) => console.error(m));
  return {
    name: mockUrl ? 'claude-code-mock' : 'claude-code', model, billable: true,
    async run(items: SingleShotItem[], workDir: string): Promise<SingleShotResults> {
      let guard = opts.guard;
      if (!guard) {
        const taskIds = new Set(items.map((i) => i.id.split('|')[0]));
        const splits = selectTasksSplits(taskIds);
        const conditions = [...new Set(items.map((i) => i.id.split('|')[1] ?? ''))];
        guard = new BillableGuard({ protocol: 'single_shot', conditions, model, split: opts.split ?? (splits.size === 1 ? [...splits][0] : 'mixed'), max_total_usd: opts.maxTotalUsd ?? readApprovedCap(), billing: opts.billing ?? 'subscription', account: opts.account }, { runUsd: opts.runUsd });
      }
      if (!mockUrl) guard.assertAllowed({}, false); // fail fast, before anything runs
      fs.mkdirSync(workDir, { recursive: true });
      const rawFile = path.join(workDir, 'ss-raw.jsonl');
      const prior = readJsonlFile(rawFile);
      const done = new Map<string, SingleShotResult>();
      const attempts = new Map<string, number>();
      const final = new Map<string, string>();
      for (const r of prior) {
        if (!r.excluded) done.set(r.id, r);
        else if (r.excluded === 'aborted') continue;
        else { attempts.set(r.id, (attempts.get(r.id) ?? 0) + 1); if (r.retryable === false || (attempts.get(r.id) ?? 0) >= 2) final.set(r.id, r.excluded); }
      }
      const order = opts.seed === null ? items : seededShuffle(items, opts.seed ?? SINGLE_SHOT_SEED);
      const todo = order.filter((it) => !done.has(it.id) && !final.has(it.id));
      log(`single-shot: ${items.length} items, ${done.size} done, ${final.size} finally excluded, ${todo.length} to run`);
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-'));
      let halted: string | null = null;
      const halt = (why: string) => { if (!halted) { halted = why; log(`HALT: ${why}`); } };
      let infraStreak = 0, initStreak = { reason: '', n: 0 };
      const inflight = new Set<string>();
      const g = guard;
      const unhook = onHarnessAbort((why) => {
        for (const id of inflight) {
          try { fs.appendFileSync(rawFile, JSON.stringify({ id, excluded: 'aborted', status: why, ts: new Date().toISOString() }) + '\n'); } catch { /* best effort */ }
          if (!mockUrl) g.chargeAborted(id, why);
        }
      });
      const runOne = async (it: SingleShotItem, attempt: number): Promise<'ok' | 'retry' | 'stop'> => {
        const spec = buildClaudeCommand({ protocol: 'single_shot', profile, model, cwd: scratch, systemPrompt: it.system, mockUrl, mcpConfigPath: path.join(workDir, 'empty-mcp.json'), effort: opts.effort, billing: opts.billing, baseEnv: opts.baseEnv, maxBudgetUsd: opts.runUsd, claudeBin: process.env.AGENT_EVAL_CLAUDE_BIN });
        const tag = crypto.createHash('sha1').update(it.id).digest('hex').slice(0, 12);
        inflight.add(it.id);
        try {
          const r = await runClaude(spec, it.prompt, { run_id: it.id, task_id: it.id.split('|')[0], condition: it.id.split('|')[1] ?? '', repeat: Number(it.id.split('|')[2] ?? 0), model, workspace_hash: '' }, {
            guard: g, timeoutMs: opts.timeoutMs ?? 300_000, transcriptPath: path.join(workDir, 'transcripts', `${tag}${attempt > 1 ? `_try${attempt}` : ''}.jsonl`),
            onInit: (init) => { const m = checkInit(init, { protocol: 'single_shot', mcp: null, model, version: opts.version, mock: !!mockUrl, billing: opts.billing }); return m.categories.length ? m.categories.join(',') + ' :: ' + m.details.join(' | ') : null; },
            shouldAbort: () => halted,
          });
          const oc = r.outcome;
          const extra = { status: oc.status, attempt, effort: opts.effort ?? null, cost_reported_usd: r.cost.reported, cost_list_usd: r.cost.list, cost_ledger_usd: r.cost.ledger, wall_ms: r.timing.wall_ms, init_ms: r.timing.init_ms, api_duration_ms: r.detail.duration_api_ms, stop_detail: r.run.stop_reason, init: r.init, claude_version: r.init?.claude_code_version ?? null };
          if (oc.status === 'infra_error' || oc.status === 'init_mismatch' || oc.status === 'aborted') {
            const excluded = oc.status === 'infra_error' ? `infra_error:${oc.infra_kind}` : oc.status === 'init_mismatch' ? `init_mismatch:${(oc.reason ?? '').split(' :: ')[0]}` : 'aborted';
            const retryable = oc.status === 'infra_error';
            fs.appendFileSync(rawFile, JSON.stringify({ id: it.id, excluded, retryable, detail: [oc.reason, oc.text].filter(Boolean).join(' | ').slice(0, 600), ...extra, ts: new Date().toISOString() }) + '\n');
            log(`${it.id} EXCLUDED ${excluded} (attempt ${attempt})`);
            if (oc.status === 'aborted') return 'stop';
            if (oc.status === 'init_mismatch') {
              infraStreak = 0;
              const reason = (oc.reason ?? '').split(' :: ')[0];
              initStreak = initStreak.reason === reason ? { reason, n: initStreak.n + 1 } : { reason, n: 1 };
              if (reason.split(',').includes('version')) halt(`Claude Code version changed during the experiment (${oc.reason})`);
              else if (initStreak.n >= 2) halt(`2 consecutive init-fingerprint exclusions: ${oc.reason}`);
              return 'stop';
            }
            initStreak = { reason: '', n: 0 };
            infraStreak++;
            if (oc.infra_kind === 'auth' || oc.infra_kind === 'limit') halt(`${oc.infra_kind} / usage-limit error: ${(oc.text ?? oc.reason ?? '').slice(0, 200)}`);
            else if (infraStreak >= 3) halt('3 consecutive infrastructure errors');
            return 'retry';
          }
          infraStreak = 0; initStreak = { reason: '', n: 0 };
          const res: SingleShotResult = { id: it.id, raw: r.run.diagnosis, usage: r.run.usage, usage_source: r.run.usage_source, cost_usd: r.run.cost_usd, latency_ms: r.run.latency_ms, error: r.run.diagnosis ? undefined : r.run.parse_error ?? r.run.stop_reason, extra };
          fs.appendFileSync(rawFile, JSON.stringify({ ...res, ts: new Date().toISOString() }) + '\n');
          done.set(it.id, res);
          log(`${it.id} ${oc.status} ledger=$${r.cost.ledger.toFixed(4)} wall=${(r.timing.wall_ms / 1000).toFixed(1)}s`);
          return 'ok';
        } finally { inflight.delete(it.id); }
      };
      let next = 0;
      const worker = async () => {
        for (;;) {
          if (halted) return;
          const it = todo[next++];
          if (!it) return;
          for (let attempt = (attempts.get(it.id) ?? 0) + 1; attempt <= 2 && !halted; attempt++) {
            let v: 'ok' | 'retry' | 'stop';
            try { v = await runOne(it, attempt); } catch (e) {
              if (e instanceof BillableRefused) { halt(e.message); return; }
              fs.appendFileSync(rawFile, JSON.stringify({ id: it.id, excluded: 'infra_error:harness', retryable: true, detail: String((e as Error).stack ?? e).slice(0, 600), attempt, ts: new Date().toISOString() }) + '\n');
              infraStreak++;
              if (infraStreak >= 3) halt('3 consecutive infrastructure errors');
              v = 'retry';
            }
            if (v !== 'retry') break;
          }
        }
      };
      try { await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 1) }, worker)); } finally { unhook(); fs.rmSync(scratch, { recursive: true, force: true }); }
      // final exclusion = non-retryable, or two failed attempts; anything else not done is still pending (resume runs it)
      const n = new Map<string, number>(), finalNow = new Map<string, string>();
      for (const r of readJsonlFile(rawFile)) {
        if (!r.excluded || r.excluded === 'aborted') continue;
        n.set(r.id, (n.get(r.id) ?? 0) + 1);
        if (r.retryable === false || (n.get(r.id) ?? 0) >= 2) finalNow.set(r.id, r.excluded);
      }
      const out = items.map((it) => done.get(it.id) ?? { id: it.id, raw: null, usage: null, usage_source: 'unavailable' as const, cost_usd: null, latency_ms: 0, excluded: finalNow.get(it.id) ?? 'pending' }) as SingleShotResults;
      out.halted = halted;
      out.meta = { effort: opts.effort ?? null, billing: opts.billing ?? 'subscription', account: opts.account ?? null, run_usd: opts.runUsd ?? null, seed: opts.seed === null ? null : opts.seed ?? SINGLE_SHOT_SEED, profile, expected_version: opts.version ?? null };
      return out;
    },
  };
}

function selectTasksSplits(taskIds: Set<string>): Set<string> {
  try { return new Set(loadTasks(abs(loadConfig().dataset.tasks_dir)).filter((t) => taskIds.has(t.task_id)).map((t) => t.split as string)); } catch { return new Set(); }
}

function readApprovedCap(): number {
  try { const e = readApproval(APPROVAL_PATH); return Math.max(...(e ?? []).map((x) => x.max_total_usd), 0) || 0.01; } catch { return 0.01; }
}
