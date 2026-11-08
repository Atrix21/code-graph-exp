/**
 * Single-shot backends: one model call per (task, condition, repeat), no tools.
 *  - mock-context-top3 (non-billable, deterministic): submits the first 3 snippet headers of the context.
 *    Validates the pipeline and gives a "retrieval-only" floor: what you get by trusting the ranking blindly.
 *  - local-qwen (non-billable): Qwen3-1.7B, greedy. Validates prompts/parsing with a real model. Not result-bearing.
 *  - claude-code (BILLABLE): see claude-code.ts; refuses to run without an approval file.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { abs } from '../../config.js';
import { countTokens } from '../../evaluation/token-accounting.js';
import type { Diagnosis, TokenUsage } from '../types.js';

export interface SingleShotItem { id: string; system: string; prompt: string; context: string }
export interface SingleShotResult {
  id: string; raw: unknown; usage: TokenUsage | null; usage_source: 'api-reported' | 'proxy-tokenizer' | 'unavailable'; cost_usd: number | null; latency_ms: number; error?: string;
  /** Set when the item is NOT scored: an infrastructure failure / init-fingerprint mismatch, or 'pending' (not run: halted). */
  excluded?: string;
  /** Extra per-run metadata recorded with the scored run (status, cost reconciliation, timing, init fingerprint). */
  extra?: Record<string, unknown>;
}

/** `halted`: why the backend stopped early (pending items come back with `excluded: 'pending'`). */
export type SingleShotResults = SingleShotResult[] & { halted?: string | null; meta?: Record<string, unknown> };

export interface SingleShotBackend { name: string; model: string; billable: boolean; run(items: SingleShotItem[], workDir: string): Promise<SingleShotResults> }

/** Parse "// <file>:<a>-<b> <symbol> [...]" headers (BM25/embeddings/graph renderers) or "file:line:" (rg). */
export function contextTopCandidates(context: string, k = 3): Diagnosis | null {
  const out: Diagnosis['candidates'] = [];
  const seen = new Set<string>();
  for (const line of context.split('\n')) {
    let m = /^\/\/ (\S+?):(\d+)-(\d+) (\S+)/.exec(line);
    let c: Diagnosis['candidates'][number] | null = null;
    if (m) c = { file: m[1], start_line: +m[2], end_line: +m[3], symbol: m[4], explanation: 'top retrieved snippet' };
    else if ((m = /^(src\/\S+?\.ts):(\d+):/.exec(line))) c = { file: m[1], start_line: +m[2], end_line: +m[2], symbol: '', explanation: 'top grep hit' };
    else if ((m = /^NODE (\S+) \[src=(\S+) loc=L(\d+)/.exec(line))) c = { file: m[2], start_line: +m[3], symbol: m[1].replace(/^\./, '').replace(/\(\)$/, ''), explanation: 'graphify node' };
    if (!c) continue;
    const key = `${c.file}:${c.symbol || c.start_line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= k) break;
  }
  return out.length ? { candidates: out } : null;
}

export const mockContextTop3: SingleShotBackend = {
  name: 'mock-context-top3', model: 'none', billable: false,
  async run(items) {
    return items.map((it) => ({ id: it.id, raw: contextTopCandidates(it.context), usage: { input: countTokens(it.system + it.prompt), output: 0, cache_read: 0, cache_write: 0 }, usage_source: 'proxy-tokenizer', cost_usd: 0, latency_ms: 0 }));
  },
};

export const localQwen: SingleShotBackend = {
  name: 'local-qwen', model: 'Qwen/Qwen3-1.7B', billable: false,
  async run(items, workDir) {
    fs.mkdirSync(workDir, { recursive: true });
    const inp = path.join(workDir, 'local-in.jsonl'), out = path.join(workDir, 'local-out.jsonl');
    fs.writeFileSync(inp, items.map((i) => JSON.stringify({ id: i.id, system: i.system, prompt: i.prompt })).join('\n') + '\n');
    let r = spawnSync('true', { encoding: 'utf8' });
    for (let attempt = 0; attempt < 3; attempt++) { // resumable; retries after OOM kills
      r = spawnSync(abs('vendor/.venvs/embeddings/bin/python'), ['-I', abs('scripts/agent-eval/local_llm.py'), '--model', this.model, '--in', inp, '--out', out], {
        encoding: 'utf8', env: { ...process.env, HF_HUB_OFFLINE: '1', TOKENIZERS_PARALLELISM: 'false' }, maxBuffer: 64 * 1024 * 1024,
      });
      if (r.status === 0) break;
    }
    if (r.status !== 0) throw new Error(`local-qwen failed (status=${r.status} signal=${r.signal} error=${r.error?.message ?? ""}): ${r.stderr.slice(-1500)}`);
    const byId = new Map(fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => { const o = JSON.parse(l); return [o.id, o]; }));
    return items.map((it) => {
      const o = byId.get(it.id);
      return { id: it.id, raw: o?.text ?? null, usage: o ? { input: o.input_tokens, output: o.output_tokens, cache_read: 0, cache_write: 0 } : null, usage_source: 'api-reported' as const, cost_usd: 0, latency_ms: o?.latency_ms ?? 0, error: o ? undefined : 'no output' };
    });
  },
};
