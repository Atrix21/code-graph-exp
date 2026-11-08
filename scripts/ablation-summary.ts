/** Ablation deltas vs hybrid_all (paired bootstrap), written to evaluation/results/ablation-test/ablation-summary.{json,md}. */
import fs from 'node:fs';
import { pairedBootstrap, mean } from '../src/evaluation/metrics.js';
const run = process.argv[2] ?? 'ablation-test';
const m = JSON.parse(fs.readFileSync(`evaluation/results/${run}/metrics.json`, 'utf8'));
const groups = m.meta.groups as Record<string, string>;
const by = new Map<string, any[]>();
for (const r of m.per_task) { if (!by.has(r.method)) by.set(r.method, []); by.get(r.method)!.push(r); }
const refName = process.argv[3] ?? 'hybrid_all';
const ref = new Map(by.get(refName)!.map((r) => [r.task_id, r]));
const ttr = (r: any) => Math.min(16000, r.tokens_to_root_cause ?? 16000);
const rows = [...by.entries()].map(([name, rs]) => {
  const d = (f: (r: any) => number) => pairedBootstrap(rs.map(f), rs.map((r) => f(ref.get(r.task_id))));
  const r10 = d((r) => r.sym_recall_10), mrr = d((r) => r.rc_mrr), t = d(ttr);
  return { variant: name, group: groups[name], r10: mean(rs.map((r) => r.sym_recall_10)), d_r10: r10.mean_diff, ci_r10: r10.ci, mrr: mean(rs.map((r) => r.rc_mrr)), d_mrr: mrr.mean_diff, ci_mrr: mrr.ci,
    rc5: mean(rs.map((r) => r.rc_hit_5)), ttr: mean(rs.map(ttr)), d_ttr: t.mean_diff, ci_ttr: t.ci, native: mean(rs.map((r) => r.native_context_tokens)) };
});
fs.writeFileSync(`evaluation/results/${run}/ablation-summary${refName === 'hybrid_all' ? '' : '-vs-' + refName}.json`, JSON.stringify(rows, null, 2) + '\n');
const f = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(2);
const md = ['| Variant | Group | Recall@10 | Δ vs all [95% CI] | RC MRR | Δ vs all [95% CI] | RC Acc@5 | Tokens-to-RC (cap 16k) | Native tokens |', '|---|---|---:|---:|---:|---:|---:|---:|---:|',
  ...rows.map((r) => `| ${r.variant} | ${r.group} | ${r.r10.toFixed(2)} | ${f(r.d_r10)} [${f(r.ci_r10[0])}, ${f(r.ci_r10[1])}] | ${r.mrr.toFixed(2)} | ${f(r.d_mrr)} [${f(r.ci_mrr[0])}, ${f(r.ci_mrr[1])}] | ${r.rc5.toFixed(2)} | ${Math.round(r.ttr)} | ${Math.round(r.native)} |`)].join('\n');
fs.writeFileSync(`evaluation/results/${run}/ablation-summary${refName === 'hybrid_all' ? '' : '-vs-' + refName}.md`, md + '\n');
console.log(md);
