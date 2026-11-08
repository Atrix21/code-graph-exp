#!/usr/bin/env tsx
import crypto from 'node:crypto';
/**
 * Non-billable verification of the Claude Code isolation profiles, driven by the local mock Anthropic API.
 *
 *   npx tsx src/agent-eval/verify-isolation.ts [--profiles bare,restricted-oauth,safe-mode] [--conditions baseline,bm25,graphify,crg]
 *                                              [--out experiments/02-agent-diagnosis/results/isolation-report]
 *
 * Every `claude` call uses ANTHROPIC_BASE_URL=http://127.0.0.1:<port> and a dummy API key (enforced by BillableGuard).
 * All answers come from the RECORDED request bodies (what the model would have seen) and from the stream-json output.
 * Writes <out>.json and <out>.md (default experiments/02-agent-diagnosis/results/isolation-report.{json,md}).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { abs, loadConfig } from '../config.js';
import { countTokens } from '../evaluation/token-accounting.js';
import { BillableGuard, buildClaudeCommand, checkInit, ISOLATION_ENV, parseStreamJson, runClaude, PROFILE_NAMES, type ProfileName } from './backends/claude-code.js';
import { conditionServer, DENY_TOOLS, OUR_METHODS, SERVER_NAME } from './agentic.js';
import { EXP_DIR } from './contexts.js';
import { FIXED_DIAGNOSIS, startMockServer, type MockRequestRecord, type MockStep } from './mock-anthropic/server.js';
import { buildWorkspace, type Workspace } from './workspace.js';

const arg = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };

const HOME_ROOTS = [path.join(os.homedir(), '.claude'), path.join(os.homedir(), '.claude.json'), path.join(os.homedir(), '.config', 'claude-accounts')];
const MODEL = 'claude-sonnet-5-5';
const FORBIDDEN_FILE = abs('evaluation/dataset/tasks/auth_jwt_secret_01.json');
const BANNED_TOOLS = ['Bash', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'Skill', 'Edit', 'Write', 'NotebookEdit', 'TodoWrite', 'PowerShell', 'Monitor', 'ToolSearch'];
const SKILL_NEEDLES = ['ig-reel', 'ig-audit', 'watchos', 'unity-mcp', 'paxel-remote-setup', 'security-audit', 'skills are available', 'available skills', 'Skill tool'];
const MEMORY_NEEDLES = ['MEMORY.md', 'auto memory', 'memory directory'];

/* --------------------------------- body segmentation --------------------------------- */

interface Segment { where: string; text: string; mcp?: boolean; scripted?: boolean }

function segments(body: any): Segment[] {
  const out: Segment[] = [];
  const sys = Array.isArray(body.system) ? body.system : body.system ? [{ text: String(body.system) }] : [];
  sys.forEach((s: any, i: number) => out.push({ where: `system[${i}]`, text: String(s.text ?? '') }));
  (body.messages ?? []).forEach((m: any, i: number) => {
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content ?? '') }];
    blocks.forEach((b: any) => out.push({ where: `messages[${i}:${m.role}]`, text: b.type === 'text' ? String(b.text ?? '') : JSON.stringify(b), scripted: m.role === 'assistant' || b.type === 'tool_result' }));
  });
  for (const t of body.tools ?? []) out.push({ where: `tools:${t.name}`, text: JSON.stringify(t), mcp: String(t.name).startsWith('mcp__') });
  return out;
}

/** Needle search over what the harness put in the request. Assistant turns and tool results are excluded: they hold the mock's scripted tool calls and the MCP servers' own output. */
/** Generic, non-private markers may be reported verbatim; anything read from the user's files is reported only as a hash. */
const PUBLIC_NEEDLES = new Set(['any input to knowledge graph', "user's private global instructions", 'invoke the Skill tool with', 'userEmail', 'graphify']);
function redactNeedle(n: string): string {
  if (PUBLIC_NEEDLES.has(n)) return n;
  return `claude-md-line#${crypto.createHash('sha256').update(n).digest('hex').slice(0, 10)}`;
}

function findHits(body: any, needles: string[], opts: { ignoreMcpTools?: boolean } = {}): { needle: string; where: string }[] {
  const hits: { needle: string; where: string }[] = [];
  for (const seg of segments(body)) {
    if ((opts.ignoreMcpTools && seg.mcp) || seg.scripted) continue;
    for (const n of needles) if (seg.text.toLowerCase().includes(n.toLowerCase())) hits.push({ needle: redactNeedle(n), where: seg.where });
  }
  return hits;
}

/** Distinctive strings from every CLAUDE.md that could reach the workspace (user-level, ancestors of the cwd, project root). */
function claudeMdNeedles(wsDir: string): { needles: string[]; files: string[] } {
  const cfgDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  const cands = new Set<string>([path.join(cfgDir, 'CLAUDE.md'), path.join(os.homedir(), '.claude', 'CLAUDE.md'), abs('CLAUDE.md'), path.join(abs('.'), '.claude', 'CLAUDE.md')]);
  for (let d = wsDir; ; d = path.dirname(d)) { cands.add(path.join(d, 'CLAUDE.md')); cands.add(path.join(d, 'CLAUDE.local.md')); cands.add(path.join(d, '.claude', 'CLAUDE.md')); if (d === '/') break; }
  const files: string[] = [];
  const needles = new Set<string>(['any input to knowledge graph', "user's private global instructions", 'invoke the Skill tool with', 'userEmail', 'graphify']);
  for (const f of cands) {
    if (!fs.existsSync(f)) continue;
    files.push(f);
    for (const l of fs.readFileSync(f, 'utf8').split('\n').map((x) => x.trim()).filter((x) => x.length >= 24)) needles.add(l.slice(0, 70));
  }
  return { needles: [...needles], files };
}

/* ------------------------------------ file listings ------------------------------------ */

type Listing = Map<string, string>;
function listing(roots: string[]): Listing {
  const out: Listing = new Map();
  const seen = new Set<string>();
  const walk = (p: string) => {
    let st: fs.Stats;
    try { st = fs.statSync(p); } catch { return; }
    let real: string;
    try { real = fs.realpathSync(p); } catch { return; }
    if (st.isDirectory()) {
      if (seen.has(real)) return;
      seen.add(real);
      let names: string[] = [];
      try { names = fs.readdirSync(p); } catch { return; }
      for (const n of names) walk(path.join(p, n));
    } else if (!out.has(real)) out.set(real, `${st.size}:${Math.round(st.mtimeMs)}`);
  };
  for (const r of roots) walk(r);
  return out;
}

function diffListing(a: Listing, b: Listing) {
  const added: string[] = [], removed: string[] = [], changed: string[] = [];
  for (const [k, v] of b) { if (!a.has(k)) added.push(k); else if (a.get(k) !== v) changed.push(k); }
  for (const k of a.keys()) if (!b.has(k)) removed.push(k);
  return { added, removed, changed };
}

/** Changed/added files that mention one of the markers (child session id, workspace path) are attributed to the child. */
function attribute(d: ReturnType<typeof diffListing>, markers: string[]): { attributed: string[]; unattributed: number; unattributed_paths: string[] } {
  const attributed: string[] = [];
  const otherPaths: string[] = [];
  for (const f of [...d.added, ...d.changed]) {
    let mine = markers.some((m) => f.includes(m));
    if (!mine) { try { if (fs.statSync(f).size < 32 * 1024 * 1024) { const txt = fs.readFileSync(f, 'utf8'); mine = markers.some((m) => txt.includes(m)); } } catch { /* ignore */ } }
    if (mine) attributed.push(f); else otherPaths.push(f);
  }
  return { attributed, unattributed: otherPaths.length, unattributed_paths: otherPaths.slice(0, 5) };
}

/* ------------------------------------ scenarios ------------------------------------ */

const inWorkspaceRead = 'src/auth/auth.service.ts';

function verifyScript(withMcp: boolean, deniedTool?: string): MockStep[] {
  return [
    { tool: 'Grep', input: { pattern: 'refresh' } },
    { tool: 'Glob', input: { pattern: 'src/auth/*.ts' } },
    ...(withMcp ? [{ tool: 'mcp:auto', input: { $fill: 'refresh token' } } as MockStep] : []),
    ...(deniedTool ? [{ tool: deniedTool, input: {} } as MockStep] : []),
    { tool: 'Read', input: { file_path: inWorkspaceRead } },
    { tool: 'Read', input: { file_path: FORBIDDEN_FILE } },
    { tool: 'Read', input: { file_path: '../../../../etc/hostname' } },
    { tool: 'Grep', input: { pattern: 'x', path: '/etc' } },
    { tool: 'Bash', input: { command: 'ls' } },
    { tool: 'WebFetch', input: { url: 'https://example.com', prompt: 'x' } },
    { tool: 'Agent', input: { description: 'x', prompt: 'x', subagent_type: 'general-purpose' } },
    { tool: 'Skill', input: { skill: 'graphify' } },
    { structured: FIXED_DIAGNOSIS },
  ];
}

interface ToolExchange { tool: string; input: any; result: string; is_error: boolean }

function exchanges(reqs: MockRequestRecord[]): ToolExchange[] {
  const last = [...reqs].filter((r) => r.path === '/v1/messages' && r.body?.messages).sort((a, b) => b.tool_results - a.tool_results)[0];
  if (!last) return [];
  const uses = new Map<string, { name: string; input: any }>();
  const out: ToolExchange[] = [];
  for (const m of last.body.messages) for (const b of Array.isArray(m.content) ? m.content : []) {
    if (b.type === 'tool_use') uses.set(b.id, { name: b.name, input: b.input });
    if (b.type === 'tool_result') {
      const u = uses.get(b.tool_use_id);
      const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x: any) => x.text ?? '').join('') : JSON.stringify(b.content);
      out.push({ tool: u?.name ?? '?', input: u?.input, result: text, is_error: !!b.is_error });
    }
  }
  return out;
}

const trunc = (s: string, n = 300) => (s.length > n ? s.slice(0, n) + '…' : s);

interface Scenario {
  profile: string;
  kind: string; // baseline | ours:<m> | graphify | crg | single-shot | max-turns
  ok: boolean;
  error?: string;
  requests?: number;
  paths?: Record<string, number>;
  tools_offered?: string[];
  tool_schema_tokens?: number;
  tool_schema_tokens_by_tool?: Record<string, number>;
  system_prompt_tokens?: number;
  system_prompt_text?: string;
  mcp_tools?: string[];
  mcp_expected?: string;
  mcp_as_expected?: boolean | null;
  mcp_status?: unknown;
  mcp_connected?: boolean | null;
  init_check?: { categories: string[]; details: string[] };
  outcome?: { status: string; infra_kind?: string; reason?: string };
  mcp_tool_schema_tokens?: number;
  denied_expected?: string[];
  denied_present?: string[];
  denied_attempt?: string;
  claude_md_hits?: { needle: string; where: string }[];
  claude_md_files_considered?: string[];
  skill_hits?: { needle: string; where: string }[];
  memory_hits?: { needle: string; where: string }[];
  cwd_visible?: { found: boolean; where: string[] };
  banned_offered?: string[];
  exchanges?: ToolExchange[];
  forbidden_read?: { denied: boolean; is_error?: boolean; text?: string };
  outside_reads?: { input: unknown; denied: boolean; text: string }[];
  banned_attempts?: Record<string, string>;
  result?: Record<string, unknown>;
  model_in_request?: string;
  request_keys?: string[];
  metadata_keys?: string[];
  init_extra?: Record<string, unknown>;
  workspace_changes?: ReturnType<typeof diffListing>;
  home_writes?: { attributed: string[]; unattributed: number; unattributed_paths: string[] };
  stderr_tail?: string;
}

async function runScenario(o: { inject?: string; fault?: { status: number; error_type: string; message: string }; noDeny?: boolean; profile: ProfileName | 'control'; kind: string; ws: Workspace; condition: string; protocol: 'agentic' | 'single_shot'; steps?: MockStep[]; echo?: boolean; maxTurns?: number; outDir: string; budget: number; childSessions: string[] }): Promise<Scenario> {
  const { profile, kind, ws } = o;
  const base: Scenario = { profile, kind, ok: false };
  const safe = `${profile}__${kind}`.replace(/[^A-Za-z0-9_.-]+/g, '_');
  const logFile = path.join(o.outDir, `${safe}.requests.jsonl`);
  const mock = await startMockServer({ logFile, policy: o.fault ? { kind: 'fault', ...o.fault } : o.echo ? { kind: 'echo-structured' } : { kind: 'scripted', steps: o.steps ?? [] } });
  const wsBefore = listing([ws.dir]);
  try {
    const mcp = o.protocol === 'agentic' ? await conditionServer(o.condition, ws, { budget: o.budget, logFile: path.join(o.outDir, `${safe}.retrieval.jsonl`) }) : null;
    if (mcp && o.noDeny) mcp.denyTools = [];
    if (profile === 'safe-mode' && mcp) { /* still attempted: the point is to observe whether the server loads */ }
    const scratch = o.protocol === 'single_shot' ? fs.mkdtempSync(path.join(os.tmpdir(), 'vi-')) : ws.dir;
    let spec = buildClaudeCommand({ protocol: o.protocol, profile: profile === 'control' ? 'restricted-oauth' : profile, model: MODEL, cwd: scratch, mcp, mockUrl: mock.url, maxTurns: o.maxTurns, injectExtraTool: o.inject, mcpConfigPath: path.join(o.outDir, `${safe}.mcp.json`), claudeBin: process.env.AGENT_EVAL_CLAUDE_BIN });
    if (profile === 'control') {
      // Positive control for the detectors: the same mock-API call WITHOUT any isolation flag or isolation env var,
      // read-only (`--tools Read`), so user CLAUDE.md / skills / memory ARE expected to show up in the request.
      const env = { ...spec.env };
      for (const k of Object.keys(ISOLATION_ENV)) delete env[k];
      spec = { ...spec, env, args: ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--model', 'sonnet', '--tools', 'Read', '--permission-mode', 'dontAsk'] };
    }
    const homeBefore = listing(HOME_ROOTS);
    const guard = new BillableGuard({ protocol: o.protocol, conditions: [o.condition], model: MODEL, split: 'dev', max_total_usd: 1 });
    const r = await runClaude(spec, o.protocol === 'agentic' ? 'A user filed a bug: after refresh the session is invalid. Find the cause.' : 'Diagnose: refresh token broken. Respond with JSON only.', { run_id: safe, task_id: 'verify', condition: o.condition, repeat: 0, model: MODEL, workspace_hash: ws.hash }, { guard, timeoutMs: 180_000, transcriptPath: path.join(o.outDir, `${safe}.transcript.jsonl`),
      onInit: o.inject ? (init) => { const m = checkInit(init, { mcp, model: MODEL, mock: true }); return m.categories.length ? m.categories.join(',') : null; } : undefined });
    if (o.protocol === 'single_shot') fs.rmSync(scratch, { recursive: true, force: true });
    const reqs = mock.requests();
    const msgReqs = reqs.filter((x) => x.path === '/v1/messages');
    const agentReqs = msgReqs.filter((x) => (x.body?.tools ?? []).length > 0 || x.body?.tools);
    const first = (agentReqs.length ? agentReqs : msgReqs)[0]?.body;
    if (!first) {
      // killed at init (isolation drift) or failed before any request: still report what init and the outcome were
      const parsed0 = parseStreamJson(r.raw);
      Object.assign(base, { ok: true, requests: 0, tools_offered: parsed0.init?.tools ?? [], outcome: r.outcome, init_check: checkInit(parsed0.init, { mcp, model: MODEL, mock: true }), mcp_tools: [], mcp_expected: undefined, home_writes: attribute(diffListing(homeBefore, listing(HOME_ROOTS)), [parsed0.init?.session_id ?? '(none)', path.dirname(ws.dir), 'agent-eval-mcp']), result: parsed0.result ? { subtype: parsed0.result.subtype, is_error: parsed0.result.is_error, text: String(parsed0.result.result ?? '').slice(0, 200) } : { missing: true } });
      return base;
    }
    const parsed = parseStreamJson(r.raw);
    if (parsed.init?.session_id) o.childSessions.push(parsed.init.session_id);
    const names: string[] = (first.tools ?? []).map((t: any) => t.name);
    const byTool: Record<string, number> = {};
    for (const t of first.tools ?? []) byTool[t.name] = countTokens(JSON.stringify(t));
    const sysText = (Array.isArray(first.system) ? first.system : [{ text: first.system }]).map((s: any) => s.text ?? '').join('\n');
    const cm = claudeMdNeedles(ws.dir);
    const mcpTools = names.filter((n) => n.startsWith('mcp__'));
    const expectPrefix = !mcp ? null : `mcp__${mcp.name}__`;
    const ex = exchanges(reqs);
    const forbidden = ex.find((e) => e.tool === 'Read' && e.input?.file_path === FORBIDDEN_FILE);
    const outside = ex.filter((e) => (e.tool === 'Read' && e.input?.file_path !== inWorkspaceRead && e.input?.file_path !== FORBIDDEN_FILE) || (e.tool === 'Grep' && e.input?.path)).map((e) => ({ input: e.input, denied: e.is_error, text: trunc(e.result) }));
    const banned: Record<string, string> = {};
    for (const e of ex) if (BANNED_TOOLS.includes(e.tool)) banned[e.tool] = `${e.is_error ? '[error] ' : '[ok] '}${trunc(e.result, 240)}`;
    const res = parsed.result;
    const cwdFound = segments(first).filter((s) => s.text.includes(ws.dir) || s.text.includes(path.dirname(ws.dir))).map((s) => s.where);
    const pathCount: Record<string, number> = {};
    for (const x of reqs) { const k = `${x.method} ${x.path}`; pathCount[k] = (pathCount[k] ?? 0) + 1; }
    Object.assign(base, {
      ok: true, requests: msgReqs.length, paths: pathCount, tools_offered: names, tool_schema_tokens: countTokens(JSON.stringify(first.tools ?? [])), tool_schema_tokens_by_tool: byTool,
      system_prompt_tokens: countTokens(sysText), system_prompt_text: trunc(sysText, 600),
      mcp_tools: mcpTools, mcp_expected: expectPrefix ? `${expectPrefix}*` : undefined, mcp_as_expected: expectPrefix ? mcpTools.length > 0 && mcpTools.every((n) => n.startsWith(expectPrefix)) : mcpTools.length === 0,
      mcp_status: parsed.init?.mcp_servers,
      init_check: o.protocol === 'agentic' && profile !== 'control' ? checkInit(parsed.init, { mcp, model: MODEL, mock: true }) : undefined,
      outcome: r.outcome,
      mcp_connected: mcp ? (parsed.init?.mcp_servers ?? []).some((x: any) => x.name === mcp.name && x.status === 'connected') : null,
      mcp_tool_schema_tokens: countTokens(JSON.stringify((first.tools ?? []).filter((t: any) => String(t.name).startsWith('mcp__')))),
      denied_expected: (mcp?.denyTools ?? []).map((t) => `mcp__${mcp!.name}__${t}`),
      denied_present: (mcp?.denyTools ?? []).map((t) => `mcp__${mcp!.name}__${t}`).filter((n) => names.includes(n)),
      claude_md_hits: msgReqs.flatMap((x) => findHits(x.body, cm.needles, { ignoreMcpTools: true })).filter((h, i, a) => a.findIndex((y) => y.needle === h.needle && y.where === h.where) === i),
      claude_md_files_considered: cm.files,
      skill_hits: findHits(first, SKILL_NEEDLES, { ignoreMcpTools: true }), memory_hits: findHits(first, MEMORY_NEEDLES, { ignoreMcpTools: true }),
      cwd_visible: { found: cwdFound.length > 0, where: [...new Set(cwdFound)] }, banned_offered: names.filter((n) => BANNED_TOOLS.includes(n)), exchanges: ex.map((e) => ({ ...e, result: trunc(e.result, 200) })),
      forbidden_read: forbidden ? { denied: forbidden.is_error, is_error: forbidden.is_error, text: trunc(forbidden.result) } : { denied: false, text: '(no exchange recorded)' },
      outside_reads: outside, banned_attempts: banned,
      denied_attempt: ex.find((e) => e.tool.startsWith('mcp__') && (mcp?.denyTools ?? []).some((t) => e.tool.endsWith('__' + t)))?.result.slice(0, 200),
      result: res ? {
        subtype: res.subtype, is_error: res.is_error, num_turns: res.num_turns, duration_ms: res.duration_ms, duration_api_ms: res.duration_api_ms, total_cost_usd: res.total_cost_usd,
        usage: res.usage, modelUsage: res.modelUsage, structured_output_present: res.structured_output != null, structured_output: res.structured_output, permission_denials: (res.permission_denials ?? []).length, stop_reason: res.stop_reason, errors: res.errors,
      } : { missing: true },
      model_in_request: first.model, request_keys: Object.keys(first), metadata_keys: Object.keys(first.metadata ?? {}),
      init_extra: { apiKeySource: parsed.init?.apiKeySource, skills: parsed.init?.skills, slash_commands: parsed.init?.slash_commands, agents: parsed.init?.agents, plugins: (parsed.init?.plugins ?? []).map((p: any) => p.name), permissionMode: parsed.init?.permissionMode, memory_paths: parsed.init?.memory_paths },
      workspace_changes: diffListing(wsBefore, listing([ws.dir])), stderr_tail: r.detail.stderr_tail,
      home_writes: attribute(diffListing(homeBefore, listing(HOME_ROOTS)), [parsed.init?.session_id ?? '(none)', path.dirname(ws.dir), 'agent-eval-mcp']),
    } satisfies Partial<Scenario>);
    return base;
  } catch (e) {
    base.error = String((e as Error).stack ?? e).slice(0, 800);
    return base;
  } finally { await mock.close(); }
}

/* ------------------------------------------- main ------------------------------------------- */

async function main() {
  const cfg = loadConfig();
  const profiles = (arg('profiles') ?? PROFILE_NAMES.join(',')).split(',') as ProfileName[];
  const kinds = (arg('conditions') ?? `baseline,${OUR_METHODS[OUR_METHODS.indexOf('bm25' as any) >= 0 ? OUR_METHODS.indexOf('bm25' as any) : 0]},graphify,crg`).split(',');
  const outBase = abs(arg('out', `${EXP_DIR}/results/isolation-report`)!);
  const outDir = `${outBase}-raw`;
  fs.mkdirSync(outDir, { recursive: true });

  const roots = HOME_ROOTS;
  const fsBefore = listing(roots);
  const ws = buildWorkspace(cfg, 'auth_jwt_secret_01', 'verify-isolation');
  const childSessions: string[] = [];
  const scenarios: Scenario[] = [];
  const skipped: { kind: string; reason: string }[] = [];

  // Probe each condition's server once (competitors build a graph); unavailable ones are skipped, not faked.
  const usable: string[] = [];
  for (const k of kinds) {
    try { await conditionServer(k, ws, { budget: 4000, logFile: path.join(outDir, `probe-${k}.jsonl`) }); usable.push(k); } catch (e) { skipped.push({ kind: k, reason: String((e as Error).message).slice(0, 300) }); console.error(`skip ${k}: ${(e as Error).message.slice(0, 200)}`); }
  }
  console.error('== exclusion demos');
  scenarios.push(await runScenario({ profile: 'restricted-oauth', kind: 'demo:inject-extra-tool', ws, condition: 'baseline', protocol: 'agentic', steps: [{ structured: FIXED_DIAGNOSIS }], inject: 'Bash', outDir, budget: 4000, childSessions }));
  scenarios.push(await runScenario({ profile: 'restricted-oauth', kind: 'demo:infra-401', ws, condition: 'baseline', protocol: 'agentic', fault: { status: 401, error_type: 'authentication_error', message: 'invalid x-api-key' }, outDir, budget: 4000, childSessions }));
  console.error('== control (no isolation)');
  scenarios.push(await runScenario({ profile: 'control', kind: 'baseline', ws, condition: 'baseline', protocol: 'agentic', steps: [{ text: 'OK' }], outDir, budget: 4000, childSessions }));
  for (const profile of profiles) {
    for (const k of usable) {
      console.error(`== ${profile} / ${k}`);
      scenarios.push(await runScenario({ profile, kind: k, ws, condition: k, protocol: 'agentic', steps: verifyScript(k !== 'baseline', DENY_TOOLS[k]?.[0] ? `mcp__${SERVER_NAME[k]}__${DENY_TOOLS[k][0]}` : undefined), outDir, budget: 4000, childSessions }));
    }
    if (profile === 'restricted-oauth') for (const k of usable.filter((x) => DENY_TOOLS[x])) {
      console.error(`== ${profile} / ${k} (no deny list, to measure the full tools/list)`);
      scenarios.push(await runScenario({ noDeny: true, profile, kind: `${k}(no-deny)`, ws, condition: k, protocol: 'agentic', steps: [{ structured: FIXED_DIAGNOSIS }], outDir, budget: 4000, childSessions }));
    }
    console.error(`== ${profile} / max-turns`);
    scenarios.push(await runScenario({ profile, kind: 'max-turns(2)', ws, condition: 'baseline', protocol: 'agentic', steps: Array.from({ length: 12 }, () => ({ tool: 'Grep', input: { pattern: 'refresh' } })) as MockStep[], maxTurns: 2, outDir, budget: 4000, childSessions }));
    console.error(`== ${profile} / single-shot`);
    scenarios.push(await runScenario({ profile, kind: 'single-shot', ws, condition: 'single', protocol: 'single_shot', echo: true, outDir, budget: 4000, childSessions }));
  }

  const fsAfter = listing(roots);
  const d = diffListing(fsBefore, fsAfter);
  // Attribute changes: a changed file is "ours" if it mentions a child session id or the workspace path.
  const markers = [...childSessions, path.dirname(ws.dir), 'agent-eval-mcp'];
  const attributed: string[] = [], other: string[] = [];
  for (const f of [...d.added, ...d.changed]) {
    let mine = markers.some((m) => f.includes(m));
    if (!mine) {
      try { const st = fs.statSync(f); if (st.size < 32 * 1024 * 1024) { const txt = fs.readFileSync(f, 'utf8'); mine = markers.some((m) => txt.includes(m)); } } catch { /* ignore */ }
    }
    (mine ? attributed : other).push(f);
  }
  const fsReport = {
    roots, files_before: fsBefore.size, files_after: fsAfter.size, added: d.added.length, changed: d.changed.length, removed: d.removed.length,
    attributed_to_verify_children: attributed, unattributed_changes: other.length,
    unattributed_sample: other.slice(0, 25),
    note: 'Unattributed changes come from OTHER live Claude Code sessions (including the one running this script); they mention neither a verify child session id nor the verify workspace path.',
  };
  const pkg = JSON.parse(fs.readFileSync(abs('package.json'), 'utf8'));
  const report = { generated: new Date().toISOString(), claude_version: (await import('node:child_process')).spawnSync(process.env.AGENT_EVAL_CLAUDE_BIN ?? 'claude', ['--version'], { encoding: 'utf8' }).stdout.trim(), project: pkg.name, workspace: ws.dir, skipped, scenarios, filesystem: fsReport };
  fs.writeFileSync(`${outBase}.json`, JSON.stringify(report, null, 1) + '\n');
  fs.writeFileSync(`${outBase}.md`, renderMd(report) + '\n');
  // The positive control runs WITHOUT isolation, so its raw recordings contain the user's private configuration
  // (CLAUDE.md, skills, memory). Keep only the redacted verdicts above; never persist those raw files.
  for (const f of fs.readdirSync(outDir)) if (f.startsWith('control__')) fs.rmSync(path.join(outDir, f), { force: true });
  fs.rmSync(path.dirname(ws.dir), { recursive: true, force: true });
  console.error(`wrote ${outBase}.json and .md`);
}

/* ------------------------------------------- markdown ------------------------------------------- */

function renderMd(r: any): string {
  const sc: Scenario[] = r.scenarios;
  const L: string[] = [];
  L.push('# Claude Code isolation report (mock API, no billable calls)', '', `Claude Code ${r.claude_version}; generated ${r.generated}. Every call used ANTHROPIC_BASE_URL=http://127.0.0.1:<port> with a dummy API key. All findings are read from the recorded request bodies and the stream-json output. Raw material: \`results/isolation-report-raw/\`.`, '');
  if (r.skipped.length) L.push(`Skipped conditions: ${r.skipped.map((s: any) => `${s.kind} (${s.reason})`).join('; ')}`, '');
  const demos = sc.filter((s) => s.kind.startsWith('demo:'));
  const agentic = sc.filter((s) => !s.kind.startsWith('max-turns') && s.kind !== 'single-shot' && !s.kind.endsWith('(no-deny)') && !s.kind.startsWith('demo:'));
  const yn = (b: boolean | undefined | null) => (b == null ? 'n/a' : b ? 'yes' : 'no');
  L.push('## Per scenario (agentic protocol)', '', '| profile | condition | ran | tools offered | tool-schema tokens | MCP tools | MCP as expected | CLAUDE.md text in request | skill listing | cwd visible | banned tools offered |', '|---|---|---|---|---:|---|---|---|---|---|---|');
  for (const s of agentic) {
    if (!s.ok) { L.push(`| ${s.profile} | ${s.kind} | **FAILED** | ${trunc((s.error ?? '').replace(/\n/g, ' '), 120)} | | | | | | | |`); continue; }
    L.push(`| ${s.profile} | ${s.kind} | yes | ${s.tools_offered!.filter((n) => !n.startsWith('mcp__')).join(', ')} | ${s.tool_schema_tokens} | ${s.mcp_tools!.length ? s.mcp_tools!.length + ': ' + trunc(s.mcp_tools!.slice(0, 3).join(', '), 70) : 'none'} | ${yn(s.mcp_as_expected)} | ${s.claude_md_hits!.length ? 'YES ' + [...new Set(s.claude_md_hits!.map((h) => h.needle))].slice(0, 3).join('; ') : 'no'} | ${s.skill_hits!.length ? 'YES ' + [...new Set(s.skill_hits!.map((h) => h.needle))].join('; ') : 'no'} | ${yn(s.cwd_visible!.found)} | ${s.banned_offered!.length ? s.banned_offered!.join(', ') : 'none'} |`);
  }
  const ctl = sc.find((x) => x.profile === 'control' && x.ok);
  if (ctl) L.push('', `Positive control (no isolation flags, \`--tools Read\`, same mock API): CLAUDE.md strings found: ${ctl.claude_md_hits!.length ? [...new Set(ctl.claude_md_hits!.map((h) => h.needle))].slice(0, 4).join('; ') + ' in ' + [...new Set(ctl.claude_md_hits!.map((h) => h.where))].join(', ') : 'NONE (detector untested!)'}; skill listing hits: ${ctl.skill_hits!.length ? [...new Set(ctl.skill_hits!.map((h) => h.needle))].join('; ') : 'none'}; memory hits: ${ctl.memory_hits!.length ? 'yes' : 'none'}; tools offered: ${ctl.tools_offered!.length} (${ctl.tools_offered!.slice(0, 12).join(', ')}...); system+tools tokens: ${ctl.system_prompt_tokens} + ${ctl.tool_schema_tokens}.`);
  L.push('', '## Init-fingerprint check (`checkInit`, applied to every run; a mismatch kills the run and excludes it)', '', '| profile | condition | mismatch categories |', '|---|---|---|');
  for (const s of agentic.filter((x) => x.ok && x.profile !== 'control' && x.init_check)) L.push(`| ${s.profile} | ${s.kind} | ${s.init_check!.categories.length ? '**' + s.init_check!.categories.join(', ') + '**' : 'none (matches expected set)'} |`);
  L.push('', '### Exclusion demonstrations (restricted-oauth, baseline)', '');
  for (const d of demos) L.push(`- \`${d.kind}\`: outcome \`${d.outcome?.status}${d.outcome?.infra_kind ? ':' + d.outcome.infra_kind : ''}\`${d.outcome?.reason ? ' (' + d.outcome.reason.slice(0, 120) + ')' : ''}; init check: ${d.init_check?.categories.join(', ') || 'none'}${d.init_check?.details.length ? ' - ' + d.init_check.details.join('; ') : ''}; tools in init: ${(d.tools_offered ?? []).join(', ')}; API requests received by the mock: ${d.requests ?? '?'}`);
  L.push('', '## MCP tool surface (read-only policy)', '', '| profile | condition | MCP status | MCP tools offered | tokens of MCP tool schemas per turn | denied tools expected | denied tools offered | attempt to call a denied tool |', '|---|---|---|---:|---:|---:|---|---|');
  for (const s of sc.filter((x) => x.ok && x.mcp_expected !== undefined && x.profile !== 'control' && x.kind !== 'baseline' && x.kind !== 'single-shot' && !x.kind.startsWith('max-turns'))) {
    L.push(`| ${s.profile} | ${s.kind} | ${s.mcp_connected ? 'connected' : 'NOT connected'} | ${s.mcp_tools!.length} | ${s.mcp_tool_schema_tokens} | ${s.denied_expected!.length} | ${s.denied_present!.length ? 'PRESENT: ' + s.denied_present!.join(', ') : 'none (absent)'} | ${s.denied_attempt ? '`' + s.denied_attempt.replace(/\n/g, ' ') + '`' : '-'} |`);
  }
  L.push('', '## Result event of the scripted mock run (baseline condition)', '', '| profile | subtype | is_error | num_turns | structured_output | total_cost_usd | usage (input / output / cache_read / cache_write) | permission_denials |', '|---|---|---|---:|---|---:|---|---:|');
  for (const s of agentic.filter((x) => x.kind === 'baseline' && x.ok && x.profile !== 'control')) {
    const res: any = s.result;
    const u = res.usage ?? {};
    L.push(`| ${s.profile} | ${res.subtype} | ${res.is_error} | ${res.num_turns} | ${res.structured_output_present ? 'present' : 'absent'} | ${res.total_cost_usd} | ${u.input_tokens} / ${u.output_tokens} / ${u.cache_read_input_tokens} / ${u.cache_creation_input_tokens} | ${res.permission_denials} |`);
  }
  L.push('', '## Out-of-workspace reads and banned tool attempts (baseline condition)', '');
  for (const s of agentic.filter((x) => x.kind === 'baseline' && x.ok && x.profile !== 'control')) {
    L.push(`### ${s.profile}`, '', `- Forbidden dataset read (absolute path): denied=${s.forbidden_read!.denied}; tool_result: \`${s.forbidden_read!.text}\``);
    for (const o of s.outside_reads!) L.push(`- Other outside access ${JSON.stringify(o.input)}: denied=${o.denied}; \`${o.text}\``);
    for (const [t, txt] of Object.entries(s.banned_attempts!)) L.push(`- Attempted ${t}: \`${txt}\``);
    L.push(`- Workspace file changes during the run: +${s.workspace_changes!.added.length} ~${s.workspace_changes!.changed.length} -${s.workspace_changes!.removed.length}`, `- Files written under ~/.claude*, ~/.config/claude-accounts attributable to this run: ${s.home_writes!.attributed.length ? s.home_writes!.attributed.map((x) => '`' + x + '`').join(', ') : 'none'} (${s.home_writes!.unattributed} other changed files from concurrent sessions)`, `- cwd visible in: ${s.cwd_visible!.where.join(', ') || 'nowhere'}`, `- Init: skills=${JSON.stringify(s.init_extra!.skills)} slash_commands=${JSON.stringify(s.init_extra!.slash_commands)} agents=${JSON.stringify(s.init_extra!.agents)} plugins=${JSON.stringify(s.init_extra!.plugins)} permissionMode=${s.init_extra!.permissionMode}`, `- System prompt (${s.system_prompt_tokens} proxy tokens): \`${(s.system_prompt_text ?? '').replace(/\n/g, ' ')}\``, '');
  }
  L.push('## --max-turns 2 (12-step script)', '', '| profile | subtype | is_error | num_turns | structured_output | stop_reason(mapped by our parser) |', '|---|---|---|---:|---|---|');
  for (const s of sc.filter((x) => x.kind.startsWith('max-turns'))) {
    if (!s.ok) { L.push(`| ${s.profile} | FAILED ${trunc(s.error ?? '', 100)} | | | | |`); continue; }
    const res: any = s.result;
    L.push(`| ${s.profile} | ${res.subtype} | ${res.is_error} | ${res.num_turns} | ${res.structured_output_present ? 'present' : 'absent'} | ${res.subtype === 'error_max_turns' ? 'max_turns' : '?'} |`);
  }
  L.push('', '## Single-shot (`--tools ""`, json-schema)', '', '| profile | tools offered | structured_output | num_turns | cost_usd | tool-schema tokens | system prompt tokens |', '|---|---|---|---:|---:|---:|---:|');
  for (const s of sc.filter((x) => x.kind === 'single-shot')) {
    if (!s.ok) { L.push(`| ${s.profile} | FAILED ${trunc(s.error ?? '', 100)} | | | | | |`); continue; }
    const res: any = s.result;
    L.push(`| ${s.profile} | ${s.tools_offered!.join(', ') || 'none'} | ${res.structured_output_present ? 'present' : 'absent'} | ${res.num_turns} | ${res.total_cost_usd} | ${s.tool_schema_tokens} | ${s.system_prompt_tokens} |`);
  }
  const f = r.filesystem;
  const tally = new Map<string, number>();
  const nonCtl = sc.filter((x) => x.ok && x.profile !== 'control');
  for (const x of nonCtl) for (const pth of new Set([...x.home_writes!.attributed, ...x.home_writes!.unattributed_paths])) tally.set(pth, (tally.get(pth) ?? 0) + 1);
  const ctlW = sc.find((x) => x.profile === 'control')?.home_writes;
  L.push('', '## Files written outside the workspace', '', `Per-scenario before/after listings (changed paths seen by ${nonCtl.length} isolated scenarios; a path seen in nearly all of them is written by the children, a path seen once is another live session): ${[...tally].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => '`' + k.replace(os.homedir(), '~') + '` x' + n).join('; ') || 'none'}.`, ctlW ? `The no-isolation control additionally wrote: ${[...ctlW.attributed, ...ctlW.unattributed_paths].map((x) => '`' + x.replace(os.homedir(), '~') + '`').join(', ')}.` : '', '', `Listing of ${f.roots.join(', ')} before/after the whole run: ${f.files_before} -> ${f.files_after} files; added ${f.added}, changed ${f.changed}, removed ${f.removed}.`, '', `- Attributable to the verify children (mention a child session id or the workspace path): **${f.attributed_to_verify_children.length}**${f.attributed_to_verify_children.length ? '\n' + f.attributed_to_verify_children.slice(0, 20).map((x: string) => `  - \`${x}\``).join('\n') : ''}`, `- Unattributed changes (other live sessions): ${f.unattributed_changes}. ${f.note}`, '', 'Tool schema tokens per tool (baseline, restricted-oauth):', '');
  const b = agentic.find((x) => x.kind === 'baseline' && x.profile === 'restricted-oauth' && x.ok);
  L.push(...[] as string[]);
  if (b) for (const [t, n] of Object.entries(b.tool_schema_tokens_by_tool!)) L.push(`- ${t}: ${n}`);
  return L.join('\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
