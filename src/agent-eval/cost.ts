/**
 * Pre-approval cost estimate (non-billable). Single-shot input sizes are exact (proxy-tokenized from the prepared
 * contexts); outputs and agentic runs use explicit assumptions, which the dev pilot replaces with measured values.
 * Prices: claude-api skill model table (cached 2026-10-06); cache-write = 1.25x input (5-min TTL), cache-read as listed.
 */
import fs from 'node:fs';
import { abs } from '../config.js';
import { EXP_DIR, loadContexts } from './contexts.js';

export const PRICES: Record<string, { in: number; out: number; cacheRead: number; cacheWrite: number }> = {
  sonnet: { in: 2.0, out: 10.0, cacheRead: 0.2, cacheWrite: 2.5 },
  haiku: { in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  opus: { in: 4.0, out: 20.0, cacheRead: 0.2, cacheWrite: 5.0 },
};

/** Assumptions (per run). Low/mid/high scenarios; replaced by pilot measurements before the main run. */
export const AGENTIC_ASSUMPTIONS = {
  low: { turns: 6, finalContext: 18_000, outputPerTurn: 400 },
  mid: { turns: 12, finalContext: 40_000, outputPerTurn: 900 }, // output includes adaptive-thinking tokens
  high: { turns: 25, finalContext: 90_000, outputPerTurn: 1_500 },
};
export const SINGLE_SHOT_OUTPUT = { low: 400, mid: 1_200, high: 3_000 }; // diagnosis JSON + thinking

export function agenticRunCost(model: string, s: keyof typeof AGENTIC_ASSUMPTIONS, toolSchemaTokens: number): number {
  const p = PRICES[model], a = AGENTIC_ASSUMPTIONS[s];
  const prefix0 = 1_500 + toolSchemaTokens; // system + tools (cached after turn 1)
  let cacheRead = 0;
  for (let t = 1; t < a.turns; t++) cacheRead += prefix0 + (a.finalContext * t) / a.turns; // re-read prior prefix each turn
  const cacheWrite = prefix0 + a.finalContext; // every new token is written to cache once
  const out = a.turns * a.outputPerTurn;
  return (cacheRead * p.cacheRead + cacheWrite * p.cacheWrite + out * p.out) / 1e6;
}

export function singleShotCost(model: string, inputTokens: number, s: keyof typeof SINGLE_SHOT_OUTPUT): number {
  const p = PRICES[model];
  return ((inputTokens + 3_000 /* Claude Code base prompt + schema, uncached upper bound */) * p.in + SINGLE_SHOT_OUTPUT[s] * p.out) / 1e6;
}

export function estimatePlan(opts: { model: string; testTasks: number; devTasks: number; agenticConditions: { id: string; toolSchemaTokens: number }[]; repeats: number; singleShotSplits: { split: string; budget: number }[]; singleShotMethods: string[] }) {
  const rows: { phase: string; runs: number; low: number; mid: number; high: number }[] = [];
  // Agentic: dev pilot (1 repeat) + test (R repeats)
  for (const [phase, tasks, reps] of [['agentic dev pilot', opts.devTasks, 1], ['agentic test', opts.testTasks, opts.repeats]] as const) {
    const runs = tasks * reps * opts.agenticConditions.length;
    const c = (s: keyof typeof AGENTIC_ASSUMPTIONS) => opts.agenticConditions.reduce((a, cond) => a + tasks * reps * agenticRunCost(opts.model, s, cond.toolSchemaTokens), 0);
    rows.push({ phase, runs, low: c('low'), mid: c('mid'), high: c('high') });
  }
  for (const { split, budget } of opts.singleShotSplits) {
    let ctx: { task_id: string; method: string; tokens: number }[] = [];
    try { ctx = loadContexts(split, budget); } catch { continue; }
    const items = ctx.filter((c) => opts.singleShotMethods.includes(c.method));
    const reps = split === 'test' ? opts.repeats : 1;
    const c = (s: keyof typeof SINGLE_SHOT_OUTPUT) => items.reduce((a, it) => a + reps * singleShotCost(opts.model, it.tokens + 600, s), 0);
    rows.push({ phase: `single-shot ${split} @${budget}`, runs: items.length * reps, low: c('low'), mid: c('mid'), high: c('high') });
  }
  return rows;
}

if (process.argv[1]?.endsWith('cost.ts')) {
  // Tool-schema tokens actually offered per turn, measured from recorded request bodies with the read-only deny
  // list applied (results/isolation-report.md): our search_code ≈ 68, Graphify 7 tools ≈ 945, CRG 23 tools ≈ 6,245.
  void fs; void abs; void EXP_DIR;
  const conds = [
    { id: 'baseline', toolSchemaTokens: 0 },
    { id: 'embeddings', toolSchemaTokens: 68 },
    { id: 'hybrid', toolSchemaTokens: 68 },
    { id: 'graphify', toolSchemaTokens: 945 },
    { id: 'crg', toolSchemaTokens: 6245 },
  ];
  for (const model of ['haiku', 'sonnet', 'opus']) {
    const rows = estimatePlan({ model, testTasks: 14, devTasks: 6, agenticConditions: conds, repeats: 3, singleShotSplits: [{ split: 'dev', budget: 2000 }, { split: 'dev', budget: 8000 }, { split: 'test', budget: 2000 }, { split: 'test', budget: 8000 }], singleShotMethods: ['none', 'ripgrep', 'bm25', 'embeddings', 'graphify', 'code_review_graph', 'custom_graph', 'hybrid', 'oracle'] });
    console.log(`\n${model}`);
    for (const r of rows) console.log(`  ${r.phase.padEnd(26)} runs=${String(r.runs).padStart(4)}  $${r.low.toFixed(2)} / $${r.mid.toFixed(2)} / $${r.high.toFixed(2)}`);
    const tot = (k: 'low' | 'mid' | 'high') => rows.reduce((a, r) => a + r[k], 0);
    console.log(`  ${'TOTAL'.padEnd(26)}            $${tot('low').toFixed(2)} / $${tot('mid').toFixed(2)} / $${tot('high').toFixed(2)}  (low / mid / high)`);
  }
}
