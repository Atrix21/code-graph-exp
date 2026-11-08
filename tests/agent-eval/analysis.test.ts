import { describe, it, expect } from 'vitest';
import { compare, confirmatoryReport, holm, perTask, CONFIRMATORY } from '../../src/agent-eval/analysis.js';

const run = (task: string, condition: string, repeat: number, correct: number, tokens: number): any => ({
  run_id: `${task}|${condition}|${repeat}`, task_id: task, condition, repeat, backend: 'synthetic', model: 'x',
  score: { valid: 1, rc_at_1: correct, rc_at_3: correct, file_at_1: correct, line_at_1: correct, line_at_3: correct, rc_line_at_1: correct, rc_rank: correct ? 1 : null, resolved: [] },
  usage: { input: tokens, output: 0, cache_read: 0, cache_write: 0 }, cost_usd: tokens / 1e6, latency_ms: 1000, turns: 5, retrieval_calls: 1, tool_calls: {},
});

describe('confirmatory analysis', () => {
  const tasks = Array.from({ length: 14 }, (_, i) => `t${i}`);
  const runs = tasks.flatMap((t, i) => [0, 1, 2].flatMap((r) => [
    run(t, 'agentic:hybrid', r, i < 11 ? 1 : 0, 30_000),   // 11/14 correct
    run(t, 'agentic:baseline', r, i < 4 ? 1 : 0, 50_000),  // 4/14 correct, more tokens
  ]));
  it('detects a large, consistent improvement and lower-is-better metrics', () => {
    const pt = perTask(runs);
    const h1a = compare(pt, CONFIRMATORY[0]);
    expect(h1a.missing).toBe(false);
    if (!h1a.missing) { expect(h1a.improvement).toBeCloseTo(0.5, 5); expect(h1a.wins).toBe(7); expect(h1a.losses).toBe(0); expect(h1a.p_one_sided).toBeLessThan(0.01); }
    const tok = compare(pt, CONFIRMATORY.find((c) => c.id === 'H2-tokens')!);
    if (!tok.missing) { expect(tok.improvement).toBeCloseTo(20_000, 0); expect(tok.mean_a).toBeCloseTo(30_000, 0); }
  });
  it('marks hypotheses whose conditions were not run, and Holm is monotone and capped at 1', () => {
    const md = confirmatoryReport(runs);
    expect(md).toContain('| H1b |');
    expect(md).toMatch(/H1b .*not run/);
    const h = holm([0.01, 0.04, 0.03, 0.5]);
    expect(h.adjusted.every((p) => p <= 1)).toBe(true);
    expect(h.reject).toEqual([true, false, false, false]);
  });
  it('repeat agreement is 1 when repeats agree', () => {
    expect(confirmatoryReport(runs)).toContain('agentic:hybrid 1.00');
  });
});
