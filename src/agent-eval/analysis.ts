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
