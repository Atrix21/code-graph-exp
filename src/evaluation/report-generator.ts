/**
 * Aggregation + markdown report tables. Means with seeded bootstrap 95% CIs; paired
 * bootstrap for method differences. With ~14 held-out tasks CIs are wide: read them.
 */
import type { TaskMetrics } from './metrics.js';
import { BUDGETS, bootstrapCI, mean, median, pairedBootstrap } from './metrics.js';

export const HEADLINE: (keyof TaskMetrics)[] = [
  'sym_recall_5', 'sym_recall_10', 'sym_precision_5', 'sym_precision_10', 'rc_hit_1', 'rc_hit_5', 'rc_hit_10', 'rc_mrr',
  'file_recall_5', 'file_recall_10', 'file_rc_hit_1', 'file_rc_hit_5', 'file_rc_mrr', 'sym_recall_all',
];

export interface Aggregate {
  method: string;
  n: number;
  means: Record<string, number>;
  ci: Record<string, [number, number]>;
  rc_found_rate: number;
  ttr_median_found: number | null;
  ttr_mean_capped: number; // tokens-to-root-cause, unfound capped at 2x the 8k budget (16k)
  native_tokens_mean: number;
  native_tokens_median: number;
  uniform_top10_tokens_mean: number;
  recall_at_budget: Record<string, number>;
  rc_hit_at_budget: Record<string, number>;
  r10_per_1k_uniform: number;
  native_recall_per_1k_native: number;
  latency_ms_median: number;
  llm_tokens_total: number | null;
}

export const TTR_CAP = 16000;

export function aggregate(rows: TaskMetrics[], seed = 1234): Aggregate {
  const means: Record<string, number> = {};
  const ci: Record<string, [number, number]> = {};
  for (const k of HEADLINE) {
    const xs = rows.map((r) => r[k] as number);
    means[k] = mean(xs);
    ci[k] = bootstrapCI(xs, seed);
  }
  const found = rows.filter((r) => r.tokens_to_root_cause != null).map((r) => r.tokens_to_root_cause!);
  const rab: Record<string, number> = {};
  const rcab: Record<string, number> = {};
  for (const B of BUDGETS) {
    rab[B] = mean(rows.map((r) => r.recall_at_budget[B]));
    rcab[B] = mean(rows.map((r) => r.rc_hit_at_budget[B]));
  }
  const nat = rows.map((r) => r.native_context_tokens);
  const uni = rows.map((r) => r.uniform_tokens_top10);
  const llm = rows.map((r) => r.llm_tokens);
  return {
    method: rows[0]?.method ?? '?', n: rows.length, means, ci,
    rc_found_rate: found.length / Math.max(1, rows.length),
    ttr_median_found: found.length ? median(found) : null,
    ttr_mean_capped: mean(rows.map((r) => Math.min(TTR_CAP, r.tokens_to_root_cause ?? TTR_CAP))),
    native_tokens_mean: mean(nat), native_tokens_median: median(nat),
    uniform_top10_tokens_mean: mean(uni),
    recall_at_budget: rab, rc_hit_at_budget: rcab,
    r10_per_1k_uniform: means.sym_recall_10 / (mean(uni) / 1000),
    native_recall_per_1k_native: means.sym_recall_all / (mean(nat) / 1000),
    latency_ms_median: median(rows.map((r) => r.latency_ms)),
    llm_tokens_total: llm.some((x) => x == null) ? null : llm.reduce((a, b) => a! + b!, 0)!,
  };
}

const f2 = (x: number | null | undefined) => (x == null || Number.isNaN(x) ? '—' : x.toFixed(2));
const f0 = (x: number | null | undefined) => (x == null || Number.isNaN(x) ? '—' : Math.round(x).toLocaleString('en-US'));
const withCi = (a: Aggregate, k: string) => `${f2(a.means[k])} [${f2(a.ci[k][0])}–${f2(a.ci[k][1])}]`;

export function accuracyTable(aggs: Aggregate[]): string {
  const head = '| Method | n | Recall@5 | Recall@10 | Precision@5 | Precision@10 | RC Acc@1 | RC Acc@5 | RC MRR | File Recall@10 | RC file Acc@1 |';
  const sep = '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|';
  const rows = aggs.map((a) => `| ${a.method} | ${a.n} | ${withCi(a, 'sym_recall_5')} | ${withCi(a, 'sym_recall_10')} | ${f2(a.means.sym_precision_5)} | ${f2(a.means.sym_precision_10)} | ${f2(a.means.rc_hit_1)} | ${f2(a.means.rc_hit_5)} | ${withCi(a, 'rc_mrr')} | ${f2(a.means.file_recall_10)} | ${f2(a.means.file_rc_hit_1)} |`);
  return [head, sep, ...rows].join('\n');
}

export function tokenTable(aggs: Aggregate[]): string {
  const head = `| Method | Native ctx tokens (mean / median) | Uniform top-10 tokens | Recall@10 per 1k uniform tok | Native recall per 1k native tok | Tokens-to-root-cause (median, found) | TTR mean (cap ${TTR_CAP / 1000}k) | RC found in results | ${BUDGETS.map((b) => `Recall@${b / 1000}k tok`).join(' | ')} | Latency p50 (ms) | Retrieval LLM tokens |`;
  const sep = '|---|---:|---:|---:|---:|---:|---:|---:|' + BUDGETS.map(() => '---:|').join('') + '---:|---:|';
  const rows = aggs.map((a) => `| ${a.method} | ${f0(a.native_tokens_mean)} / ${f0(a.native_tokens_median)} | ${f0(a.uniform_top10_tokens_mean)} | ${f2(a.r10_per_1k_uniform)} | ${f2(a.native_recall_per_1k_native)} | ${f0(a.ttr_median_found)} | ${f0(a.ttr_mean_capped)} | ${f2(a.rc_found_rate)} | ${BUDGETS.map((b) => f2(a.recall_at_budget[b])).join(' | ')} | ${f0(a.latency_ms_median)} | ${a.llm_tokens_total == null ? 'unavailable' : f0(a.llm_tokens_total)} |`);
  return [head, sep, ...rows].join('\n');
}

export function pairedTable(rowsByMethod: Map<string, TaskMetrics[]>, ref: string, metric: keyof TaskMetrics): string {
  const r = rowsByMethod.get(ref);
  if (!r) return '';
  const head = `| ${ref} vs | mean Δ ${String(metric)} | 95% CI | P(Δ≤0) |`;
  const sep = '|---|---:|---:|---:|';
  const out: string[] = [head, sep];
  for (const [m, rows] of rowsByMethod) {
    if (m === ref) continue;
    const a = r.map((x) => x[metric] as number);
    const byTask = new Map(rows.map((x) => [x.task_id, x[metric] as number]));
    const b = r.map((x) => byTask.get(x.task_id)!);
    const p = pairedBootstrap(a, b);
    out.push(`| ${m} | ${f2(p.mean_diff)} | [${f2(p.ci[0])}, ${f2(p.ci[1])}] | ${f2(p.p_le_0)} |`);
  }
  return out.join('\n');
}

export function perTaskTable(rowsByMethod: Map<string, TaskMetrics[]>, metric: keyof TaskMetrics = 'rc_rank'): string {
  const methods = [...rowsByMethod.keys()];
  const tasks = [...new Set([...rowsByMethod.values()].flat().map((r) => r.task_id))];
  const head = `| task | ${methods.join(' | ')} |`;
  const sep = '|---|' + methods.map(() => '---:|').join('');
  const lines = tasks.map((t) => `| ${t} | ${methods.map((m) => {
    const r = rowsByMethod.get(m)!.find((x) => x.task_id === t);
    const v = r?.[metric];
    return v == null ? '—' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : String(v);
  }).join(' | ')} |`);
  return [head, sep, ...lines].join('\n');
}
