/**
 * Per-run markdown report from evaluation/results/<run>/metrics.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { TaskMetrics } from './metrics.js';
import { accuracyTable, aggregate, pairedTable, perTaskTable, tokenTable } from './report-generator.js';

export function generateReport(dir: string): string {
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'metrics.json'), 'utf8'));
  const per: TaskMetrics[] = m.per_task;
  const byMethod = new Map<string, TaskMetrics[]>();
  for (const r of per) {
    if (!byMethod.has(r.method)) byMethod.set(r.method, []);
    byMethod.get(r.method)!.push(r);
  }
  const aggs = [...byMethod.values()].map((rows) => aggregate(rows));
  const idx = Object.entries(m.index as Record<string, any>).map(([k, v]) =>
    `| ${k} | ${Math.round(v.index_ms).toLocaleString('en-US')} | ${v.index_llm_tokens ?? 'unavailable'} | ${v.embedding_tokens ?? '—'} | ${v.details?.nodes ?? v.details?.chunks ?? '—'} | ${v.details?.edges ?? '—'} |`);
  const ref = byMethod.has('hybrid') ? 'hybrid' : byMethod.has('custom_graph') ? 'custom_graph' : [...byMethod.keys()][0];
  return [
    `# Run ${m.meta.run_id}`,
    '',
    `split=${m.meta.split} · tasks=${m.meta.n_tasks} · files=${m.meta.n_files} · commit=${m.meta.commit} · budget=${JSON.stringify(m.meta.budget)} · dataset=${m.meta.dataset_version}`,
    `tokenizer: ${m.meta.tokenizer}`,
    '',
    '## Accuracy (symbol level unless noted; mean [95% bootstrap CI])',
    '',
    accuracyTable(aggs),
    '',
    '## Token efficiency',
    '',
    tokenTable(aggs),
    '',
    '## Indexing (one-time)',
    '',
    '| Method | Index/build ms | Index LLM tokens | Embedding tokens | Nodes/chunks | Edges |',
    '|---|---:|---:|---:|---:|---:|',
    ...idx,
    '',
    `## Paired differences vs ${ref} (Recall@10)`,
    '',
    pairedTable(byMethod, ref, 'sym_recall_10'),
    '',
    `## Paired differences vs ${ref} (root-cause MRR)`,
    '',
    pairedTable(byMethod, ref, 'rc_mrr'),
    '',
    '## Per-task root-cause rank (— = not in returned results)',
    '',
    perTaskTable(byMethod, 'rc_rank'),
    '',
    '## Per-task Recall@10',
    '',
    perTaskTable(byMethod, 'sym_recall_10'),
    '',
  ].join('\n');
}
