/**
 * Experiment 2, agentic protocol: Claude Code (headless) diagnoses each bug in an isolated workspace with read-only
 * tools (Read/Grep/Glob) plus, depending on the condition, ONE retrieval MCP server.
 *
 *   agentic --split dev|test --conditions baseline,hybrid,... --repeats R --model claude-sonnet-5-5 --profile restricted-oauth
 *           [--mock-api scripted|echo-structured|infra-auth|infra-limit|inject-extra-tool] [--task-ids id,..] --run ID [--parallel N]
 *           [--budget 4000] [--max-turns 40] [--max-usd N] [--run-usd N (required when billable)] [--timeout-s 900] [--effort high] [--keep-workspaces]
 *
 * Run order: one seeded shuffle (seed 20261108) of all (task, condition, repeat) items, persisted in plan.json and reused on resume.
 * Results are append-only (never deleted): runs.jsonl (scored), excluded.jsonl, raw-runs.jsonl (everything), ledger.jsonl (cost per attempt).
 * Re-running the same --run resumes: finished run_ids are skipped. Excluded runs are never scored; infra errors are retried once.
 * Halts: 2 consecutive init-fingerprint exclusions with the same reason (version drift: at once), 3 consecutive infra errors,
 * an auth or usage-limit error at once. SIGINT/SIGTERM kill every child process group and write aborted ledger entries.
 *
 * Real (billable) runs are refused unless experiments/02-agent-diagnosis/APPROVAL.json covers the plan and
 * AGENT_EVAL_BILLABLE=1 is set (see backends/claude-code.ts). `--mock-api` runs everything against the local mock server.
 */
import { accountRecord, assertSubscriptionAccount, resolveAccount, type AccountInfo } from './account.js';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { abs, type BenchmarkConfig } from '../config.js';
import { loadTasks } from '../evaluation/ground-truth.js';
import type { SymbolIndex } from '../evaluation/symbol-index.js';
import type { GroundTruthTask } from '../types.js';
import { assertBillablePlan, buildClaudeCommand, BillableGuard, BillableRefused, checkInit, installSignalHandlers, ISOLATION_ENV, onHarnessAbort, PROFILE_NAMES, runClaude, toolPolicy, type ClaudeRunDetail, type InitFingerprint, type McpServerSpec, type OutcomeStatus, type ProfileName } from './backends/claude-code.js';
import { EXP_DIR } from './contexts.js';
import { report } from './analysis.js';
import { competitorServerSpec } from './mcp/competitor-servers.js';
import { SERVER_METHODS } from './mcp/retrieval-server.js';
import { startMockServer, FIXED_DIAGNOSIS, type MockPolicy, type MockStep } from './mock-anthropic/server.js';
import { agentSystemPrompt, agentTaskPrompt, AGENT_PROMPT_VERSIONS, type AgentPromptVersion } from './prompt.js';
import { bugLocations, scoreDiagnosis, snapshotIndex } from './scoring.js';
import type { ScoredRun } from './runner.js';
import { buildWorkspace, checkWorkspaceIsolation, workspaceHash, type Workspace } from './workspace.js';

export const OUR_METHODS = SERVER_METHODS.filter((m) => m !== 'ripgrep');
export const COMPETITORS = ['graphify', 'crg'] as const;
export const ALL_CONDITIONS = ['baseline', ...OUR_METHODS, ...COMPETITORS];

/**
 * Read-only policy for every condition: write-capable, graph-mutating or network-capable tools of the competitor servers
 * are denied (`mcp__<server>__<tool>`); everything else of each server is allowed (`mcp__<server>__*`).
 * Names from experiments/02-agent-diagnosis/mcp-notes.md section 4.2.
 */
export const DENY_TOOLS: Record<string, string[]> = {
  crg: ['apply_refactor_tool', 'generate_wiki_tool', 'build_or_update_graph_tool', 'embed_graph_tool', 'run_postprocess_tool', 'cross_repo_search_tool', 'list_repos_tool'],
  graphify: ['list_prs', 'get_pr_impact', 'triage_prs'],
};
export const SERVER_NAME: Record<string, string> = { graphify: 'graphify', crg: 'code-review-graph' };
/** Methods whose server loads the embedding model on the GPU (~1.3 GB each). */
export const EMBEDDING_CONDITIONS = ['hybrid', 'embeddings'];
export const MAX_EMBEDDING_SERVERS = 2;
export type MockApiMode = 'scripted' | 'echo-structured' | 'infra-auth' | 'infra-limit' | 'inject-extra-tool';

/** Static tool policy of a condition (what is recorded in meta.json). */
export function conditionToolPolicy(condition: string) {
  const name = condition === 'baseline' ? null : SERVER_NAME[condition] ?? 'retrieval';
  return toolPolicy('agentic', name ? { name, command: '', args: [], denyTools: DENY_TOOLS[condition] ?? [] } : null);
}

/** CRG's embed tool is denied (write-capable), so the arm is CRG as shipped by default: FTS5/BM25 search only. */
export const CONDITION_LABELS: Record<string, string> = { crg: 'crg-default-fts' };
export const SHUFFLE_SEED = 20261108;
export const DEFAULT_MODEL = 'claude-sonnet-5-5';
export const DEFAULT_EFFORT = 'high';
export const DEFAULT_MAX_TURNS = 40;

export interface AgenticRun extends ScoredRun {
  profile: ProfileName;
  workspace_modified: boolean;
  permission_denials: number;
  api_duration_ms: number | null;
  usage_result_event: ClaudeRunDetail['usage_result'];
  mcp_status: unknown[];
  /** Set when the run must not be counted (e.g. 'mcp_not_connected'); such runs go to excluded.jsonl, not runs.jsonl. */
  excluded?: string;
  excluded_kind?: string;
  retryable?: boolean;
  excluded_detail?: string;
  attempt: number;
  position: number;
  status: OutcomeStatus;
  condition_label: string;
  effort: string;
  claude_version: string;
  /** Claude Code's `total_cost_usd`, our own list-price recomputation from usage, and the larger of the two (what the ledger and the cap use). */
  cost_reported_usd: number | null;
  cost_list_usd: number | null;
  cost_ledger_usd: number;
  /** spawn -> result event (also `latency_ms`), result.duration_ms, result.duration_api_ms (also `api_duration_ms`). */
  wall_ms: number;
  duration_ms: number | null;
  /** spawn -> system/init event: an UPPER-BOUND estimate of MCP start-up (includes Claude Code's own start-up); null without an MCP server. */
  mcp_startup_ms: number | null;
  init_ms: number | null;
  /** Graph/index build done before the run (competitor build_ms; our servers' shared custom-graph cache warm-up); null when the server builds nothing separately. */
  index_build_ms: number | null;
  init: InitFingerprint | null;
}

/** The MCP server a condition attaches (null for the baseline). Competitor servers are built here (graph build, outside the workspace). */
export async function conditionServer(condition: string, ws: Workspace, o: { budget: number; logFile: string }): Promise<(McpServerSpec & { build_ms?: number }) | null> {
  if (condition === 'baseline') return null;
  if ((OUR_METHODS as readonly string[]).includes(condition)) {
    return {
      name: 'retrieval', command: abs('node_modules/.bin/tsx'),
      args: [abs('src/agent-eval/mcp/retrieval-server.ts'), '--method', condition, '--workspace', ws.dir, '--budget', String(o.budget), '--log', o.logFile],
      env: { HF_HUB_OFFLINE: '1', TOKENIZERS_PARALLELISM: 'false' },
      denyTools: [],
    };
  }
  if (condition === 'graphify' || condition === 'crg') {
    const s = await competitorServerSpec(condition, ws);
    if (s.name !== SERVER_NAME[condition]) throw new Error(`competitor server name '${s.name}' != expected '${SERVER_NAME[condition]}' (update SERVER_NAME / DENY_TOOLS)`);
    return { name: s.name, command: s.command, args: s.args, env: s.env, denyTools: DENY_TOOLS[condition], build_ms: s.build_ms };
  }
  throw new Error(`unknown condition '${condition}' (expected one of ${ALL_CONDITIONS.join(', ')})`);
}

/** Default scripted mock conversation: search, (retrieval), read inside the workspace, forbidden read probe, submit. */
export function defaultScript(withMcp: boolean): MockStep[] {
  return [
    { tool: 'Grep', input: { pattern: 'refresh' } },
    ...(withMcp ? [{ tool: 'mcp:auto', input: { $fill: 'refresh token' } } as MockStep] : []),
    { tool: 'Read', input: { file_path: 'src/auth/auth.service.ts' } },
    { tool: 'Read', input: { file_path: abs('evaluation/dataset/tasks/auth_jwt_secret_01.json') } },
    { structured: FIXED_DIAGNOSIS },
  ];
}


function scorerFor(cfg: BenchmarkConfig) {
  const cache = new Map<string, { index: SymbolIndex; bugs: ReturnType<typeof bugLocations> }>();
  return (t: GroundTruthTask) => {
    let c = cache.get(t.task_id);
    if (!c) { c = { index: snapshotIndex(cfg, t.task_id), bugs: bugLocations(cfg, t.task_id) }; cache.set(t.task_id, c); }
    return c;
  };
}

class Semaphore {
  private waiters: (() => void)[] = [];
  constructor(private n: number) {}
  async acquire(): Promise<void> { if (this.n > 0) { this.n--; return; } await new Promise<void>((r) => this.waiters.push(r)); }
  release(): void { const w = this.waiters.shift(); if (w) w(); else this.n++; }
}

/**
 * Start one custom_graph server on the snapshot and wait for `[ready]`, so its graph cache (shared per corpus hash) exists
 * before parallel runs (two servers starting at once on an uncached snapshot race on the cache file).
 */
export async function warmSnapshot(cfg: BenchmarkConfig, taskId: string, tag: string): Promise<number> {
  const t0 = Date.now();
  const ws = buildWorkspace(cfg, taskId, `${tag}|warm`);
  const logFile = path.join(os.tmpdir(), `warm-${process.pid}-${taskId}.jsonl`);
  try {
    await new Promise<void>((resolve, reject) => {
      const c = spawn(abs('node_modules/.bin/tsx'), [abs('src/agent-eval/mcp/retrieval-server.ts'), '--method', 'custom_graph', '--workspace', ws.dir, '--budget', '1000', '--log', logFile], { stdio: ['pipe', 'ignore', 'pipe'] });
      let err = '';
      const t = setTimeout(() => { c.kill('SIGKILL'); reject(new Error(`warm-up of ${taskId} timed out: ${err.slice(-300)}`)); }, 180_000);
      c.stderr.on('data', (d) => { err += d; if (err.includes('[ready]')) { clearTimeout(t); c.stdin.end(); c.kill('SIGTERM'); resolve(); } });
      c.on('exit', () => { clearTimeout(t); if (!err.includes('[ready]')) reject(new Error(`warm-up of ${taskId} failed: ${err.slice(-300)}`)); });
    });
  } finally { fs.rmSync(path.dirname(ws.dir), { recursive: true, force: true }); fs.rmSync(logFile, { force: true }); }
  return Date.now() - t0;
}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9_.-]+/g, '_');


export interface AgenticOptions {
  runId: string;
  split: 'dev' | 'test';
  conditions: string[];
  repeats: number;
  model?: string;
  profile: ProfileName;
  mockApi?: MockApiMode;
  taskIds?: string[];
  parallel?: number;
  budget?: number;
  maxTurns?: number;
  maxTotalUsd?: number;
  /** Per-run ceiling (`--max-budget-usd`) and in-flight reservation. REQUIRED for billable runs. */
  perRunUsd?: number;
  /** Real runs only: 'subscription' (default) or 'api-key'; must match the approval entry. */
  billing?: 'subscription' | 'api-key';
  /** Claude Code account (`claude-account` name) whose login the runs use; required for billable subscription runs. */
  account?: string;
  /** Agent prompt version (prompt.ts): p1 (default, natural tool choice) or p2 (directed to an attached MCP tool). */
  promptVersion?: AgentPromptVersion;
  timeoutS?: number;
  effort?: string;
  keepWorkspaces?: boolean;
  /** Default `<exp>/results`; tests use a scratch directory. */
  resultsRoot?: string;
  /** CLI: install SIGINT/SIGTERM/exit/uncaught handlers that kill child groups and write aborted ledger entries. */
  installSignals?: boolean;
  log?: (s: string) => void;
}

export interface PlanItem { run_id: string; task_id: string; condition: string; repeat: number; position: number }

/** mulberry32 */
function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
/** Seeded Fisher-Yates over the canonical item order: interleaves conditions so prompt-cache warmth is not tied to the order. */
export function shuffledPlan(tasks: string[], conditions: string[], repeats: number, seed = SHUFFLE_SEED): PlanItem[] {
  const items: Omit<PlanItem, 'position'>[] = [];
  for (const t of tasks) for (const c of conditions) for (let r = 0; r < repeats; r++) items.push({ run_id: `${t}|agentic:${c}|${r}`, task_id: t, condition: c, repeat: r });
  const rand = rng(seed);
  for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; }
  return items.map((x, position) => ({ ...x, position }));
}

const readJsonl = <T = any>(p: string): T[] => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const appendJsonl = (p: string, o: unknown) => fs.appendFileSync(p, JSON.stringify(o) + '\n');

export function claudeVersion(bin = process.env.AGENT_EVAL_CLAUDE_BIN ?? 'claude'): string {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  const v = (r.stdout ?? '').trim().split(/\s+/)[0];
  if (!v) throw new Error(`cannot determine the Claude Code version (\`${bin} --version\` printed nothing; status ${r.status}, ${r.error?.message ?? ''})`);
  return v;
}

export interface AgenticResult { runs: AgenticRun[]; excluded: any[]; dir: string; halted: string | null }

export async function runAgentic(cfg: BenchmarkConfig, o: AgenticOptions): Promise<AgenticResult> {
  const log = o.log ?? ((s: string) => console.error(s));
  const model = o.model ?? DEFAULT_MODEL;
  const effort = o.effort ?? DEFAULT_EFFORT;
  const maxTurns = o.maxTurns ?? DEFAULT_MAX_TURNS;
  const budget = o.budget ?? 4000;
  const parallel = Math.max(1, o.parallel ?? 1);
  const promptVersion = o.promptVersion ?? 'p1';
  if (!AGENT_PROMPT_VERSIONS.includes(promptVersion)) throw new Error(`unknown --prompt '${promptVersion}'`);
  const mock = o.mockApi != null;
  for (const c of o.conditions) if (!ALL_CONDITIONS.includes(c)) throw new Error(`unknown condition '${c}'`);
  if (!PROFILE_NAMES.includes(o.profile)) throw new Error(`unknown profile '${o.profile}'`);
  if (o.profile === 'safe-mode' && o.conditions.some((c) => c !== 'baseline')) throw new Error("profile 'safe-mode' does not load --mcp-config servers (verified); use it for the baseline only");
  if (!mock) {
    assertBillablePlan({ profile: o.profile, model });
    if (!(typeof o.perRunUsd === 'number' && o.perRunUsd > 0)) throw new BillableRefused('--run-usd (per-run budget cap) is required for billable runs');
  }
  // NB: not cli/commands.selectTasks: it reads a global `--tasks` flag as the tasks DIRECTORY.
  const tasks = loadTasks(abs(cfg.dataset.tasks_dir)).filter((t) => t.split === o.split).filter((t) => !o.taskIds || o.taskIds.includes(t.task_id));
  if (o.taskIds) for (const id of o.taskIds) if (!tasks.some((t) => t.task_id === id)) throw new Error(`task ${id} not in split ${o.split}`);
  const taskById = new Map(tasks.map((t) => [t.task_id, t]));
  const dir = path.join(o.resultsRoot ?? abs(path.join(EXP_DIR, 'results')), o.runId);

  const acct = bindAccount({ account: o.account, billing: o.billing, mock });
  const guard = new BillableGuard({ protocol: 'agentic', conditions: o.conditions, model, split: o.split, max_total_usd: o.maxTotalUsd ?? approvedCapOr(0.01), billing: o.billing ?? 'subscription', account: o.account }, { runUsd: o.perRunUsd });
  if (!mock) guard.assertAllowed({}, false); // fail fast, before anything is built

  const version = claudeVersion();
  // ---- plan (shuffle once, persist, reuse) and config pinning ----
  fs.mkdirSync(path.join(dir, 'transcripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'retrieval-logs'), { recursive: true });
  const config = { split: o.split, conditions: o.conditions, repeats: o.repeats, tasks: tasks.map((t) => t.task_id).sort(), model, profile: o.profile, effort, max_turns: maxTurns, budget_per_call: budget, seed: SHUFFLE_SEED, claude_version: version, mock_api: o.mockApi ?? null, account: acct ? accountRecord(acct) : null, prompt_version: promptVersion };
  const planFile = path.join(dir, 'plan.json');
  let plan: PlanItem[];
  if (fs.existsSync(planFile)) {
    const prev = JSON.parse(fs.readFileSync(planFile, 'utf8'));
    for (const k of Object.keys(config) as (keyof typeof config)[]) {
      const was = prev.config && k in prev.config ? prev.config[k] : k === 'prompt_version' ? 'p1' : undefined; // runs before p2 existed were p1
      if (JSON.stringify(was) !== JSON.stringify(config[k])) throw new Error(`resuming '${o.runId}' with a different ${k}: ${JSON.stringify(prev.config?.[k])} != ${JSON.stringify(config[k])} (use a new --run id)`);
    }
    plan = prev.items;
    log(`resuming ${o.runId}: plan of ${plan.length} items from plan.json`);
  } else {
    plan = shuffledPlan(config.tasks, o.conditions, o.repeats);
    fs.writeFileSync(planFile, JSON.stringify({ seed: SHUFFLE_SEED, created: new Date().toISOString(), config, items: plan }, null, 1) + '\n');
  }
  const positionOf = new Map(plan.map((i) => [i.run_id, i.position]));

  const runsFile = path.join(dir, 'runs.jsonl'), exclFile = path.join(dir, 'excluded.jsonl'), rawFile = path.join(dir, 'raw-runs.jsonl'), ledgerFile = path.join(dir, 'ledger.jsonl');
  for (const f of [runsFile, exclFile, rawFile, ledgerFile]) if (!fs.existsSync(f)) fs.writeFileSync(f, '');

  // ---- scoring (serialised: the scoring workspace is one shared directory per task) ----
  const sc = scorerFor(cfg);
  let lock: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => T): Promise<T> => { const p = lock.then(fn); lock = p.catch(() => undefined); return p; };
  const scoreAndAppend = (rec: Omit<AgenticRun, 'score'>) => serial(() => {
    const task = taskById.get(rec.task_id)!;
    const { index, bugs } = sc(task);
    const scored: AgenticRun = { ...rec, score: scoreDiagnosis(index, task, bugs, rec.diagnosis) };
    appendJsonl(runsFile, scored);
    return scored;
  });

  // ---- resume: what is done ----
  const doneScored = new Set(readJsonl(runsFile).map((r) => r.run_id));
  const priorExcl = readJsonl(exclFile);
  const attemptsUsed = new Map<string, number>(), finalExcluded = new Set<string>();
  for (const e of priorExcl) {
    if (e.retryable === false) finalExcluded.add(e.run_id);
    else if (e.excluded_kind !== 'aborted') attemptsUsed.set(e.run_id, (attemptsUsed.get(e.run_id) ?? 0) + 1);
  }
  for (const [id, n] of attemptsUsed) if (n >= 2) finalExcluded.add(id);
  for (const r of readJsonl(rawFile)) { // finished but not yet scored (scoring failed / crash between the two writes)
    if (r.excluded || !r.task_id || !positionOf.has(r.run_id) || doneScored.has(r.run_id) || !taskById.has(r.task_id)) continue;
    await scoreAndAppend(r); doneScored.add(r.run_id);
  }
  const todo = plan.filter((i) => !doneScored.has(i.run_id) && !finalExcluded.has(i.run_id));
  log(`${plan.length} planned, ${doneScored.size} scored, ${finalExcluded.size} finally excluded, ${todo.length} to run`);

  const writeMeta = (status: string, extra: Record<string, unknown> = {}) => fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    run_id: o.runId, status, protocol: 'agentic', ...config, backend: mock ? 'claude-code-mock' : 'claude-code', billable: !mock, max_parallel: parallel, max_embedding_servers: MAX_EMBEDDING_SERVERS,
    isolation_env: ISOLATION_ENV, condition_labels: Object.fromEntries(o.conditions.map((c) => [c, CONDITION_LABELS[c] ?? c])),
    tool_policy: Object.fromEntries(o.conditions.map((c) => [c, conditionToolPolicy(c)])), run_usd: o.perRunUsd ?? null, max_total_usd: mock ? null : guard.req.max_total_usd, shuffle_seed: SHUFFLE_SEED, plan_file: 'plan.json', updated: new Date().toISOString(), ...extra,
  }, null, 2) + '\n');
  writeMeta('running');

  // ---- warm shared caches (also gives our servers an index_build_ms) ----
  const warmMs = new Map<string, number>();
  if (todo.length && o.conditions.some((c) => c === 'custom_graph' || c === 'hybrid')) {
    for (const t of new Set(todo.map((i) => i.task_id))) { log(`warming custom-graph cache for ${t}`); warmMs.set(t, await warmSnapshot(cfg, t, o.runId)); }
  }
  const embedSlots = new Semaphore(MAX_EMBEDDING_SERVERS);
  const mcpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-eval-mcp-'));

  // ---- harness state: halting, streaks, in-flight ----
  let halted: string | null = null;
  let initStreak = { reason: '', n: 0 }, infraStreak = 0;
  const inflight = new Map<string, { attempt: number }>();
  const halt = (why: string) => { if (!halted) { halted = why; log(`HALT: ${why}`); } };
  const unhook = onHarnessAbort((why) => {
    for (const [id, v] of inflight) {
      try { appendJsonl(ledgerFile, { ts: new Date().toISOString(), run_id: id, attempt: v.attempt, status: why }); } catch { /* best effort */ }
      if (!mock) guard.chargeAborted(id, why);
    }
    try { writeMeta(why, { halted }); } catch { /* best effort */ }
  });
  if (o.installSignals) installSignalHandlers();

  const noteOk = () => { initStreak = { reason: '', n: 0 }; infraStreak = 0; };
  const noteExcluded = (kind: string, reason: string, infraKind?: string) => {
    if (kind === 'init_mismatch') {
      infraStreak = 0;
      initStreak = initStreak.reason === reason ? { reason, n: initStreak.n + 1 } : { reason, n: 1 };
      if (reason.split(',').includes('version')) halt(`Claude Code version changed during the experiment (${reason})`);
      else if (initStreak.n >= 2) halt(`2 consecutive init-fingerprint exclusions: ${reason}`);
    } else if (kind === 'infra_error' || kind === 'mcp_not_connected') {
      initStreak = { reason: '', n: 0 };
      infraStreak++;
      if (infraKind === 'auth' || infraKind === 'limit') halt(`${infraKind} / usage-limit error (stop and inspect before spending more)`);
      else if (infraStreak >= 3) halt('3 consecutive infrastructure errors');
    }
  };

  type Result = { kind: 'ok' } | { kind: 'excluded'; excluded_kind: string; retryable: boolean };

  const executeOnce = async (item: PlanItem, attempt: number): Promise<Result> => {
    const task = taskById.get(item.task_id)!;
    const cond = item.condition;
    const runId = item.run_id;
    const safe = `${safeName(runId)}${attempt > 1 ? `_try${attempt}` : ''}`;
    const ws = buildWorkspace(cfg, item.task_id, `${o.runId}|${cond}|${item.repeat}|${attempt}`);
    let mockSrv: Awaited<ReturnType<typeof startMockServer>> | null = null;
    inflight.set(runId, { attempt });
    try {
      const viol = checkWorkspaceIsolation(ws, cfg);
      if (viol.length) {
        halt(`workspace isolation violated for ${runId}: ${viol.join('; ')}`);
        const rec = { run_id: runId, task_id: item.task_id, condition: `agentic:${cond}`, excluded: 'isolation_violation', excluded_kind: 'harness', retryable: false, excluded_detail: viol.join('; '), attempt };
        appendJsonl(exclFile, rec); appendJsonl(rawFile, rec);
        return { kind: 'excluded', excluded_kind: 'harness', retryable: false };
      }
      const mcp = await conditionServer(cond, ws, { budget, logFile: path.join(dir, 'retrieval-logs', `${safe}.jsonl`) });
      if (mock) {
        const policy: MockPolicy = o.mockApi === 'echo-structured' ? { kind: 'echo-structured' }
          : o.mockApi === 'infra-auth' ? { kind: 'fault', status: 401, error_type: 'authentication_error', message: 'invalid x-api-key' }
          : o.mockApi === 'infra-limit' ? { kind: 'fault', status: 429, error_type: 'rate_limit_error', message: 'Claude usage limit reached. Your limit will reset at 9pm.' }
          : { kind: 'scripted', steps: defaultScript(!!mcp) };
        mockSrv = await startMockServer({ logFile: path.join(dir, 'transcripts', `${safe}.mock-requests.jsonl`), policy });
      }
      const spec = buildClaudeCommand({
        protocol: 'agentic', profile: o.profile, model, cwd: ws.dir, mcp, systemPrompt: agentSystemPrompt(promptVersion), mcpConfigPath: path.join(mcpDir, `${safe}.json`), mockUrl: mockSrv?.url, maxTurns, maxBudgetUsd: o.perRunUsd, effort, billing: o.billing, baseEnv: acct?.env,
        claudeBin: process.env.AGENT_EVAL_CLAUDE_BIN, injectExtraTool: o.mockApi === 'inject-extra-tool' ? 'Bash' : undefined,
      });
      let mismatch: string[] = [];
      const r = await runClaude(spec, agentTaskPrompt(task.description), { run_id: runId, task_id: item.task_id, condition: `agentic:${cond}`, repeat: item.repeat, model, workspace_hash: ws.hash }, {
        guard, timeoutMs: (o.timeoutS ?? 900) * 1000, transcriptPath: path.join(dir, 'transcripts', `${safe}.jsonl`),
        onInit: (init) => { const m = checkInit(init, { mcp, model, version, mock, billing: o.billing }); mismatch = m.details; return m.categories.length ? m.categories.join(',') : null; },
        shouldAbort: () => halted,
      });
      const modified = workspaceHash(ws.dir, ws.files) !== ws.hash;
      const oc = r.outcome;
      const rec: Omit<AgenticRun, 'score'> = {
        ...r.run, prompt_version: promptVersion, profile: o.profile, workspace_modified: modified, permission_denials: r.detail.permission_denials.length, api_duration_ms: r.detail.duration_api_ms,
        usage_result_event: r.detail.usage_result, mcp_status: r.detail.mcp_servers, attempt, position: item.position, status: oc.status, condition_label: CONDITION_LABELS[cond] ?? cond, effort, claude_version: version,
        cost_reported_usd: r.cost.reported, cost_list_usd: r.cost.list, cost_ledger_usd: r.cost.ledger, wall_ms: r.timing.wall_ms, duration_ms: r.detail.duration_ms, init_ms: r.timing.init_ms,
        mcp_startup_ms: mcp ? r.timing.init_ms : null, index_build_ms: mcp?.build_ms ?? (['custom_graph', 'hybrid'].includes(cond) ? warmMs.get(item.task_id) ?? null : null), init: r.init,
      };
      appendJsonl(ledgerFile, { ts: new Date().toISOString(), run_id: runId, attempt, status: oc.status, infra_kind: oc.infra_kind, cost_reported_usd: r.cost.reported, cost_list_usd: r.cost.list, cost_ledger_usd: r.cost.ledger, usage: r.run.usage, wall_ms: r.timing.wall_ms, position: item.position });

      if (oc.status === 'init_mismatch' || oc.status === 'infra_error' || oc.status === 'aborted') {
        const mcpNotConnected = oc.status === 'init_mismatch' && oc.reason === 'mcp_not_connected';
        const excluded_kind = mcpNotConnected ? 'mcp_not_connected' : oc.status === 'init_mismatch' ? 'init_mismatch' : oc.status === 'aborted' ? 'aborted' : 'infra_error';
        const retryable = excluded_kind !== 'init_mismatch'; // aborted runs are simply re-run on resume (not counted as an attempt)
        const ex = { ...rec, excluded: excluded_kind === 'infra_error' ? `infra_error:${oc.infra_kind}` : excluded_kind === 'init_mismatch' ? `init_mismatch:${oc.reason}` : excluded_kind, excluded_kind, retryable, excluded_detail: [oc.reason, ...mismatch, oc.text].filter(Boolean).join(' | ').slice(0, 600) };
        appendJsonl(exclFile, ex); appendJsonl(rawFile, ex);
        if (excluded_kind !== 'aborted') noteExcluded(excluded_kind, oc.reason ?? '', oc.infra_kind);
        log(`[#${item.position}] ${runId} EXCLUDED ${ex.excluded} (attempt ${attempt})`);
        return { kind: 'excluded', excluded_kind, retryable };
      }
      appendJsonl(rawFile, rec);
      const scored = await scoreAndAppend(rec);
      noteOk();
      log(`[#${item.position}] ${runId} ${rec.status} turns=${rec.turns} ledger=$${rec.cost_ledger_usd.toFixed(4)} rc_line=${scored.score.rc_line_at_1}${modified ? ' WORKSPACE MODIFIED' : ''}`);
      return { kind: 'ok' };
    } finally {
      inflight.delete(runId);
      await mockSrv?.close();
      if (!o.keepWorkspaces) fs.rmSync(path.dirname(ws.dir), { recursive: true, force: true });
    }
  };

  const processItem = async (item: PlanItem) => {
    const start = (attemptsUsed.get(item.run_id) ?? 0) + 1;
    for (let attempt = start; attempt <= 2; attempt++) {
      let res: Result;
      try { res = await executeOnce(item, attempt); } catch (e) {
        if (e instanceof BillableRefused) { halt(e.message); return; }
        // a worker error never loses the other workers' results: record it as an infrastructure failure and go on
        const rec = { run_id: item.run_id, task_id: item.task_id, condition: `agentic:${item.condition}`, excluded: 'infra_error:harness', excluded_kind: 'infra_error', retryable: true, excluded_detail: String((e as Error).stack ?? e).slice(0, 600), attempt, position: item.position };
        appendJsonl(exclFile, rec); appendJsonl(rawFile, rec);
        log(`[#${item.position}] ${item.run_id} harness error: ${(e as Error).message}`);
        noteExcluded('infra_error', 'harness', 'harness');
        res = { kind: 'excluded', excluded_kind: 'infra_error', retryable: true };
      }
      if (res.kind === 'ok' || halted || !res.retryable || res.excluded_kind === 'aborted') return;
    }
  };

  let next = 0;
  const worker = async () => {
    for (;;) {
      if (halted) return;
      const item = todo[next++];
      if (!item) return;
      const slot = EMBEDDING_CONDITIONS.includes(item.condition);
      if (slot) await embedSlots.acquire();
      try { if (!halted) await processItem(item); } finally { if (slot) embedSlots.release(); }
    }
  };
  const t0 = Date.now();
  try { await Promise.all(Array.from({ length: parallel }, worker)); } finally { unhook(); fs.rmSync(mcpDir, { recursive: true, force: true }); }

  const runs = readJsonl<AgenticRun>(runsFile);
  const excluded = readJsonl(exclFile);
  const ledgerTotal = readJsonl(ledgerFile).reduce((a, r) => a + (r.cost_ledger_usd ?? 0), 0);
  const scoredIds = new Set(runs.map((r) => r.run_id));
  const pending = plan.filter((i) => !scoredIds.has(i.run_id) && !excluded.some((e) => e.run_id === i.run_id && (e.retryable === false || attemptsOf(excluded, i.run_id) >= 2))).length;
  const status = halted ? 'halted' : pending === 0 ? 'completed' : 'incomplete';
  writeMeta(status, { halted, n_pending: pending, n_items: plan.length, n_scored: runs.length, n_excluded_records: excluded.length, total_cost_ledger_usd: ledgerTotal, total_cost_reported_usd: runs.reduce((a, r) => a + (r.cost_reported_usd ?? 0), 0), wall_ms_this_invocation: Date.now() - t0, finished: new Date().toISOString() });
  if (runs.length) fs.writeFileSync(path.join(dir, 'report.md'), report(runs, 'agentic:baseline') + '\n');
  return { runs, excluded, dir, halted };
}

/**
 * Resolves `--account` (non-billable). Billable subscription runs must name one; API-key billing must not.
 * In mock mode the account only selects the configuration whose isolation is being tested.
 */
export function bindAccount(o: { account?: string; billing?: 'subscription' | 'api-key'; mock: boolean }): AccountInfo | null {
  if (!o.account) {
    if (!o.mock && (o.billing ?? 'subscription') === 'subscription') throw new BillableRefused('--account <name> is required for billable subscription runs (the Claude Code login to bill)');
    return null;
  }
  if ((o.billing ?? 'subscription') === 'api-key') throw new BillableRefused('--account binds a subscription login; it cannot be combined with --billing api-key');
  const a = resolveAccount(o.account);
  if (!o.mock) assertSubscriptionAccount(a);
  return a;
}

const attemptsOf = (ex: any[], id: string) => ex.filter((e) => e.run_id === id && e.retryable !== false && e.excluded_kind !== 'aborted').length;

function approvedCapOr(d: number): number {
  try {
    const p = abs(`${EXP_DIR}/APPROVAL.json`);
    if (!fs.existsSync(p)) return d;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw.approvals ?? [raw];
    return Math.max(...list.map((x: any) => Number(x.max_total_usd) || 0), 0) || d;
  } catch { return d; }
}

/** CLI entry: `agentic ...` (wired from cli.ts). */
export async function agenticCommand(cfg: BenchmarkConfig): Promise<void> {
  const arg = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
  const flag = (n: string) => process.argv.includes(`--${n}`);
  const split = arg('split', 'dev') as 'dev' | 'test';
  const mockApi = arg('mock-api') as MockApiMode | undefined;
  if (mockApi && !['scripted', 'echo-structured', 'infra-auth', 'infra-limit', 'inject-extra-tool'].includes(mockApi)) throw new Error('--mock-api must be scripted|echo-structured|infra-auth|infra-limit|inject-extra-tool');
  const runId = arg('run', `agentic-${split}-${new Date().toISOString().slice(0, 10)}`)!;
  const { runs, dir, halted } = await runAgentic(cfg, {
    runId, split, conditions: (arg('conditions') ?? 'baseline').split(','), repeats: Number(arg('repeats', '1')), model: arg('model', DEFAULT_MODEL)!,
    profile: arg('profile', 'restricted-oauth') as ProfileName, mockApi, taskIds: (arg('task-ids') ?? arg('tasks'))?.split(','), parallel: Number(arg('parallel', '1')),
    budget: Number(arg('budget', '4000')), maxTurns: arg('max-turns') ? Number(arg('max-turns')) : undefined, maxTotalUsd: arg('max-usd') ? Number(arg('max-usd')) : undefined,
    perRunUsd: arg('run-usd') ? Number(arg('run-usd')) : undefined, billing: (arg('billing') ?? 'subscription') as 'subscription' | 'api-key', account: arg('account'), promptVersion: arg('prompt', 'p1') as AgentPromptVersion, timeoutS: arg('timeout-s') ? Number(arg('timeout-s')) : undefined, effort: arg('effort'), keepWorkspaces: flag('keep-workspaces'), installSignals: true,
  });
  if (runs.length) console.log(report(runs, 'agentic:baseline'));
  console.error(`wrote ${path.join(dir, 'runs.jsonl')} (${runs.length} scored runs)${halted ? `; HALTED: ${halted}` : ''}`);
  if (halted) process.exitCode = 3;
}
