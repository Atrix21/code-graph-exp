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
