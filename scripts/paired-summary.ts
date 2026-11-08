/** Paired comparisons used in research/findings.md (held-out test split). */
import fs from 'node:fs';
import { pairedBootstrap, mean } from '../src/evaluation/metrics.js';
const load = (run: string) => {
  const m = JSON.parse(fs.readFileSync(`evaluation/results/${run}/metrics.json`, 'utf8'));
  const by = new Map<string, Map<string, any>>();
  for (const r of m.per_task) { if (!by.has(r.method)) by.set(r.method, new Map()); by.get(r.method)!.set(r.task_id, r); }
  return by;
};
const b8 = load('final-test'), b2 = load('final-test-budget2000');
const cmp = (label: string, A: Map<string, any>, B: Map<string, any>, metric: string) => {
  const ids = [...A.keys()].sort();
  const a = ids.map((i) => metric === 'ttr' ? -Math.min(16000, A.get(i).tokens_to_root_cause ?? 16000) : A.get(i)[metric]);
  const b = ids.map((i) => metric === 'ttr' ? -Math.min(16000, B.get(i).tokens_to_root_cause ?? 16000) : B.get(i)[metric]);
  const p = pairedBootstrap(a, b);
  const wins = a.filter((x, k) => x > b[k]).length, losses = a.filter((x, k) => x < b[k]).length;
  return { comparison: label, metric, mean_a: metric === 'ttr' ? -mean(a) : mean(a), mean_b: metric === 'ttr' ? -mean(b) : mean(b), diff: metric === 'ttr' ? -p.mean_diff : p.mean_diff, ci: metric === 'ttr' ? [-p.ci[1], -p.ci[0]] : p.ci, p_le_0: p.p_le_0, wins, losses, ties: ids.length - wins - losses };
};
const out = [] as any[];
for (const metric of ['sym_recall_10', 'rc_mrr', 'rc_hit_5', 'sym_precision_10', 'ttr']) {
  out.push(cmp('hybrid vs embeddings (8k)', b8.get('hybrid')!, b8.get('embeddings')!, metric));
  out.push(cmp('custom_graph vs embeddings (8k)', b8.get('custom_graph')!, b8.get('embeddings')!, metric));
  out.push(cmp('hybrid vs custom_graph (8k)', b8.get('hybrid')!, b8.get('custom_graph')!, metric));
  out.push(cmp('hybrid@2k vs embeddings@8k', b2.get('hybrid')!, b8.get('embeddings')!, metric));
  out.push(cmp('hybrid@2k vs embeddings@2k', b2.get('hybrid')!, b2.get('embeddings')!, metric));
  out.push(cmp('custom_graph vs graphify (8k)', b8.get('custom_graph')!, b8.get('graphify')!, metric));
  out.push(cmp('custom_graph vs code_review_graph (8k)', b8.get('custom_graph')!, b8.get('code_review_graph')!, metric));
}
fs.writeFileSync('evaluation/results/final-test/paired-summary.json', JSON.stringify(out, null, 2) + '\n');
for (const r of out) console.log(`${r.comparison.padEnd(40)} ${r.metric.padEnd(16)} ${r.mean_a.toFixed(2).padStart(8)} vs ${r.mean_b.toFixed(2).padStart(8)}  Δ=${r.diff.toFixed(2).padStart(7)} [${r.ci[0].toFixed(2)}, ${r.ci[1].toFixed(2)}]  W/L/T ${r.wins}/${r.losses}/${r.ties}`);
