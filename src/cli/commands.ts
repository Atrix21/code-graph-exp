/**
 * Long-running CLI commands (see src/cli/index.ts for the dispatcher).
 */
import fs from 'node:fs';
import path from 'node:path';
import { abs, type BenchmarkConfig } from '../config.js';
import { loadCorpus, setupTarget } from '../evaluation/corpus.js';
import { loadTasks, validateTasks } from '../evaluation/ground-truth.js';
import { SymbolIndex } from '../evaluation/symbol-index.js';
import { REGISTRY, PRIMARY_METHODS } from '../evaluation/methods.js';
import { evaluateOutputs, runMethod, toQueries, writeRun, type MethodRun } from '../evaluation/runner.js';
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
      const m = setupTarget(cfg, { noPatches: flag('no-patches') });
      console.log(JSON.stringify(m, null, 2));
      if (m.tsc_exit !== 0) { console.error('WARNING: benchmark snapshot does not type-check'); process.exit(1); }
      return;
    }
    case 'index': {
      // Builds every index that can be cached (embeddings, competitor graphs, custom graph).
      const corpus = loadCorpus(cfg);
      const names = (arg('methods') ?? 'bm25,embeddings,graphify,code_review_graph,custom_graph').split(',');
      for (const n of names) {
        const m = await REGISTRY[n]();
        const s = await m.prepare(corpus);
        console.log(JSON.stringify(s));
        await m.close?.();
      }
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
      const corpus = loadCorpus(cfg);
      const tasks = selectTasks(cfg, split);
      const index = new SymbolIndex(corpus.repoRoot, corpus.files);
      const issues = validateTasks(tasks, index).filter((i) => i.level === 'error');
      if (issues.length) throw new Error(`ground truth invalid on benchmark snapshot:\n${issues.map((i) => `${i.task_id}: ${i.msg}`).join('\n')}`);
      const queries = toQueries(tasks);
      const runs: MethodRun[] = [];
      for (const name of methods) {
        const f = REGISTRY[name];
        if (!f) throw new Error(`unknown method ${name}`);
        const m = await f();
        const { index: st, outputs } = await runMethod(m, corpus, queries, budget);
        const metrics = evaluateOutputs(index, tasks, outputs);
        runs.push({ method: name, index: st, outputs, metrics });
      }
      const dir = path.join(abs(cfg.results_dir), runId);
      writeRun(dir, runs, {
        run_id: runId, split, methods, budget, commit: corpus.commit, n_tasks: tasks.length, n_files: corpus.files.length,
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
