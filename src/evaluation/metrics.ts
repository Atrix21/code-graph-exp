/**
 * Retrieval metrics. All metrics operate on the normalised (canonical-symbol) ranking,
 * so every method is scored by identical rules.
 */
import type { GroundTruthTask } from '../types.js';
import type { NormalisedOutput } from './normalise.js';
import { SymbolIndex } from './symbol-index.js';
import { countTokens } from './token-accounting.js';

export const UNIFORM_MAX_LINES = 80;
export const MODULE_CONTEXT_LINES = 3;
export const BUDGETS = [1000, 2000, 4000, 8000];

export interface TaskMetrics {
  task_id: string;
  method: string;
  sym_recall_5: number;
  sym_recall_10: number;
  sym_precision_5: number;
  sym_precision_10: number;
  rc_hit_1: number;
  rc_hit_5: number;
  rc_hit_10: number;
  rc_mrr: number;
  rc_rank: number | null;
  file_recall_5: number;
  file_recall_10: number;
  file_rc_hit_1: number;
  file_rc_hit_5: number;
  file_rc_mrr: number;
  /** Uniformly rendered tokens of the ranked symbols up to and including the first root-cause symbol (null = never reached). */
  tokens_to_root_cause: number | null;
  /** Fraction of relevant symbols whose uniform rendering fits within the first B tokens. */
  recall_at_budget: Record<string, number>;
  rc_hit_at_budget: Record<string, number>;
  /** Uniformly rendered tokens of the top-10 symbols. */
  uniform_tokens_top10: number;
  /** Tokens of the method's native context text. */
  native_context_tokens: number;
  /** Fraction of relevant symbols that appear anywhere in the returned results. */
  sym_recall_all: number;
  n_results: number;
  n_unresolved: number;
  latency_ms: number;
  llm_tokens: number | null;
}

const renderCache = new Map<string, { text: string; tokens: number }>();

export function renderSymbolUniform(index: SymbolIndex, key: string, anchorLine?: number): { text: string; tokens: number } {
  const ck = `${key}@${anchorLine ?? ''}`;
  const c = renderCache.get(ck);
  if (c) return c;
  const s = index.byKey.get(key);
  if (!s) return { text: '', tokens: 0 };
  const lines = index.fileLines.get(s.file) ?? [];
  let a: number, b: number;
  if (s.kind === 'module') {
    const anchor = anchorLine ?? 1;
    a = Math.max(1, anchor - MODULE_CONTEXT_LINES);
    b = Math.min(lines.length, anchor + MODULE_CONTEXT_LINES);
  } else {
    a = s.start_line;
    b = Math.min(s.end_line, s.start_line + UNIFORM_MAX_LINES - 1);
  }
  const body = lines.slice(a - 1, b).join('\n');
  const text = `// ${s.file}:${a}-${b} ${s.name}\n${body}\n`;
  const r = { text, tokens: countTokens(text) };
  renderCache.set(ck, r);
  return r;
}

function hits(list: string[], k: number, rel: Set<string>): number {
  let n = 0;
  for (const x of list.slice(0, k)) if (rel.has(x)) n++;
  return n;
}

function firstRank(list: string[], targets: Set<string>): number | null {
  const i = list.findIndex((x) => targets.has(x));
  return i < 0 ? null : i + 1;
}

export function computeTaskMetrics(
  index: SymbolIndex,
  gt: GroundTruthTask,
  norm: NormalisedOutput,
  extras: { native_context_tokens: number; latency_ms: number; llm_tokens: number | null; n_results: number },
): TaskMetrics {
  const rel = new Set(gt.relevant_symbols);
  const rc = new Set(gt.root_cause_symbols);
  const relFiles = new Set(gt.relevant_files);
  const rcFiles = new Set(gt.root_cause_symbols.map((k) => k.split('::')[0]));
  const S = norm.rankedSymbols;
  const F = norm.rankedFiles;

  const rcRank = firstRank(S, rc);
  const fRcRank = firstRank(F, rcFiles);

  // Uniform rendering in rank order.
  let cum = 0;
  let tokensToRc: number | null = null;
  const cumAt: { key: string; cum: number }[] = [];
  for (const key of S) {
    cum += renderSymbolUniform(index, key, norm.anchorLines.get(key)).tokens;
    cumAt.push({ key, cum });
    if (tokensToRc == null && rc.has(key)) tokensToRc = cum;
  }
  const recallAtBudget: Record<string, number> = {};
  const rcAtBudget: Record<string, number> = {};
  for (const B of BUDGETS) {
    const within = cumAt.filter((x) => x.cum <= B).map((x) => x.key);
    recallAtBudget[B] = hits(within, within.length, rel) / rel.size;
    rcAtBudget[B] = within.some((k) => rc.has(k)) ? 1 : 0;
  }
  const top10Tokens = cumAt.length ? cumAt[Math.min(9, cumAt.length - 1)].cum : 0;

  return {
    task_id: gt.task_id,
    method: norm.method,
    sym_recall_5: hits(S, 5, rel) / rel.size,
    sym_recall_10: hits(S, 10, rel) / rel.size,
    sym_precision_5: hits(S, 5, rel) / 5,
    sym_precision_10: hits(S, 10, rel) / 10,
    rc_hit_1: rcRank != null && rcRank <= 1 ? 1 : 0,
    rc_hit_5: rcRank != null && rcRank <= 5 ? 1 : 0,
    rc_hit_10: rcRank != null && rcRank <= 10 ? 1 : 0,
    rc_mrr: rcRank ? 1 / rcRank : 0,
    rc_rank: rcRank,
    file_recall_5: hits(F, 5, relFiles) / relFiles.size,
    file_recall_10: hits(F, 10, relFiles) / relFiles.size,
    file_rc_hit_1: fRcRank != null && fRcRank <= 1 ? 1 : 0,
    file_rc_hit_5: fRcRank != null && fRcRank <= 5 ? 1 : 0,
    file_rc_mrr: fRcRank ? 1 / fRcRank : 0,
    tokens_to_root_cause: tokensToRc,
    recall_at_budget: recallAtBudget,
    rc_hit_at_budget: rcAtBudget,
    uniform_tokens_top10: top10Tokens,
    native_context_tokens: extras.native_context_tokens,
    sym_recall_all: hits(S, S.length, rel) / rel.size,
    n_results: extras.n_results,
    n_unresolved: norm.unresolved,
    latency_ms: extras.latency_ms,
    llm_tokens: extras.llm_tokens,
  };
}

/* ------------------------------ Aggregation ------------------------------ */

/** Deterministic PRNG (mulberry32) so bootstrap CIs are reproducible. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function bootstrapCI(xs: number[], seed = 1234, iters = 5000, alpha = 0.05): [number, number] {
  if (xs.length === 0) return [NaN, NaN];
  const r = rng(seed);
  const ms: number[] = [];
  for (let i = 0; i < iters; i++) {
    let s = 0;
    for (let j = 0; j < xs.length; j++) s += xs[Math.floor(r() * xs.length)];
    ms.push(s / xs.length);
  }
  ms.sort((a, b) => a - b);
  return [ms[Math.floor((alpha / 2) * iters)], ms[Math.floor((1 - alpha / 2) * iters) - 1]];
}

/** Paired bootstrap on per-task differences a-b. Returns mean diff, CI and P(diff<=0). */
export function pairedBootstrap(a: number[], b: number[], seed = 4321, iters = 5000) {
  const d = a.map((x, i) => x - b[i]);
  const [lo, hi] = bootstrapCI(d, seed, iters);
  const r = rng(seed + 1);
  let le0 = 0;
  for (let i = 0; i < iters; i++) {
    let s = 0;
    for (let j = 0; j < d.length; j++) s += d[Math.floor(r() * d.length)];
    if (s / d.length <= 0) le0++;
  }
  return { mean_diff: mean(d), ci: [lo, hi] as [number, number], p_le_0: le0 / iters };
}
