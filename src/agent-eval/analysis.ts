/**
 * Aggregation for experiment 2. Repeats are averaged per task first (the task is the unit of analysis), then
 * conditions are compared with paired bootstrap over tasks (same seeded PRNG as experiment 1).
 */
import fs from 'node:fs';
import path from 'node:path';
import { bootstrapCI, mean, median, pairedBootstrap } from '../evaluation/metrics.js';
import type { ScoredRun } from './runner.js';

export const PRIMARY = 'rc_line_at_1';
const ACC_KEYS = ['valid', 'rc_at_1', 'rc_at_3', 'rc_line_at_1', 'line_at_1', 'line_at_3', 'file_at_1'] as const;

export function loadRuns(dir: string): ScoredRun[] {
  return fs.readFileSync(path.join(dir, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const totalTokens = (r: ScoredRun) => (r.usage ? r.usage.input + r.usage.output + r.usage.cache_read + r.usage.cache_write : NaN);

/** Per-condition, per-task means over repeats. */
export function perTask(runs: ScoredRun[]): Map<string, Map<string, Record<string, number>>> {
  const out = new Map<string, Map<string, Record<string, number>>>();
  const groups = new Map<string, ScoredRun[]>();
  for (const r of runs) {
    const k = `${r.condition}\0${r.task_id}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  for (const [k, rs] of groups) {
    const [cond, task] = k.split('\0');
    const rec: Record<string, number> = {};
    for (const a of ACC_KEYS) rec[a] = mean(rs.map((r) => r.score[a]));
    rec.tokens = mean(rs.map(totalTokens));
    rec.cost = rs.some((r) => r.cost_usd == null) ? NaN : mean(rs.map((r) => r.cost_usd!));
    rec.latency = mean(rs.map((r) => r.latency_ms));
    rec.turns = mean(rs.map((r) => r.turns ?? NaN));
    rec.retrieval_calls = mean(rs.map((r) => r.retrieval_calls));
    rec.repeat_agreement = rs.length > 1 ? (rs.every((r) => r.score.rc_line_at_1 === rs[0].score.rc_line_at_1) ? 1 : 0) : NaN;
    if (!out.has(cond)) out.set(cond, new Map());
    out.get(cond)!.set(task, rec);
  }
  return out;
}

const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '—');
const f0 = (x: number) => (Number.isFinite(x) ? Math.round(x).toLocaleString('en-US') : '—');

export function report(runs: ScoredRun[], reference?: string): string {
  const pt = perTask(runs);
  const conds = [...pt.keys()].sort();
  const rows = conds.map((c) => {
    const tasks = [...pt.get(c)!.values()];
    const m = (k: string) => mean(tasks.map((t) => t[k]));
    const ci = bootstrapCI(tasks.map((t) => t[PRIMARY]));
    const cost = m('cost');
    return `| ${c} | ${tasks.length} | ${f2(m(PRIMARY))} [${f2(ci[0])}–${f2(ci[1])}] | ${f2(m('rc_at_1'))} | ${f2(m('rc_at_3'))} | ${f2(m('line_at_1'))} | ${f2(m('file_at_1'))} | ${f2(m('valid'))} | ${f0(m('tokens'))} | ${Number.isFinite(cost) ? cost.toFixed(4) : '—'} | ${f0(median(tasks.map((t) => t.latency)))} | ${f2(m('turns'))} | ${f2(m('retrieval_calls'))} | ${Number.isFinite(cost) && cost > 0 ? f2(m(PRIMARY) / cost) : '—'} |`;
  });
  const out = [
    '| Condition | tasks | RC+line@1 [95% CI] | RC@1 | RC@3 | Line@1 | File@1 | Valid | Tokens/run | Cost/run (USD) | Latency p50 (ms) | Turns | Retrieval calls | RC+line@1 per $ |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...rows,
  ];
  if (reference && pt.has(reference)) {
    out.push('', `Paired differences vs \`${reference}\` (per-task means over repeats; Δ = condition − reference):`, '', '| Condition | Δ RC+line@1 [95% CI] | Δ tokens/run | Δ cost/run | W/L/T |', '|---|---:|---:|---:|---:|');
    const ref = pt.get(reference)!;
    for (const c of conds) {
      if (c === reference) continue;
      const cur = pt.get(c)!;
      const ids = [...ref.keys()].filter((t) => cur.has(t)).sort();
      const a = ids.map((t) => cur.get(t)![PRIMARY]), b = ids.map((t) => ref.get(t)![PRIMARY]);
      const p = pairedBootstrap(a, b);
      const w = a.filter((x, i) => x > b[i]).length, l = a.filter((x, i) => x < b[i]).length;
      const dt = mean(ids.map((t) => cur.get(t)!.tokens - ref.get(t)!.tokens));
      const dc = mean(ids.map((t) => cur.get(t)!.cost - ref.get(t)!.cost));
      out.push(`| ${c} | ${f2(p.mean_diff)} [${f2(p.ci[0])}, ${f2(p.ci[1])}] | ${f0(dt)} | ${Number.isFinite(dc) ? dc.toFixed(4) : '—'} | ${w}/${l}/${ids.length - w - l} |`);
    }
  }
  return out.join('\n');
}

/* ---------------------------- Confirmatory analysis (protocol §Analysis plan) ---------------------------- */

export interface Comparison { id: string; hypothesis: string; a: string; b: string; metric: string; lowerIsBetter?: boolean; subset?: 'all' | 'both-correct' }

export const CONFIRMATORY: Comparison[] = [
  { id: 'H1a', hypothesis: 'agentic hybrid > agentic baseline (RC+line@1)', a: 'agentic:hybrid', b: 'agentic:baseline', metric: PRIMARY },
  { id: 'H1b', hypothesis: 'agentic hybrid > agentic embeddings (RC+line@1)', a: 'agentic:hybrid', b: 'agentic:embeddings', metric: PRIMARY },
  { id: 'H1c-2k', hypothesis: 'single-shot hybrid > embeddings @2k (RC+line@1)', a: 'single:hybrid@2000', b: 'single:embeddings@2000', metric: PRIMARY },
  { id: 'H1c-8k', hypothesis: 'single-shot hybrid > embeddings @8k (RC+line@1)', a: 'single:hybrid@8000', b: 'single:embeddings@8000', metric: PRIMARY },
  { id: 'H2-tokens', hypothesis: 'agentic hybrid uses fewer tokens/run than baseline', a: 'agentic:hybrid', b: 'agentic:baseline', metric: 'tokens', lowerIsBetter: true },
  { id: 'H2-cost', hypothesis: 'agentic hybrid costs less/run than baseline', a: 'agentic:hybrid', b: 'agentic:baseline', metric: 'cost', lowerIsBetter: true },
];

export const EXPLORATORY_EFFICIENCY: Comparison[] = [
  { id: 'E-tokens-both-correct', hypothesis: 'tokens/run, tasks where both are correct', a: 'agentic:hybrid', b: 'agentic:baseline', metric: 'tokens', lowerIsBetter: true, subset: 'both-correct' },
  { id: 'E-latency', hypothesis: 'latency/run', a: 'agentic:hybrid', b: 'agentic:baseline', metric: 'latency', lowerIsBetter: true },
  { id: 'E-turns', hypothesis: 'turns/run', a: 'agentic:hybrid', b: 'agentic:baseline', metric: 'turns', lowerIsBetter: true },
];

/** Paired comparison over shared tasks. "Improvement" is a−b, sign-flipped for lower-is-better metrics. p ≈ P(improvement ≤ 0) under the bootstrap. */
export function compare(pt: Map<string, Map<string, Record<string, number>>>, c: Comparison) {
  const A = pt.get(c.a), B = pt.get(c.b);
  if (!A || !B) return { ...c, n: 0, missing: true as const };
  let ids = [...A.keys()].filter((t) => B.has(t)).sort();
  if (c.subset === 'both-correct') ids = ids.filter((t) => A.get(t)![PRIMARY] >= 0.5 && B.get(t)![PRIMARY] >= 0.5);
  const sign = c.lowerIsBetter ? -1 : 1;
  const a = ids.map((t) => sign * A.get(t)![c.metric]), b = ids.map((t) => sign * B.get(t)![c.metric]);
  if (!ids.length || a.some((x) => !Number.isFinite(x)) || b.some((x) => !Number.isFinite(x))) return { ...c, n: ids.length, missing: true as const };
  const p = pairedBootstrap(a, b);
  const w = a.filter((x, i) => x > b[i]).length, l = a.filter((x, i) => x < b[i]).length;
  return { ...c, n: ids.length, missing: false as const, mean_a: sign * mean(a), mean_b: sign * mean(b), improvement: p.mean_diff, ci: p.ci, p_one_sided: p.p_le_0, wins: w, losses: l, ties: ids.length - w - l };
}

/** Holm–Bonferroni over the confirmatory family (one-sided bootstrap p-values). */
export function holm(ps: number[], alpha = 0.05): { adjusted: number[]; reject: boolean[] } {
  const order = ps.map((p, i) => [p, i] as const).sort((x, y) => x[0] - y[0]);
  const adjusted = new Array(ps.length).fill(1);
  let running = 0;
  order.forEach(([p, i], k) => { running = Math.max(running, Math.min(1, (ps.length - k) * p)); adjusted[i] = running; });
  return { adjusted, reject: adjusted.map((p) => p <= alpha) };
}

export function repeatAgreement(runs: ScoredRun[]): Record<string, number> {
  const pt = perTask(runs);
  const out: Record<string, number> = {};
  for (const [c, tasks] of pt) {
    const v = [...tasks.values()].map((t) => t.repeat_agreement).filter(Number.isFinite);
    out[c] = v.length ? mean(v) : NaN;
  }
  return out;
}

export function confirmatoryReport(runs: ScoredRun[]): string {
  const pt = perTask(runs);
  const conf = CONFIRMATORY.map((c) => compare(pt, c));
  const present = conf.filter((c) => !c.missing) as Extract<ReturnType<typeof compare>, { missing: false }>[];
  const h = holm(present.map((c) => c.p_one_sided));
  const fmt = (x: number, m: string) => (m === 'cost' ? x.toFixed(4) : m === PRIMARY ? x.toFixed(2) : Math.round(x).toLocaleString('en-US'));
  const lines = ['| ID | Hypothesis | n tasks | A | B | Improvement [95% CI] | W/L/T | p (one-sided) | Holm-adjusted | Supported at α=0.05 |', '|---|---|---:|---:|---:|---:|---:|---:|---:|---|'];
  for (const c of conf) {
    if (c.missing) { lines.push(`| ${c.id} | ${c.hypothesis} | — | — | — | not run | — | — | — | — |`); continue; }
    const k = present.indexOf(c as any);
    lines.push(`| ${c.id} | ${c.hypothesis} | ${c.n} | ${fmt(c.mean_a, c.metric)} | ${fmt(c.mean_b, c.metric)} | ${fmt(c.improvement, c.metric)} [${fmt(c.ci[0], c.metric)}, ${fmt(c.ci[1], c.metric)}] | ${c.wins}/${c.losses}/${c.ties} | ${c.p_one_sided.toFixed(3)} | ${h.adjusted[k].toFixed(3)} | ${h.reject[k] ? 'yes' : 'no'} |`);
  }
  lines.push('', 'Exploratory efficiency (not part of the confirmatory family):', '', '| ID | Comparison | n | A | B | Improvement [95% CI] | W/L/T |', '|---|---|---:|---:|---:|---:|---:|');
  for (const c of EXPLORATORY_EFFICIENCY.map((x) => compare(pt, x))) {
    if (c.missing) { lines.push(`| ${c.id} | ${c.hypothesis} | — | — | — | not run | — |`); continue; }
    lines.push(`| ${c.id} | ${c.hypothesis} | ${c.n} | ${fmt(c.mean_a, c.metric)} | ${fmt(c.mean_b, c.metric)} | ${fmt(c.improvement, c.metric)} [${fmt(c.ci[0], c.metric)}, ${fmt(c.ci[1], c.metric)}] | ${c.wins}/${c.losses}/${c.ties} |`);
  }
  const ra = repeatAgreement(runs);
  lines.push('', 'Repeat agreement (share of tasks whose primary outcome is identical across repeats): ' + Object.entries(ra).map(([c, v]) => `${c} ${Number.isFinite(v) ? v.toFixed(2) : '—'}`).join(' · '));
  return lines.join('\n');
}
