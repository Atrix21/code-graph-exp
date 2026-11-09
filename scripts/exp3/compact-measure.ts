#!/usr/bin/env tsx
/**
 * Experiment 3, non-billable prototype measurement: how many tokens does a compact pointer-style tool result
 * need, and how much ground truth does it still point to, compared with experiment 1's native snippet contexts?
 *
 * Inputs (frozen, unchanged): experiment 1 held-out runs evaluation/results/final-test/raw/<method>.jsonl (8k budget)
 * and the 14 test tasks. Relationships come from the base-snapshot graph (.cache/graph-base), which differs from
 * each single-bug snapshot only by the injected lines. Symbol matching is exact on "file::Qualified" keys
 * (experiment 1's official scorer normalises more; numbers here are indicative, not a replacement metric).
 *
 *   npx tsx scripts/exp3/compact-measure.ts [--out experiments/03-graph-scale/results/compact-prototype.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { abs, loadConfig } from '../../src/config.js';
import { loadTasks } from '../../src/evaluation/ground-truth.js';
import { countTokens } from '../../src/evaluation/token-accounting.js';
import { loadGraph } from '../../src/graph/graph-store.js';
import { CompactIndex, renderCompact, DEFAULT_COMPACT } from '../../src/retrieval/compact-context.js';

const outArg = process.argv.indexOf('--out');
const OUT = abs(outArg >= 0 ? process.argv[outArg + 1] : 'experiments/03-graph-scale/results/compact-prototype.json');
const cfg = loadConfig();
const tasks = loadTasks(abs(cfg.dataset.tasks_dir)).filter((t) => t.split === 'test');
const g = loadGraph(abs('.cache/graph-base/graph.sqlite'));
const idx = new CompactIndex(g.nodes, g.edges);
const METHODS = ['hybrid', 'custom_graph', 'embeddings', 'bm25'];
const VARIANTS = [
  { name: 'compact-800', opt: { ...DEFAULT_COMPACT, maxTokens: 800 } },
  { name: 'compact-800-norel', opt: { ...DEFAULT_COMPACT, maxTokens: 800, relations: false } },
  // Iso-token control: no relationship lines but up to 25 symbols, so it can spend the same ~800 tokens on more pointers.
  { name: 'compact-800-norel-25', opt: { ...DEFAULT_COMPACT, maxTokens: 800, relations: false, maxSymbols: 25 } },
  { name: 'compact-400', opt: { ...DEFAULT_COMPACT, maxTokens: 400 } },
  { name: 'compact-400-norel-25', opt: { ...DEFAULT_COMPACT, maxTokens: 400, relations: false, maxSymbols: 25 } },
];
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const recall = (gt: string[], got: Set<string>) => (gt.length ? gt.filter((k) => got.has(k)).length / gt.length : NaN);

const rows: Record<string, unknown>[] = [];
const examples: Record<string, string> = {};
for (const m of METHODS) {
  const raw = new Map<string, any>();
  for (const l of fs.readFileSync(abs(`evaluation/results/final-test/raw/${m}.jsonl`), 'utf8').split('\n').filter(Boolean)) {
    const o = JSON.parse(l); raw.set(o.task_id, o);
  }
  for (const t of tasks) {
    const o = raw.get(t.task_id);
    if (!o) continue;
    const res: any[] = o.results;
    const keys10 = new Set(res.slice(0, 10).filter((r) => r.symbol).map((r) => `${r.file}::${r.symbol}`));
    const nativeShown = new Set(res.filter((r) => r.symbol && o.context.includes(`${r.file}:${r.start_line}`)).map((r) => `${r.file}::${r.symbol}`));
    rows.push({ method: m, variant: 'native-8k', task_id: t.task_id, tokens: countTokens(o.context), listed: nativeShown.size,
      recall_listed: recall(t.relevant_symbols, nativeShown), rc_listed: recall(t.root_cause_symbols, nativeShown),
      recall_pointed: recall(t.relevant_symbols, nativeShown), rc_pointed: recall(t.root_cause_symbols, nativeShown), recall_at10: recall(t.relevant_symbols, keys10) });
    for (const v of VARIANTS) {
      const c = renderCompact(idx, t.description, res, v.opt);
      const listed = new Set(c.listed);
      const pointed = new Set([...c.listed, ...c.mentioned]);
      rows.push({ method: m, variant: v.name, task_id: t.task_id, tokens: c.tokens, listed: listed.size,
        recall_listed: recall(t.relevant_symbols, listed), rc_listed: recall(t.root_cause_symbols, listed),
        recall_pointed: recall(t.relevant_symbols, pointed), rc_pointed: recall(t.root_cause_symbols, pointed), recall_at10: recall(t.relevant_symbols, keys10) });
      if (m === 'hybrid' && v.name === 'compact-800' && !examples.hybrid) examples.hybrid = `${t.task_id}\n${c.text}`;
    }
  }
}
const summary: Record<string, unknown>[] = [];
for (const m of METHODS) for (const v of ['native-8k', ...VARIANTS.map((x) => x.name)]) {
  const r = rows.filter((x) => x.method === m && x.variant === v) as any[];
  summary.push({ method: m, variant: v, n: r.length, tokens: Math.round(mean(r.map((x) => x.tokens))), listed: +mean(r.map((x) => x.listed)).toFixed(1),
    recall_listed: +mean(r.map((x) => x.recall_listed)).toFixed(3), recall_pointed: +mean(r.map((x) => x.recall_pointed)).toFixed(3),
    rc_listed: +mean(r.map((x) => x.rc_listed)).toFixed(3), rc_pointed: +mean(r.map((x) => x.rc_pointed)).toFixed(3) });
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ generated_by: 'scripts/exp3/compact-measure.ts', graph: '.cache/graph-base', source_runs: 'evaluation/results/final-test (8k)', summary, rows, examples }, null, 2) + '\n');
console.table(summary);
console.log(examples.hybrid);
console.log('wrote', OUT);
