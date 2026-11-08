/**
 * Long-running CLI commands (see src/cli/index.ts for the dispatcher).
 */
import fs from 'node:fs';
import path from 'node:path';
import { abs, type BenchmarkConfig } from '../config.js';
import { checkoutSnapshot, setupTarget } from '../evaluation/corpus.js';
import { loadTasks, validateTasks } from '../evaluation/ground-truth.js';
import { SymbolIndex } from '../evaluation/symbol-index.js';
import { REGISTRY, PRIMARY_METHODS } from '../evaluation/methods.js';
import { runPerTask, writeRun } from '../evaluation/runner.js';
import { generateReport } from '../evaluation/report.js';
import type { GroundTruthTask, RetrievalBudget } from '../types.js';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
function flag(name: string) { return process.argv.includes(`--${name}`); }

export function selectTasks(cfg: BenchmarkConfig, split: string): GroundTruthTask[] {
  const all = loadTasks(abs(arg('tasks', cfg.dataset.tasks_dir)!));
  if (split === 'all') return all;
  const sel = all.filter((t) => t.split === split);
  if (!sel.length) throw new Error(`no tasks with split=${split}`);
  return sel;
}

export async function run(cmd: string, cfg: BenchmarkConfig, _repo: string) {
  switch (cmd) {
    case 'setup-target': {
      const m = setupTarget(cfg, { noTypecheck: flag('no-typecheck') });
      console.log(JSON.stringify({ base: m.base, tasks: Object.keys(m.tasks).length, typecheck_failures: m.typecheck_failures }, null, 2));
      if (m.typecheck_failures) { console.error('WARNING: some snapshots do not type-check'); process.exit(1); }
      return;
    }
    case 'index': {
      // Builds every cacheable index (embeddings, custom graph, competitor graphs) for every snapshot.
      const manifest = JSON.parse(fs.readFileSync(abs('targets/bench.manifest.json'), 'utf8'));
      const names = (arg('methods') ?? 'bm25,embeddings,graphify,code_review_graph,custom_graph').split(',');
      const { precomputeEmbeddings } = await import('../evaluation/runner.js');
      if (names.includes('embeddings')) await precomputeEmbeddings(cfg, selectTasks(cfg, 'all'));
      for (const snap of ['base', ...Object.keys(manifest.tasks).sort()]) {
        const corpus = checkoutSnapshot(cfg, snap);
        for (const n of names) {
          const m = await REGISTRY[n]();
          const st = await m.prepare(corpus);
          console.log(JSON.stringify({ snapshot: snap, method: st.method, index_ms: Math.round(st.index_ms) }));
          await m.close?.();
        }
      }
      checkoutSnapshot(cfg, 'base');
      return;
    }
    case 'graph-build':
    case 'graph-validate': {
      const { graphBuildCommand } = await import('./graph-commands.js');
      return graphBuildCommand(cfg, cmd === 'graph-validate');
    }
    case 'benchmark': {
      const split = arg('split', 'dev')!;
      const runId = arg('run', `bench-${split}`)!;
      const methods = (arg('methods') ?? PRIMARY_METHODS.join(',')).split(',');
      const budget: RetrievalBudget = { maxResults: Number(arg('max-results', String(cfg.budget.maxResults))), maxContextTokens: Number(arg('budget', String(cfg.budget.maxContextTokens))) };
      const tasks = selectTasks(cfg, split);
      for (const n of methods) if (!REGISTRY[n]) throw new Error(`unknown method ${n}`);
      const runs = await runPerTask(cfg, tasks, methods.map((n) => ({ name: n, make: REGISTRY[n] })), budget);
      const manifest = JSON.parse(fs.readFileSync(abs('targets/bench.manifest.json'), 'utf8'));
      const dir = path.join(abs(cfg.results_dir), runId);
      writeRun(dir, runs, {
        run_id: runId, split, methods, budget, commit: `per-task snapshots (base ${manifest.base.commit})`, snapshot_commits: Object.fromEntries(tasks.map((t) => [t.task_id, manifest.tasks[t.task_id]?.commit])), n_tasks: tasks.length, n_files: manifest.base.corpus_files,
        dataset_version: cfg.dataset.version, created: new Date().toISOString(),
      });
      console.error(`wrote ${dir}`);
      fs.writeFileSync(path.join(dir, 'report.md'), generateReport(dir));
      console.log(fs.readFileSync(path.join(dir, 'report.md'), 'utf8'));
      return;
    }
    case 'ablation': {
      const { ablationCommand } = await import('./ablation.js');
      return ablationCommand(cfg);
    }
    case 'report': {
      const dirs = (arg('run') ?? '').split(',').filter(Boolean);
      const targets = dirs.length ? dirs.map((d) => path.join(abs(cfg.results_dir), d)) : fs.readdirSync(abs(cfg.results_dir)).map((d) => path.join(abs(cfg.results_dir), d)).filter((d) => fs.existsSync(path.join(d, 'metrics.json')));
      for (const d of targets) {
        fs.writeFileSync(path.join(d, 'report.md'), generateReport(d));
        console.error(`wrote ${path.join(d, 'report.md')}`);
      }
      return;
    }
    default:
      console.error(`unknown command ${cmd}`);
      process.exit(2);
  }
}
