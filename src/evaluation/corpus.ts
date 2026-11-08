/**
 * Benchmark snapshot construction and corpus loading.
 *
 * Snapshot = upstream commit + every bug patch in evaluation/dataset/bugs (sorted), keeping only
 * cfg.target.keep top-level paths, committed with fixed author/date so the benchmark commit hash is reproducible.
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

export function setupTarget(cfg: BenchmarkConfig, opts: { noPatches?: boolean } = {}) {
  const bench = abs(cfg.target.bench_dir);
  if (!bench.startsWith(path.join(PROJECT_ROOT, 'targets') + path.sep)) throw new Error(`refusing to manage ${bench}`);
  const localUpstream = abs('targets/nestjs-boilerplate-upstream');
  const source = fs.existsSync(path.join(localUpstream, '.git')) ? localUpstream : cfg.target.upstream;
  fs.rmSync(bench, { recursive: true, force: true });
  git(PROJECT_ROOT, ['clone', '-q', '--no-checkout', source, bench]);
  git(bench, ['checkout', '-q', '-B', 'benchmark', cfg.target.upstream_commit]);
  const bugsDir = abs(cfg.dataset.bugs_dir);
  const patches = opts.noPatches || !fs.existsSync(bugsDir) ? [] : fs.readdirSync(bugsDir).filter((f) => f.endsWith('.patch')).sort();
  const patchHashes: Record<string, string> = {};
  for (const p of patches) {
    const full = path.join(bugsDir, p);
    patchHashes[p] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    git(bench, ['apply', '--whitespace=nowarn', full]);
  }
  // Equal source availability: keep only the corpus dirs + minimal project config, remove docs, scripts, CI, etc.
  for (const ent of fs.readdirSync(bench)) {
    if (ent === '.git' || cfg.target.keep.includes(ent)) continue;
    fs.rmSync(path.join(bench, ent), { recursive: true, force: true });
  }
  git(bench, ['add', '-A']);
  git(bench, ['commit', '-q', '--allow-empty', '-m', `benchmark snapshot: ${patches.length} bug patches, pruned non-code paths`], FIXED_GIT_ENV);
  const commit = git(bench, ['rev-parse', 'HEAD']);
  const files = listCorpusFiles(bench, cfg.target.include_dirs);
  const manifest = {
    upstream: cfg.target.upstream, upstream_commit: cfg.target.upstream_commit, bench_commit: commit,
    patches: patchHashes, corpus_files: files.length,
    corpus_sha256: crypto.createHash('sha256').update(files.map((f) => f + '\0' + fs.readFileSync(path.join(bench, f), 'utf8')).join('\0')).digest('hex'),
  };
  fs.writeFileSync(abs('targets/bench.manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  // Type-check the snapshot (bugs must not break compilation).
  const tsc = spawnSync(abs('targets/node_modules/.bin/tsc'), ['--noEmit', '--incremental', 'false', '-p', 'tsconfig.json'], { cwd: bench, encoding: 'utf8' });
  return { ...manifest, tsc_exit: tsc.status, tsc_output: (tsc.stdout + tsc.stderr).slice(0, 2000) };
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
