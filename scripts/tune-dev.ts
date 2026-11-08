/**
 * Dev-split-only tuning (M4). Small, pre-declared grids; objective = mean Recall@10 + mean root-cause MRR.
 * Ties (within 0.005) are broken towards the configuration closest to the code defaults.
 * Writes evaluation/results/tuning-dev/tuning.json and the chosen configs to evaluation/configs/*.json.
 * The held-out test split is never loaded here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { abs, loadConfig } from '../src/config.js';
import { selectTasks } from '../src/cli/commands.js';
import { runPerTask, type NamedFactory } from '../src/evaluation/runner.js';
import { aggregate } from '../src/evaluation/report-generator.js';
import { HybridRetriever } from '../src/retrieval/hybrid-retrieval.js';
import { GraphRetriever } from '../src/retrieval/graph-retrieval.js';
import { customGraphConfig, hybridConfig } from '../src/evaluation/configs.js';

const cfg = loadConfig();
const tasks = selectTasks(cfg, 'dev');
if (tasks.some((t) => t.split !== 'dev')) throw new Error('tuning must only see dev tasks');

interface Cand { name: string; kind: 'hybrid' | 'custom_graph'; params: Record<string, number>; distance: number; make: () => any }
const cands: Cand[] = [];
const H0 = { wGraph: 0.6, wFact: 0.5, wSem: 1, depth: 2 };
for (const wGraph of [0.3, 0.6, 1.0]) for (const wFact of [0, 0.5]) for (const wSem of [0.5, 1]) for (const depth of [2, 3]) {
  const p = { wGraph, wFact, wSem, depth };
  const name = `h_g${wGraph}_f${wFact}_s${wSem}_d${depth}`;
  cands.push({ name, kind: 'hybrid', params: p, distance: Object.entries(p).filter(([k, v]) => (H0 as any)[k] !== v).length,
    make: () => new HybridRetriever(hybridConfig({ wGraph, wFact, wSem, graph: { depth } }), name) });
}
const C0 = { propagationWeight: 0.7, depth: 2, cfBonus: 0.3 };
for (const propagationWeight of [0.4, 0.7, 1.0]) for (const depth of [2, 3]) for (const cfBonus of [0, 0.3]) {
  const p = { propagationWeight, depth, cfBonus };
  const name = `c_p${propagationWeight}_d${depth}_cf${cfBonus}`;
  cands.push({ name, kind: 'custom_graph', params: p, distance: Object.entries(p).filter(([k, v]) => (C0 as any)[k] !== v).length,
    make: () => new GraphRetriever(customGraphConfig({ propagationWeight, graph: { depth, cfBonus } }), name) });
}
const runs = await runPerTask(cfg, tasks, cands.map((c): NamedFactory => ({ name: c.name, make: c.make })), cfg.budget, () => {});
const rows = runs.map((r) => {
  const a = aggregate(r.metrics);
  const c = cands.find((x) => x.name === r.method)!;
  return { name: c.name, kind: c.kind, params: c.params, distance: c.distance, r10: a.means.sym_recall_10, mrr: a.means.rc_mrr, rc5: a.means.rc_hit_5, objective: a.means.sym_recall_10 + a.means.rc_mrr };
});
const pick = (kind: string) => rows.filter((r) => r.kind === kind).sort((a, b) => (Math.abs(b.objective - a.objective) > 0.005 ? b.objective - a.objective : a.distance - b.distance))[0];
const bestH = pick('hybrid'), bestC = pick('custom_graph');
const out = path.join(abs(cfg.results_dir), 'tuning-dev');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'tuning.json'), JSON.stringify({ split: 'dev', n_tasks: tasks.length, objective: 'mean Recall@10 + mean RC MRR', rows, chosen: { hybrid: bestH, custom_graph: bestC } }, null, 2) + '\n');
fs.mkdirSync(abs('evaluation/configs'), { recursive: true });
fs.writeFileSync(abs('evaluation/configs/hybrid.json'), JSON.stringify({ wGraph: bestH.params.wGraph, wFact: bestH.params.wFact, wSem: bestH.params.wSem, graph: { depth: bestH.params.depth } }, null, 2) + '\n');
fs.writeFileSync(abs('evaluation/configs/custom_graph.json'), JSON.stringify({ propagationWeight: bestC.params.propagationWeight, graph: { depth: bestC.params.depth, cfBonus: bestC.params.cfBonus } }, null, 2) + '\n');
for (const r of rows.sort((a, b) => a.kind.localeCompare(b.kind) || b.objective - a.objective)) console.log(`${r.name.padEnd(28)} R@10=${r.r10.toFixed(3)} MRR=${r.mrr.toFixed(3)} RC@5=${r.rc5.toFixed(2)} obj=${r.objective.toFixed(3)}`);
console.log('chosen hybrid:', bestH.name, 'chosen custom_graph:', bestC.name);
