/**
 * Ground-truth loading and validation. Validation checks every symbol key against the
 * canonical (purely syntactic) symbol index of the benchmark revision.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { GroundTruthTask } from '../types.js';
import { SymbolIndex } from './symbol-index.js';

export interface ValidationIssue { task_id: string; level: 'error' | 'warn'; msg: string }

export function loadTasks(dir: string): GroundTruthTask[] {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  return files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as GroundTruthTask);
}

export function validateTasks(tasks: GroundTruthTask[], index: SymbolIndex): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const ids = new Set<string>();
  for (const t of tasks) {
    const e = (msg: string) => issues.push({ task_id: t.task_id, level: 'error', msg });
    const w = (msg: string) => issues.push({ task_id: t.task_id, level: 'warn', msg });
    if (!t.task_id) e('missing task_id');
    if (ids.has(t.task_id)) e('duplicate task_id');
    ids.add(t.task_id);
    if (!t.description || t.description.length < 30) e('description missing/too short');
    if (!t.root_cause_symbols?.length) e('no root_cause_symbols');
    if (!t.relevant_symbols?.length) e('no relevant_symbols');
    for (const k of [...(t.root_cause_symbols ?? []), ...(t.relevant_symbols ?? []), ...(t.distractor_symbols ?? [])]) {
      if (!index.byKey.has(k)) e(`unknown symbol key: ${k}`);
    }
    for (const k of t.root_cause_symbols ?? []) if (!t.relevant_symbols?.includes(k)) e(`root cause ${k} not in relevant_symbols`);
    for (const k of t.distractor_symbols ?? []) if (t.relevant_symbols?.includes(k)) e(`distractor ${k} also relevant`);
    const symFiles = new Set((t.relevant_symbols ?? []).map((k) => k.split('::')[0]));
    for (const f of symFiles) if (!t.relevant_files?.includes(f)) e(`file of relevant symbol not in relevant_files: ${f}`);
    for (const f of t.relevant_files ?? []) if (!index.byFile.has(f)) e(`unknown file: ${f}`);
    for (const f of t.relevant_files ?? []) if (!symFiles.has(f)) w(`relevant file without relevant symbol: ${f}`);
    // Leakage check: identifiers of root-cause symbols should not appear verbatim in the report.
    for (const k of t.root_cause_symbols ?? []) {
      const name = k.split('::')[1];
      for (const part of name.split('.')) {
        if (part.length > 3 && part !== 'constructor' && new RegExp(`\\b${part.replace(/[$]/g, '\\$')}\\b`).test(t.description)) {
          w(`description contains root-cause identifier '${part}'`);
        }
      }
    }
  }
  return issues;
}
