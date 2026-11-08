/**
 * Isolated agent workspaces.
 *
 * Leakage threats addressed:
 *  - git history: targets/bench holds the pristine `base` branch and every other task branch, so an agent with git
 *    access could diff the bug out. Workspaces are a `git archive` export of ONE snapshot, re-initialised as a fresh
 *    single-commit repo (Code Review Graph requires .git) with neutral metadata.
 *  - path leakage: the model sees its cwd, and CRG returns absolute paths. Paths are /tmp/work/<opaque>/app. The
 *    opaque id is an HMAC of the task id, so it is stable but reveals nothing about the task or the experiment.
 *  - ground truth: the dataset lives in the project dir, outside every workspace. File tools are confined to the cwd.
 *  - type information: our graph builder needs the target's node_modules. /tmp/work/node_modules is a symlink, ABOVE the
 *    agent's cwd, so TS module resolution finds it but the agent's file tools cannot reach it.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { abs, listCorpusFiles, type BenchmarkConfig } from '../config.js';
import type { Corpus } from '../types.js';

export const WORK_ROOT = '/tmp/work';
const SALT = 'agent-eval-v1'; // fixed so workspace paths are reproducible
const NEUTRAL_GIT_ENV = {
  GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'dev@localhost', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'dev@localhost', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};

function sh(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; input?: Buffer } = {}): Buffer {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, input: opts.input, maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr?.toString()}`);
  return r.stdout;
}

export function opaqueId(taskId: string, runTag = ''): string {
  return crypto.createHmac('sha256', SALT).update(`${taskId}\0${runTag}`).digest('hex').slice(0, 10);
}

export interface Workspace { taskId: string; dir: string; hash: string; files: string[]; corpus: Corpus }

/** Content hash over the corpus files (proves which snapshot an agent saw). */
export function workspaceHash(dir: string, files: string[]): string {
  const h = crypto.createHash('sha256');
  for (const f of files) h.update(f + '\0').update(fs.readFileSync(path.join(dir, f))).update('\0');
  return h.digest('hex');
}

/**
 * Materialise the single-bug snapshot of `taskId` at /tmp/work/<opaque>/app (idempotent: rebuilt from scratch).
 * `runTag` gives parallel runs of the same task separate directories (different opaque ids).
 */
export function buildWorkspace(cfg: BenchmarkConfig, taskId: string, runTag = ''): Workspace {
  const bench = abs(cfg.target.bench_dir);
  const branch = taskId === 'base' ? 'base' : `task/${taskId}`;
  const parent = path.join(WORK_ROOT, opaqueId(taskId, runTag));
  const dir = path.join(parent, 'app');
  fs.rmSync(parent, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // Export exactly one snapshot tree (no .git, no other branches).
  const tar = sh('git', ['-C', bench, 'archive', '--format=tar', branch]);
  sh('tar', ['-x', '-C', dir], { input: tar });
  // Fresh single-commit repository (needed by Code Review Graph; carries no history).
  sh('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  sh('git', ['add', '-A'], { cwd: dir });
  sh('git', ['commit', '-q', '-m', 'initial'], { cwd: dir, env: NEUTRAL_GIT_ENV });
  // Type information for our TS-checker graph, reachable by module resolution but outside the agent's cwd.
  fs.mkdirSync(WORK_ROOT, { recursive: true });
  const nm = path.join(WORK_ROOT, 'node_modules');
  if (!fs.existsSync(nm)) fs.symlinkSync(abs('targets/deps/node_modules'), nm);
  const files = listCorpusFiles(dir, cfg.target.include_dirs);
  const hash = workspaceHash(dir, files);
  const cacheDir = path.join(abs(cfg.cache_dir), 'agent-ws', hash.slice(0, 12));
  fs.mkdirSync(cacheDir, { recursive: true });
  return { taskId, dir, hash, files, corpus: { repoRoot: dir, commit: hash.slice(0, 40), files, cacheDir } };
}

/** Sanity checks used by tests and before every billable run. Returns a list of violations (empty = OK). */
export function checkWorkspaceIsolation(ws: Workspace, cfg: BenchmarkConfig): string[] {
  const v: string[] = [];
  const log = spawnSync('git', ['-C', ws.dir, 'log', '--oneline'], { encoding: 'utf8' }).stdout.trim().split('\n');
  if (log.length !== 1) v.push(`workspace git history has ${log.length} commits (expected 1)`);
  const branches = spawnSync('git', ['-C', ws.dir, 'branch', '-a'], { encoding: 'utf8' }).stdout.trim().split('\n');
  if (branches.length !== 1) v.push(`workspace has ${branches.length} branches`);
  if (/code-graph|bench|task|eval/i.test(ws.dir)) v.push(`workspace path may leak context: ${ws.dir}`);
  const listing = spawnSync('git', ['-C', ws.dir, 'ls-files'], { encoding: 'utf8' }).stdout;
  if (/evaluation\/dataset|\.patch\b|AUDIT|ADJUDICATION/.test(listing)) v.push('workspace contains dataset files');
  if (ws.taskId !== 'base') {
    const tid = ws.taskId.replace(/_\d+$/, '');
    if (ws.dir.includes(tid)) v.push('workspace path contains task id');
  }
  // Snapshot equality with the frozen benchmark manifest.
  const manifest = JSON.parse(fs.readFileSync(abs('targets/bench.manifest.json'), 'utf8'));
  const expected = ws.taskId === 'base' ? manifest.base.corpus_sha256 : manifest.tasks[ws.taskId]?.corpus_sha256;
  const corpusHash = crypto.createHash('sha256').update(ws.files.map((f) => f + '\0' + fs.readFileSync(path.join(ws.dir, f), 'utf8')).join('\0')).digest('hex');
  if (expected && corpusHash !== expected) v.push('workspace corpus differs from the frozen snapshot manifest');
  void cfg;
  return v;
}
