/**
 * Experiment-2 runner. Builds every (task × condition × repeat) item, runs it through a backend, scores it with the
 * fixed automatic scorer, and writes experiments/02-agent-diagnosis/results/<run_id>/{runs.jsonl,meta.json}.
 * Billable backends are refused unless an approval file covers the exact plan (see approval.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { abs, type BenchmarkConfig } from '../config.js';
import { selectTasks } from '../cli/commands.js';
import type { SymbolIndex } from '../evaluation/symbol-index.js';
import type { GroundTruthTask } from '../types.js';
import { EXP_DIR, loadContexts } from './contexts.js';
import { PROMPT_VERSION, SINGLE_SHOT_SYSTEM_PROMPT, singleShotPrompt } from './prompt.js';
import { bugLocations, parseDiagnosis, scoreDiagnosis, snapshotIndex, type DiagnosisScore } from './scoring.js';
import type { SingleShotBackend, SingleShotResult } from './backends/single-shot.js';
import type { AgentRun } from './types.js';

export interface ScoredRun extends AgentRun { score: DiagnosisScore; prompt_version: string; context_tokens?: number }

function scorer(cfg: BenchmarkConfig) {
  const cache = new Map<string, { index: SymbolIndex; bugs: ReturnType<typeof bugLocations> }>();
  return (t: GroundTruthTask) => {
    let c = cache.get(t.task_id);
    if (!c) {
      c = { index: snapshotIndex(cfg, t.task_id), bugs: bugLocations(cfg, t.task_id) };
      cache.set(t.task_id, c);
    }
    return c;
  };
}

export async function runSingleShot(cfg: BenchmarkConfig, opts: { runId: string; split: 'dev' | 'test'; budget: number; methods: string[]; repeats: number; backend: SingleShotBackend; taskIds?: string[] }): Promise<ScoredRun[] & { halted: string | null; status: string }> {
  const tasks = selectTasks(cfg, opts.split).filter((t) => !opts.taskIds || opts.taskIds.includes(t.task_id));
  const ctx = loadContexts(opts.split, opts.budget);
  const items = [];
  for (const t of tasks) for (const m of opts.methods) for (let r = 0; r < opts.repeats; r++) {
    const row = ctx.find((c) => c.task_id === t.task_id && c.method === m);
    if (!row) throw new Error(`no context for ${t.task_id}/${m}`);
    const kind = m === 'none' ? 'file-list' : m === 'oracle' ? 'oracle' : 'retrieved';
    items.push({ id: `${t.task_id}|single:${m}@${opts.budget}|${r}`, system: SINGLE_SHOT_SYSTEM_PROMPT, prompt: singleShotPrompt(t.description, row.context, kind), context: row.context, task: t, method: m, repeat: r, ctxTokens: row.tokens });
  }
  const dir = abs(path.join(EXP_DIR, 'results', opts.runId));
  fs.mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  const results = await opts.backend.run(items, dir);
  const byId = new Map(results.map((r) => [r.id, r]));
  const sc = scorer(cfg);
  // Excluded (infrastructure / init-fingerprint) and pending (halted) items are never scored.
  const excluded = items.map((it) => byId.get(it.id)).filter((r) => r?.excluded) as SingleShotResult[];
  const runs: ScoredRun[] = items.filter((it) => !byId.get(it.id)?.excluded).map((it) => {
    const r = byId.get(it.id)!;
    const { diagnosis, error } = parseDiagnosis(r.raw);
    const { index, bugs } = sc(it.task);
    return {
      run_id: it.id, task_id: it.task.task_id, condition: `single:${it.method}@${opts.budget}`, backend: opts.backend.name, model: opts.backend.model, repeat: it.repeat,
      diagnosis, parse_error: error ?? r.error, usage: r.usage, usage_source: r.usage_source, cost_usd: r.cost_usd, latency_ms: r.latency_ms, turns: 1, tool_calls: {}, retrieval_calls: 0,
      stop_reason: diagnosis ? 'submitted' : 'error', workspace_hash: '', score: scoreDiagnosis(index, it.task, bugs, diagnosis), prompt_version: PROMPT_VERSION, context_tokens: it.ctxTokens, ...(r.extra ?? {}),
    };
  });
  fs.writeFileSync(path.join(dir, 'excluded.jsonl'), excluded.map((r) => JSON.stringify({ run_id: r.id, excluded: r.excluded })).join('\n') + (excluded.length ? '\n' : ''));
  const nPending = excluded.filter((r) => r.excluded === 'pending').length;
  const status = results.halted ? 'halted' : nPending ? 'incomplete' : 'completed';
  fs.writeFileSync(path.join(dir, 'runs.jsonl'), runs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ run_id: opts.runId, protocol: 'single_shot', split: opts.split, budget: opts.budget, methods: opts.methods, repeats: opts.repeats, backend: opts.backend.name, model: opts.backend.model, billable: opts.backend.billable, prompt_version: PROMPT_VERSION, n_items: items.length, n_scored: runs.length, n_excluded: excluded.length - nPending, n_pending: nPending, status, halted: results.halted ?? null, backend_meta: results.meta ?? null, wall_ms_this_invocation: Date.now() - t0, updated: new Date().toISOString() }, null, 2) + '\n');
  return Object.assign(runs, { halted: results.halted ?? null, status });
}
