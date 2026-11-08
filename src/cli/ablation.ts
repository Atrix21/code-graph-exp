/**
 * Ablations: hybrid (and custom_graph) variants derived from the FROZEN config, evaluated on one split.
 *   npm run benchmark:ablation -- --split test [--run ablation-test] [--only a,b]
 * Budget variants change only the shared budget object; everything else is identical.
 */
import fs from 'node:fs';
import path from 'node:path';
import { abs, type BenchmarkConfig } from '../config.js';
import { customGraphConfig, hybridConfig, type DeepPartial } from '../evaluation/configs.js';
import { runPerTask, writeRun, type NamedFactory } from '../evaluation/runner.js';
import { generateReport } from '../evaluation/report.js';
import { HybridRetriever, type HybridConfig } from '../retrieval/hybrid-retrieval.js';
import { GraphRetriever, type CustomGraphConfig } from '../retrieval/graph-retrieval.js';
import { DEFAULT_EDGE_WEIGHTS } from '../retrieval/graph-engine.js';
import type { RetrievalBudget, RetrievalMethod } from '../types.js';
import { selectTasks } from './commands.js';

function arg(name: string, def?: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

interface Variant { name: string; make: () => RetrievalMethod; budget?: Partial<RetrievalBudget>; group: string }

const uniformWeights = Object.fromEntries(Object.keys(DEFAULT_EDGE_WEIGHTS).map((k) => [k, { fwd: 0.5, back: 0.5 }]));

export function variants(): Variant[] {
  const h = (name: string, group: string, over: DeepPartial<HybridConfig>, budget?: Partial<RetrievalBudget>): Variant => ({
    name, group, budget, make: () => new HybridRetriever(hybridConfig(over), name),
  });
  const g = (name: string, group: string, over: DeepPartial<CustomGraphConfig>): Variant => ({
    name, group, make: () => new GraphRetriever(customGraphConfig(over), name),
  });
  const base = hybridConfig();
  return [
    // mandatory ablations
    h('hybrid_all', 'core', {}),
    h('no_graph_traversal', 'core', { wGraph: 0 }),
    h('no_control_flow', 'core', { graph: { disableControlFlow: true } }),
    h('no_data_flow', 'core', { graph: { disabledFamilies: [...base.graph.disabledFamilies, 'data_flow'] } }),
    h('no_structural', 'core', { graph: { disabledFamilies: [...base.graph.disabledFamilies, 'structural'] } }),
    h('no_semantic', 'core', { wSem: 0 }),
    h('no_lexical', 'core', { wLex: 0, wSym: 0, wFact: 0 }),
    h('no_confidence', 'core', { graph: { useConfidence: false } }),
    // extra component ablations
    h('no_application_edges', 'extra', { graph: { disabledFamilies: [...base.graph.disabledFamilies, 'application'] } }),
    h('no_graph_at_all', 'extra', { wGraph: 0, wFact: 0 }),
    h('no_graph_facts', 'extra', { wFact: 0 }),
    h('uniform_edge_weights', 'extra', { graph: { edgeWeights: uniformWeights } }),
    h('no_priors', 'extra', { graph: { priors: { enabled: false } } }),
    h('no_cf_bonus', 'extra', { graph: { cfBonus: 0 } }),
    h('no_hub_damping', 'extra', { graph: { hubPenalty: 0 } }),
    // post-freeze, analysis-only: remove framework-inferred edges (DI dispatch abstract->concrete, NestJS/TypeORM roles, config keys)
    h('no_framework_inferred_edges', 'post-freeze', { graph: { excludeVerification: ['framework_inferred'] } }),
    g('custom_graph_no_framework_inferred_edges', 'post-freeze', { graph: { excludeVerification: ['framework_inferred'] } }),
    // traversal depth
    h('depth_1', 'depth', { graph: { depth: 1 } }),
    h('depth_2', 'depth', { graph: { depth: 2 } }),
    h('depth_3', 'depth', { graph: { depth: 3 } }),
    // seeds
    h('seeds_4', 'seeds', { graph: { seeds: 4 } }),
    h('seeds_16', 'seeds', { graph: { seeds: 16 } }),
    // snippets
    h('snippets_all_full', 'snippets', { snippets: { fullTop: 1000 } }),
    h('snippets_all_skeleton', 'snippets', { snippets: { fullTop: 0 } }),
    h('max_results_10', 'snippets', {}, { maxResults: 10 }),
    // token budget
    h('budget_2000', 'budget', {}, { maxContextTokens: 2000 }),
    h('budget_4000', 'budget', {}, { maxContextTokens: 4000 }),
    h('budget_16000', 'budget', {}, { maxContextTokens: 16000 }),
    // custom graph alone
    g('custom_graph', 'custom_graph', {}),
    g('custom_graph_depth_1', 'custom_graph', { graph: { depth: 1 } }),
    g('custom_graph_depth_3', 'custom_graph', { graph: { depth: 3 } }),
    g('custom_graph_no_traversal', 'custom_graph', { propagationWeight: 0 }),
    g('custom_graph_no_control_flow', 'custom_graph', { graph: { disableControlFlow: true } }),
    g('custom_graph_no_data_flow', 'custom_graph', { graph: { disabledFamilies: ['data_flow'] } }),
  ];
}

export async function ablationCommand(cfg: BenchmarkConfig) {
  const split = arg('split', 'test')!;
  const runId = arg('run', `ablation-${split}`)!;
  const only = arg('only')?.split(',');
  const tasks = selectTasks(cfg, split);
  const vs = variants().filter((v) => !only || only.includes(v.name));
  // Single-bug snapshots (D-017): every variant indexes each task's own snapshot (bug fix D-023: this
  // command previously evaluated against whatever snapshot was checked out, i.e. the pristine base).
  const runs = await runPerTask(cfg, tasks, vs.map((v): NamedFactory => ({ name: v.name, make: v.make, budget: { ...cfg.budget, ...v.budget } })), cfg.budget);
  const groups = Object.fromEntries(vs.map((v) => [v.name, v.group]));
  const manifest = JSON.parse(fs.readFileSync(abs('targets/bench.manifest.json'), 'utf8'));
  const dir = path.join(abs(cfg.results_dir), runId);
  writeRun(dir, runs, {
    run_id: runId, split, methods: runs.map((r) => r.method), groups, budget: cfg.budget,
    commit: `per-task snapshots (base ${manifest.base.commit})`, n_tasks: tasks.length, n_files: manifest.base.corpus_files,
    dataset_version: cfg.dataset.version, created: new Date().toISOString(),
  });
  fs.writeFileSync(path.join(dir, 'report.md'), generateReport(dir));
  console.log(fs.readFileSync(path.join(dir, 'report.md'), 'utf8'));
}
