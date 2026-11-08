import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface BenchmarkConfig {
  target: {
    name: string;
    upstream: string;
    upstream_commit: string;
    bench_dir: string; // relative to PROJECT_ROOT
    include_dirs: string[]; // corpus = *.ts under these dirs
    keep: string[]; // top-level paths kept in the benchmark snapshot (everything else is removed)
  };
  dataset: { tasks_dir: string; bugs_dir: string; version: string; split_seed: number };
  budget: { maxResults: number; maxContextTokens: number };
  embeddings: { model: string; revision: string; python: string; script: string; batch: number; max_seq: number };
  results_dir: string;
  cache_dir: string;
  seed: number;
}

export function loadConfig(p = path.join(PROJECT_ROOT, 'benchmark.config.json')): BenchmarkConfig {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export function abs(p: string): string {
  return path.isAbsolute(p) ? p : path.join(PROJECT_ROOT, p);
}

/** Deterministic corpus listing: every *.ts file (not .d.ts) under include dirs, sorted. */
export function listCorpusFiles(repoRoot: string, includeDirs: string[]): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const absDir = path.join(repoRoot, rel);
    if (!fs.existsSync(absDir)) return;
    for (const ent of fs.readdirSync(absDir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(r);
      else if (ent.isFile() && ent.name.endsWith('.ts') && !ent.name.endsWith('.d.ts')) out.push(r);
    }
  };
  for (const d of includeDirs) walk(d);
  return out.sort();
}
