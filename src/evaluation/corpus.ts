/**
 * Benchmark snapshot construction and corpus loading.
 *
 * Snapshots = upstream commit (+ one task's bug patch), keeping only cfg.target.keep top-level paths,
 * committed with fixed author/date so every snapshot hash is reproducible.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Corpus } from '../types.js';
import { abs, listCorpusFiles, PROJECT_ROOT, type BenchmarkConfig } from '../config.js';

function git(cwd: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

const FIXED_GIT_ENV = {
  GIT_AUTHOR_NAME: 'benchmark', GIT_AUTHOR_EMAIL: 'benchmark@localhost', GIT_AUTHOR_DATE: '2026-11-08T00:00:00Z',
  GIT_COMMITTER_NAME: 'benchmark', GIT_COMMITTER_EMAIL: 'benchmark@localhost', GIT_COMMITTER_DATE: '2026-11-08T00:00:00Z',
};

function snapshotCommit(cfg: BenchmarkConfig, bench: string, branch: string, patch: string | null): string {
  git(bench, ['checkout', '-q', '-f', '-B', branch, cfg.target.upstream_commit]);
  git(bench, ['clean', '-q', '-fdx']);
  if (patch) git(bench, ['apply', '--whitespace=nowarn', patch]);
  // Equal source availability: keep only the corpus dirs + minimal project config.
  for (const ent of fs.readdirSync(bench)) {
    if (ent === '.git' || cfg.target.keep.includes(ent)) continue;
    fs.rmSync(path.join(bench, ent), { recursive: true, force: true });
  }
  git(bench, ['add', '-A']);
  git(bench, ['commit', '-q', '--allow-empty', '-m', patch ? `benchmark snapshot: ${path.basename(patch)}` : 'benchmark snapshot: pristine (no bug)'], FIXED_GIT_ENV);
  return git(bench, ['rev-parse', 'HEAD']);
}

function corpusHash(bench: string, files: string[]): string {
  return crypto.createHash('sha256').update(files.map((f) => f + '\0' + fs.readFileSync(path.join(bench, f), 'utf8')).join('\0')).digest('hex');
}

function typecheck(bench: string): { exit: number | null; out: string } {
  const tsc = spawnSync(abs('targets/node_modules/.bin/tsc'), ['--noEmit', '--incremental', 'false', '-p', 'tsconfig.json'], { cwd: bench, encoding: 'utf8' });
  return { exit: tsc.status, out: (tsc.stdout + tsc.stderr).slice(0, 2000) };
}

/**
 * Single-bug snapshots (audit recommendation G1, decision D-017): branch `base` = pristine upstream,
 * branch `task/<id>` = pristine + that task's patch only. All are materialised at the SAME path
 * (cfg.target.bench_dir) when evaluated, so no path words differ between tasks.
 */
export function setupTarget(cfg: BenchmarkConfig, opts: { noTypecheck?: boolean } = {}) {
  const bench = abs(cfg.target.bench_dir);
  if (!bench.startsWith(path.join(PROJECT_ROOT, 'targets') + path.sep)) throw new Error(`refusing to manage ${bench}`);
  const localUpstream = abs('targets/nestjs-boilerplate-upstream');
  const source = fs.existsSync(path.join(localUpstream, '.git')) ? localUpstream : cfg.target.upstream;
  fs.rmSync(bench, { recursive: true, force: true });
  git(PROJECT_ROOT, ['clone', '-q', '--no-checkout', source, bench]);
  const bugsDir = abs(cfg.dataset.bugs_dir);
  const patches = fs.existsSync(bugsDir) ? fs.readdirSync(bugsDir).filter((f) => f.endsWith('.patch')).sort() : [];
  const tasks: Record<string, { branch: string; commit: string; patch_sha256: string; corpus_sha256: string; tsc_exit: number | null }> = {};
  let failures = 0;
  for (const p of patches) {
    const id = p.replace(/\.patch$/, '');
    const full = path.join(bugsDir, p);
    const commit = snapshotCommit(cfg, bench, `task/${id}`, full);
    const files = listCorpusFiles(bench, cfg.target.include_dirs);
    const tc = opts.noTypecheck ? { exit: null, out: '' } : typecheck(bench);
    if (tc.exit !== null && tc.exit !== 0) { failures++; console.error(`tsc failed for ${id}:\n${tc.out}`); }
    tasks[id] = { branch: `task/${id}`, commit, patch_sha256: crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'), corpus_sha256: corpusHash(bench, files), tsc_exit: tc.exit };
  }
  const baseCommit = snapshotCommit(cfg, bench, 'base', null);
  const baseFiles = listCorpusFiles(bench, cfg.target.include_dirs);
  const manifest = {
    upstream: cfg.target.upstream, upstream_commit: cfg.target.upstream_commit,
    mode: 'single-bug snapshots (one branch per task, materialised at the same path)',
    base: { branch: 'base', commit: baseCommit, corpus_files: baseFiles.length, corpus_sha256: corpusHash(bench, baseFiles) },
    tasks,
  };
  fs.writeFileSync(abs('targets/bench.manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { ...manifest, typecheck_failures: failures };
}

/** Materialise one snapshot (task branch or 'base') at the bench path and return its corpus. */
export function checkoutSnapshot(cfg: BenchmarkConfig, taskId: string | 'base'): Corpus {
  const bench = abs(cfg.target.bench_dir);
  const branch = taskId === 'base' ? 'base' : `task/${taskId}`;
  git(bench, ['checkout', '-q', '-f', branch]);
  git(bench, ['clean', '-q', '-fdx']);
  return loadCorpus(cfg);
}

export function loadCorpus(cfg: BenchmarkConfig): Corpus {
  const repoRoot = abs(cfg.target.bench_dir);
  if (!fs.existsSync(repoRoot)) throw new Error(`benchmark snapshot missing: run \`npm run setup:target\``);
  const commit = git(repoRoot, ['rev-parse', 'HEAD']);
  const files = listCorpusFiles(repoRoot, cfg.target.include_dirs);
  const cacheDir = path.join(abs(cfg.cache_dir), commit.slice(0, 12));
  fs.mkdirSync(cacheDir, { recursive: true });
  return { repoRoot, commit, files, cacheDir };
}
