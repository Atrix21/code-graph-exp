#!/usr/bin/env tsx
/**
 * Experiment 2 CLI.
 *   contexts  --split dev|test --budget N                     build single-shot contexts (non-billable)
 *   single    --split --budget --methods a,b --repeats R --backend mock|local-qwen|claude-code [--task-ids id,..] --run ID
 *   agentic   (see agentic.ts)
 *   report    --run ID [--reference COND]
 */
import fs from 'node:fs';
import path from 'node:path';
import { abs, loadConfig } from '../config.js';
import { buildContexts, EXP_DIR, SINGLE_SHOT_METHODS } from './contexts.js';
import { runSingleShot } from './runner.js';
import { localQwen, mockContextTop3, type SingleShotBackend } from './backends/single-shot.js';
import { confirmatoryReport, loadRuns, report } from './analysis.js';

const arg = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };

async function main() {
  const cfg = loadConfig();
  const cmd = process.argv[2];
  if (cmd === 'contexts') {
    const rows = await buildContexts(cfg, arg('split', 'dev') as 'dev' | 'test', Number(arg('budget', '8000')));
    const by = new Map<string, number[]>();
    for (const r of rows) { if (!by.has(r.method)) by.set(r.method, []); by.get(r.method)!.push(r.tokens); }
    for (const [m, t] of by) console.log(`${m.padEnd(18)} n=${t.length} mean tokens=${Math.round(t.reduce((a, b) => a + b, 0) / t.length)}`);
    return;
  }
  if (cmd === 'single') {
    const name = arg('backend', 'mock')!;
    let backend: SingleShotBackend;
    if (name === 'mock') backend = mockContextTop3;
    else if (name === 'local-qwen') backend = localQwen;
    else if (name === 'claude-code') backend = (await import('./backends/claude-code.js')).claudeSingleShot(arg('model', 'sonnet')!);
    else throw new Error(`unknown backend ${name}`);
    const methods = (arg('methods') ?? ['none', ...SINGLE_SHOT_METHODS, 'oracle'].join(',')).split(',');
    const runId = arg('run', `single-${name}-${arg('split', 'dev')}-${arg('budget', '8000')}`)!;
    const runs = await runSingleShot(cfg, { runId, split: arg('split', 'dev') as 'dev' | 'test', budget: Number(arg('budget', '8000')), methods, repeats: Number(arg('repeats', '1')), backend, taskIds: arg('task-ids')?.split(',') });
    const md = report(runs, arg('reference', `single:none@${arg('budget', '8000')}`));
    fs.writeFileSync(abs(path.join(EXP_DIR, 'results', runId, 'report.md')), md + '\n');
    console.log(md);
    return;
  }
  if (cmd === 'agentic') return (await import('./agentic.js')).agenticCommand(cfg);
  if (cmd === 'report') {
    const dir = abs(path.join(EXP_DIR, 'results', arg('run')!));
    const runs = loadRuns(dir);
    const md = report(runs, arg('reference')) + '\n\n## Confirmatory analysis (pre-registered)\n\n' + confirmatoryReport(runs);
    fs.writeFileSync(path.join(dir, 'report.md'), md + '\n');
    console.log(md);
    return;
  }
  console.error('usage: agent-eval contexts|single|agentic|report ...');
  process.exit(2);
}
main().catch((e) => { console.error(e); process.exit(1); });
