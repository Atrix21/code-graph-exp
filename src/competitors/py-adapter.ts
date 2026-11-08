/**
 * Shared plumbing for out-of-process competitor adapters (Python, run in their own pinned venvs).
 * The Python adapters (src/competitors/py/*.py) run the REAL upstream implementations and
 * emit results in our common schema; this wrapper only shells out and parses JSON.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { RetrievalOutput, RetrievalQuery } from '../types.js';

export function runPython(python: string, script: string, args: string[], env: Record<string, string> = {}): { stdout: string; stderr: string } {
  const r = spawnSync(python, ['-I', script, ...args], {
    encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, env: { ...process.env, PYTHONHASHSEED: '0', HF_HUB_OFFLINE: '1', ...env },
  });
  if (r.status !== 0) throw new Error(`${path.basename(script)} ${args[0]} failed (exit ${r.status}):\n${r.stderr?.slice(-4000)}`);
  return { stdout: r.stdout, stderr: r.stderr };
}

export function lastJsonLine(s: string): any {
  const lines = s.trim().split('\n').filter((l) => l.trim().startsWith('{'));
  return JSON.parse(lines[lines.length - 1]);
}

export function writeQueries(dir: string, qs: RetrievalQuery[]): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `queries-${process.pid}.jsonl`);
  fs.writeFileSync(p, qs.map((q) => JSON.stringify({ task_id: q.task_id, query: q.query })).join('\n') + '\n');
  return p;
}

export function readOutputs(p: string, method: string): RetrievalOutput[] {
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => {
    const o = JSON.parse(l);
    return {
      task_id: o.task_id, method, results: (o.results ?? []).filter((r: any) => r.file), context: o.context ?? '',
      latency_ms: o.latency_ms, llm_tokens: o.llm_tokens ?? null, metadata: o.metadata ?? {},
    } as RetrievalOutput;
  });
}
