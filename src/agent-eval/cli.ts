#!/usr/bin/env tsx
/**
 * Experiment 2 CLI.
 *   contexts  --split dev|test --budget N                     build single-shot contexts (non-billable)
 *   single    --split --budget --methods a,b --repeats R --backend mock|local-qwen|claude-code [--task-ids id,..] --run ID
 *             claude-code: --account NAME --run-usd N [--max-usd N] [--model id] [--effort high] [--billing subscription|api-key] [--timeout-s N]
 *             (always sequential; re-running the same --run resumes)
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
    else if (name === 'claude-code') {
      // Billable unless --mock-url is given by a caller in-process; the gate (APPROVAL.json + AGENT_EVAL_BILLABLE=1) decides.
      const cc = await import('./backends/claude-code.js');
      const { bindAccount, claudeVersion, DEFAULT_EFFORT, DEFAULT_MODEL } = await import('./agentic.js');
      const billing = (arg('billing') ?? 'subscription') as 'subscription' | 'api-key';
      const acct = bindAccount({ account: arg('account'), billing, mock: false });
      cc.installSignalHandlers();
      backend = cc.claudeSingleShot(arg('model', DEFAULT_MODEL)!, {
        runUsd: arg('run-usd') ? Number(arg('run-usd')) : undefined, maxTotalUsd: arg('max-usd') ? Number(arg('max-usd')) : undefined, split: arg('split', 'dev'),
        effort: arg('effort', DEFAULT_EFFORT), billing, account: arg('account'), baseEnv: acct?.env, version: claudeVersion(),
        timeoutMs: arg('timeout-s') ? Number(arg('timeout-s')) * 1000 : undefined, concurrency: 1,
      });
    }
    else throw new Error(`unknown backend ${name}`);
    const methods = (arg('methods') ?? ['none', ...SINGLE_SHOT_METHODS, 'oracle'].join(',')).split(',');
    const runId = arg('run', `single-${name}-${arg('split', 'dev')}-${arg('budget', '8000')}`)!;
    const runs = await runSingleShot(cfg, { runId, split: arg('split', 'dev') as 'dev' | 'test', budget: Number(arg('budget', '8000')), methods, repeats: Number(arg('repeats', '1')), backend, taskIds: arg('task-ids')?.split(',') });
    if (runs.length) {
      const md = report(runs, arg('reference', `single:none@${arg('budget', '8000')}`));
      fs.writeFileSync(abs(path.join(EXP_DIR, 'results', runId, 'report.md')), md + '\n');
      console.log(md);
    }
    console.error(`single-shot ${runId}: ${runs.status}, ${runs.length} scored${runs.halted ? `; HALTED: ${runs.halted}` : ''}`);
    if (runs.halted) process.exitCode = 3;
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
