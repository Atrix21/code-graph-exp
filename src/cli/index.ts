#!/usr/bin/env tsx
/**
 * Benchmark CLI. Commands:
 *   list-symbols   [--repo DIR] [--file PATH]     list canonical symbol keys (for annotators)
 *   validate-gt    [--repo DIR] [--tasks DIR]     validate ground-truth files against the symbol index
 *   setup-target                                   build the benchmark snapshot (upstream + bug patches)
 *   index | graph-build | graph-validate | benchmark | ablation | report
 */
import path from 'node:path';
import { loadConfig, abs, listCorpusFiles } from '../config.js';
import { SymbolIndex } from '../evaluation/symbol-index.js';
import { loadTasks, validateTasks } from '../evaluation/ground-truth.js';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const cmd = process.argv[2];
  const cfg = loadConfig();
  const repo = abs(arg('repo', cfg.target.bench_dir)!);
  switch (cmd) {
    case 'list-symbols': {
      const files = listCorpusFiles(repo, cfg.target.include_dirs);
      const only = arg('file');
      const idx = new SymbolIndex(repo, only ? files.filter((f) => f === only || f.includes(only)) : files);
      for (const s of [...idx.byKey.values()].sort((a, b) => a.key.localeCompare(b.key))) {
        if (s.kind === 'module' && !flag('modules')) continue;
        console.log(`${s.key}\t${s.kind}\tL${s.start_line}-${s.end_line}`);
      }
      break;
    }
    case 'validate-gt': {
      const files = listCorpusFiles(repo, cfg.target.include_dirs);
      const idx = new SymbolIndex(repo, files);
      const tasks = loadTasks(abs(arg('tasks', cfg.dataset.tasks_dir)!));
      const issues = validateTasks(tasks, idx);
      for (const i of issues) console.log(`${i.level.toUpperCase()}\t${i.task_id}\t${i.msg}`);
      const errors = issues.filter((i) => i.level === 'error').length;
      console.log(`${tasks.length} tasks, ${errors} errors, ${issues.length - errors} warnings`);
      process.exit(errors ? 1 : 0);
    }
    default: {
      const mod = await import('./commands.js').catch(() => null);
      if (mod && typeof mod.run === 'function') return mod.run(cmd, cfg, repo);
      console.error(`unknown command: ${cmd}`);
      process.exit(2);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
