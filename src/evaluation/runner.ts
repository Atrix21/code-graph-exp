/**
 * Benchmark runner: identical tasks, corpus, commit and budget for every method.
 * Methods receive only {task_id, query}. Raw outputs, index stats and per-task metrics
 * are written to evaluation/results/<run_id>/.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Corpus, GroundTruthTask, IndexStats, RetrievalBudget, RetrievalMethod, RetrievalOutput, RetrievalQuery } from '../types.js';
import { SymbolIndex } from './symbol-index.js';
import { normaliseOutput } from './normalise.js';
import { computeTaskMetrics, type TaskMetrics } from './metrics.js';
import { countTokens, TOKENIZER_ID } from './token-accounting.js';
import { validateTasks } from './ground-truth.js';
import { checkoutSnapshot } from './corpus.js';
import { buildChunks } from '../retrieval/chunker.js';
import { Embedder, type EmbedItem } from '../retrieval/embeddings.js';
import type { BenchmarkConfig } from '../config.js';

export interface MethodRun {
  method: string;
  index: IndexStats;
  outputs: RetrievalOutput[];
  metrics: TaskMetrics[];
}

export function toQueries(tasks: GroundTruthTask[]): RetrievalQuery[] {
  // Only the id and the bug report cross this boundary.
  return tasks.map((t) => ({ task_id: t.task_id, query: t.description }));
}

export async function runMethod(method: RetrievalMethod, corpus: Corpus, queries: RetrievalQuery[], budget: RetrievalBudget, log = console.error): Promise<{ index: IndexStats; outputs: RetrievalOutput[] }> {
  log(`[${method.name}] preparing...`);
  const index = await method.prepare(corpus);
  log(`[${method.name}] indexed in ${index.index_ms.toFixed(0)} ms; querying ${queries.length} tasks`);
  let outputs: RetrievalOutput[];
  if (method.retrieveBatch) outputs = await method.retrieveBatch(queries, budget);
  else {
    outputs = [];
    for (const q of queries) outputs.push(await method.retrieve(q, budget));
  }
  await method.close?.();
  return { index, outputs };
}

export interface NamedFactory { name: string; make: () => Promise<RetrievalMethod> | RetrievalMethod; budget?: RetrievalBudget }

/**
 * Single-bug-snapshot evaluation (D-017): for each task, materialise its snapshot, then let every method
 * index that snapshot and answer that task's query. All methods see the identical revision per task.
 * Returns per-method runs with metrics computed against each task's own snapshot.
 */
export async function runPerTask(
  cfg: BenchmarkConfig, tasks: GroundTruthTask[], methods: NamedFactory[], budget: RetrievalBudget, log: (s: string) => void = console.error,
): Promise<MethodRun[]> {
  // Anything that is not a purely lexical/graph/competitor method may use embeddings (hybrid + its variants).
  if (methods.some((m) => !/^(ripgrep|bm25|graphify|code_review_graph|custom_graph)/.test(m.name))) await precomputeEmbeddings(cfg, tasks);
  const runs = new Map<string, MethodRun & { indexAll: IndexStats[] }>();
  for (const m of methods) runs.set(m.name, { method: m.name, index: null as unknown as IndexStats, indexAll: [], outputs: [], metrics: [] });
  for (const t of tasks) {
    const corpus = checkoutSnapshot(cfg, t.task_id);
    const index = new SymbolIndex(corpus.repoRoot, corpus.files);
    const bad = validateTasks([t], index).filter((i) => i.level === 'error');
    if (bad.length) throw new Error(`ground truth invalid on snapshot of ${t.task_id}: ${bad.map((b) => b.msg).join('; ')}`);
    const [q] = toQueries([t]);
    for (const f of methods) {
      const m = await f.make();
      const st = await m.prepare(corpus);
      const b = f.budget ?? budget;
      const out = m.retrieveBatch ? (await m.retrieveBatch([q], b))[0] : await m.retrieve(q, b);
      await m.close?.();
      const r = runs.get(f.name)!;
      r.indexAll.push(st);
      r.outputs.push({ ...out, metadata: { ...out.metadata, snapshot_commit: corpus.commit } });
      r.metrics.push(...evaluateOutputs(index, [t], [out]));
    }
    log(`[task] ${t.task_id} done (${methods.length} methods)`);
  }
  return [...runs.values()].map((r) => {
    const ms = r.indexAll.map((x) => x.index_ms).sort((a, b) => a - b);
    const first = r.indexAll[0];
    const index: IndexStats = {
      ...first, index_ms: ms[Math.floor(ms.length / 2)],
      details: { ...first?.details, index_ms_per_snapshot: ms.map((x) => Math.round(x)), note: 'index_ms = median over per-task snapshots' },
    };
    return { method: r.method, index, outputs: r.outputs, metrics: r.metrics };
  });
}

/** Embed every chunk of every task snapshot plus every query in ONE model invocation (content-hash cache). */
export async function precomputeEmbeddings(cfg: BenchmarkConfig, tasks: GroundTruthTask[]) {
  const items = new Map<string, EmbedItem>();
  let embedder: Embedder | null = null;
  for (const t of tasks) {
    const corpus = checkoutSnapshot(cfg, t.task_id);
    embedder ??= new Embedder(path.join(path.dirname(corpus.cacheDir), 'embeddings'));
    const chunks = buildChunks(new SymbolIndex(corpus.repoRoot, corpus.files));
    for (const c of chunks) items.set(`d\0${c.text}`, { id: `d${items.size}`, text: c.text, kind: 'doc' });
    items.set(`q\0${t.description}`, { id: `q${items.size}`, text: t.description, kind: 'query' });
  }
  if (embedder) embedder.embed([...items.values()]);
}

export function evaluateOutputs(index: SymbolIndex, tasks: GroundTruthTask[], outputs: RetrievalOutput[]): TaskMetrics[] {
  const byId = new Map(outputs.map((o) => [o.task_id, o]));
  return tasks.map((t) => {
    const o = byId.get(t.task_id);
    if (!o) throw new Error(`missing output for ${t.task_id}`);
    const norm = normaliseOutput(index, o);
    const llm = o.llm_tokens == null ? null : o.llm_tokens.input + o.llm_tokens.output;
    return computeTaskMetrics(index, t, norm, { native_context_tokens: countTokens(o.context), latency_ms: o.latency_ms, llm_tokens: llm, n_results: o.results.length });
  });
}

export function writeRun(dir: string, runs: MethodRun[], meta: Record<string, unknown>) {
  // Guard (D-023): every benchmark output must come from runPerTask on its task's own snapshot.
  const untagged = runs.flatMap((r) => r.outputs).filter((o) => !o.metadata?.snapshot_commit);
  if (untagged.length) throw new Error(`${untagged.length} outputs are not tagged with a per-task snapshot commit; use runPerTask`);
  fs.mkdirSync(path.join(dir, 'raw'), { recursive: true });
  for (const r of runs) {
    fs.writeFileSync(path.join(dir, 'raw', `${r.method}.jsonl`), r.outputs.map((o) => JSON.stringify(o)).join('\n') + '\n');
  }
  const out = {
    meta: { ...meta, tokenizer: TOKENIZER_ID },
    index: Object.fromEntries(runs.map((r) => [r.method, r.index])),
    per_task: runs.flatMap((r) => r.metrics),
  };
  fs.writeFileSync(path.join(dir, 'metrics.json'), JSON.stringify(out, null, 2) + '\n');
}
