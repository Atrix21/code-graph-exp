/**
 * Single-shot contexts: each retrieval method's NATIVE context for each task, at a given budget.
 * Test split: reused verbatim from experiment 1's frozen held-out runs (final-test = 8k, final-test-budget2000 = 2k).
 * Dev split: regenerated with the same frozen configurations via runPerTask (non-billable).
 * Plus two bounds: 'none' (repository file list only) and 'oracle' (ground-truth relevant symbols, shuffled).
 */
import fs from 'node:fs';
import path from 'node:path';
import { abs, type BenchmarkConfig } from '../config.js';
import { selectTasks } from '../cli/commands.js';
import { snapshotIndex } from './scoring.js';
import { renderSymbolUniform } from '../evaluation/metrics.js';
import { REGISTRY } from '../evaluation/methods.js';
import { runPerTask } from '../evaluation/runner.js';
import { countTokens, truncateToTokens } from '../evaluation/token-accounting.js';
import { oracleContext } from './prompt.js';

export const EXP_DIR = 'experiments/02-agent-diagnosis';
export const SINGLE_SHOT_METHODS = ['ripgrep', 'bm25', 'embeddings', 'graphify', 'code_review_graph', 'custom_graph', 'hybrid'];

export interface ContextRow { task_id: string; method: string; budget: number; context: string; tokens: number; source: string }

const EXP1_RUNS: Record<number, string> = { 8000: 'final-test', 2000: 'final-test-budget2000' };

export async function buildContexts(cfg: BenchmarkConfig, split: 'dev' | 'test', budget: number): Promise<ContextRow[]> {
  const tasks = selectTasks(cfg, split);
  const rows: ContextRow[] = [];
  const exp1 = EXP1_RUNS[budget];
  const exp1Dir = exp1 ? path.join(abs(cfg.results_dir), exp1, 'raw') : null;
  if (split === 'test' && exp1Dir && fs.existsSync(exp1Dir)) {
    for (const m of SINGLE_SHOT_METHODS) {
      for (const l of fs.readFileSync(path.join(exp1Dir, `${m}.jsonl`), 'utf8').split('\n').filter(Boolean)) {
        const o = JSON.parse(l);
        rows.push({ task_id: o.task_id, method: m, budget, context: o.context, tokens: countTokens(o.context), source: `exp1:${exp1}` });
      }
    }
  } else {
    const runs = await runPerTask(cfg, tasks, SINGLE_SHOT_METHODS.map((n) => ({ name: n, make: REGISTRY[n] })), { maxResults: cfg.budget.maxResults, maxContextTokens: budget }, () => {});
    for (const r of runs) for (const o of r.outputs) rows.push({ task_id: o.task_id, method: r.method, budget, context: o.context, tokens: countTokens(o.context), source: 'regenerated-frozen-config' });
  }
  // Bounds: file list (no content) and oracle (ground-truth relevant symbols), both capped at the same budget.
  for (const t of tasks) {
    const index = snapshotIndex(cfg, t.task_id);
    const fileList = truncateToTokens(index.allFiles().sort().join('\n'), budget).text;
    rows.push({ task_id: t.task_id, method: 'none', budget, context: fileList, tokens: countTokens(fileList), source: 'file-list' });
    const oracle = truncateToTokens(oracleContext(t.relevant_symbols.map((k) => ({ key: k, text: renderSymbolUniform(index, k).text }))), budget).text;
    rows.push({ task_id: t.task_id, method: 'oracle', budget, context: oracle, tokens: countTokens(oracle), source: 'ground-truth' });
  }
  const out = abs(path.join(EXP_DIR, 'contexts', `${split}-${budget}.jsonl`));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return rows;
}

export function loadContexts(split: string, budget: number): ContextRow[] {
  const p = abs(path.join(EXP_DIR, 'contexts', `${split}-${budget}.jsonl`));
  if (!fs.existsSync(p)) throw new Error(`contexts missing: run \`agent-eval contexts --split ${split} --budget ${budget}\``);
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
