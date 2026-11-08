import { afterAll, describe, expect, it } from 'vitest';
import { makeIndex, lines } from './helpers.js';
import { computeTaskMetrics, bootstrapCI, pairedBootstrap, rng, mean, median, renderSymbolUniform, UNIFORM_MAX_LINES } from '../../src/evaluation/metrics.js';
import { aggregate, TTR_CAP } from '../../src/evaluation/report-generator.js';
import { normaliseOutput, type NormalisedOutput } from '../../src/evaluation/normalise.js';
import { countTokens } from '../../src/evaluation/token-accounting.js';
import type { GroundTruthTask } from '../../src/types.js';

const A = 'mt1/a.ts';
const B = 'mt1/b.ts';
const fn = (n: string) => [`export function ${n}() {`, `  return '${n}';`, `}`];
const bigBody = Array.from({ length: 118 }, (_, i) => `  const v${i} = compute(${i}, 'padding to make this line carry a decent number of tokens');`);
const manyFns = Array.from({ length: 60 }, (_, i) => `export function g${i}() { return ${i}; }`).join('\n') + '\n';
const ctx = makeIndex({
  [A]: lines(...fn('f1'), ...fn('f2'), ...fn('f3'), ...fn('f4'), ...fn('f5'), ...fn('f6')), // f_i at lines 3(i-1)+1 .. 3(i-1)+3
  [B]: lines(...fn('h1')),
  'mt1/big.ts': lines('export function big() {', ...bigBody, '}'), // 120 lines
  'mt1/many.ts': manyFns,
});
afterAll(() => ctx.cleanup());
const k = (n: string, f = A) => `${f}::${n}`;

const gt = (rel: string[], rc: string[], files = [A]): GroundTruthTask => ({
  task_id: 't', split: 'dev', description: 'x', root_cause_symbols: rc, relevant_symbols: rel, relevant_files: files,
});
const normOf = (syms: string[], unresolved = 0): NormalisedOutput => ({
  task_id: 't', method: 'm', items: [], rankedSymbols: syms, rankedFiles: [...new Set(syms.map((s) => s.split('::')[0]))], anchorLines: new Map(), unresolved,
});
const extras = { native_context_tokens: 0, latency_ms: 0, llm_tokens: 0, n_results: 0 };
const render = (name: string, file = A) => {
  const s = ctx.index.byKey.get(`${file}::${name}`)!;
  const body = ctx.index.fileLines.get(file)!.slice(s.start_line - 1, Math.min(s.end_line, s.start_line + UNIFORM_MAX_LINES - 1)).join('\n');
  const b = Math.min(s.end_line, s.start_line + UNIFORM_MAX_LINES - 1);
  return `// ${file}:${s.start_line}-${b} ${name}\n${body}\n`;
};

describe('ranking metrics on a hand-computed example', () => {
  // ranked: f2 f1 f5 f3 f6 ; relevant {f1,f3,f4} ; root cause {f3}
  const ranked = [k('f2'), k('f1'), k('f5'), k('f3'), k('f6')];
  const m = computeTaskMetrics(ctx.index, gt([k('f1'), k('f3'), k('f4')], [k('f3')]), normOf(ranked), extras);
  it('Recall@k = hits in top-k / |relevant|', () => {
    expect(m.sym_recall_5).toBeCloseTo(2 / 3);
    expect(m.sym_recall_10).toBeCloseTo(2 / 3);
    expect(m.sym_recall_all).toBeCloseTo(2 / 3);
  });
  it('Precision@k uses k (not the number returned) as denominator', () => {
    expect(m.sym_precision_5).toBeCloseTo(2 / 5);
    expect(m.sym_precision_10).toBeCloseTo(2 / 10); // only 5 returned, still /10
  });
  it('root-cause Acc@1/5/10, rank and MRR', () => {
    expect(m.rc_rank).toBe(4);
    expect([m.rc_hit_1, m.rc_hit_5, m.rc_hit_10]).toEqual([0, 1, 1]);
    expect(m.rc_mrr).toBeCloseTo(0.25);
  });
  it('rank boundary: root cause at exactly rank 5 / rank 1', () => {
    const at5 = computeTaskMetrics(ctx.index, gt([k('f3')], [k('f3')]), normOf([k('f1'), k('f2'), k('f4'), k('f5'), k('f3')]), extras);
    expect([at5.rc_hit_1, at5.rc_hit_5, at5.sym_recall_5]).toEqual([0, 1, 1]);
    const at6 = computeTaskMetrics(ctx.index, gt([k('f3')], [k('f3')]), normOf([k('f1'), k('f2'), k('f4'), k('f5'), k('f6'), k('f3')]), extras);
    expect([at6.rc_hit_5, at6.rc_hit_10, at6.sym_recall_5, at6.sym_recall_10]).toEqual([0, 1, 0, 1]);
    const at1 = computeTaskMetrics(ctx.index, gt([k('f3')], [k('f3')]), normOf([k('f3')]), extras);
    expect([at1.rc_hit_1, at1.rc_mrr]).toEqual([1, 1]);
  });
  it('file metrics (root-cause file derived from root-cause symbols)', () => {
    const fm = computeTaskMetrics(ctx.index, gt([k('f1'), k('h1', B)], [k('h1', B)], [A, B]), normOf([k('f1'), k('h1', B)]), extras);
    expect(fm.file_recall_5).toBe(1);
    expect(fm.file_rc_hit_1).toBe(0);
    expect(fm.file_rc_hit_5).toBe(1);
    expect(fm.file_rc_mrr).toBeCloseTo(0.5);
  });
  it('multi-root-cause: first hit of ANY root-cause symbol counts; recall still over all relevant', () => {
    const mm = computeTaskMetrics(ctx.index, gt([k('f1'), k('f2'), k('f3')], [k('f2'), k('f3')]), normOf([k('f5'), k('f3'), k('f2')]), extras);
    expect(mm.rc_rank).toBe(2);
    expect(mm.sym_recall_5).toBeCloseTo(2 / 3);
  });
  it('empty result list gives zeros / null, never NaN', () => {
    const e = computeTaskMetrics(ctx.index, gt([k('f1')], [k('f1')]), normOf([]), extras);
    expect([e.sym_recall_5, e.sym_precision_5, e.rc_mrr, e.rc_hit_10, e.file_recall_10, e.uniform_tokens_top10, e.recall_at_budget[1000]]).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(e.rc_rank).toBeNull();
    expect(e.tokens_to_root_cause).toBeNull();
  });
  it('relevant set smaller than k caps precision below 1 (identical for every method)', () => {
    const p = computeTaskMetrics(ctx.index, gt([k('f1')], [k('f1')]), normOf([k('f1')]), extras);
    expect(p.sym_precision_5).toBeCloseTo(0.2);
    expect(p.sym_recall_5).toBe(1);
  });
});

describe('uniform-token metrics', () => {
  it('renders a symbol as header + source span', () => {
    expect(renderSymbolUniform(ctx.index, k('f1')).text).toBe(render('f1'));
    expect(renderSymbolUniform(ctx.index, k('f1')).tokens).toBe(countTokens(render('f1')));
  });
  it('caps rendering at 80 lines', () => {
    const r = renderSymbolUniform(ctx.index, 'mt1/big.ts::big');
    expect(r.text.split('\n').length).toBe(UNIFORM_MAX_LINES + 2); // header + 80 + trailing ''
    expect(r.text).toContain('mt1/big.ts:1-80 big');
  });
  it('tokens_to_root_cause = sum of rendered tokens of ranked symbols up to and including the first root cause', () => {
    const m = computeTaskMetrics(ctx.index, gt([k('f3')], [k('f3')]), normOf([k('f2'), k('f1'), k('f3'), k('f5')]), extras);
    const expected = ['f2', 'f1', 'f3'].map((n) => countTokens(render(n))).reduce((a, b) => a + b, 0);
    expect(m.tokens_to_root_cause).toBe(expected);
  });
  it('uniform_tokens_top10 sums the first min(10, n) symbols', () => {
    const m = computeTaskMetrics(ctx.index, gt([k('f3')], [k('f3')]), normOf([k('f2'), k('f1'), k('f3')]), extras);
    expect(m.uniform_tokens_top10).toBe(['f2', 'f1', 'f3'].map((n) => countTokens(render(n))).reduce((a, b) => a + b, 0));
    const ten = Array.from({ length: 12 }, (_, i) => k(`g${i}`.replace(/^/, ''), 'mt1/many.ts'));
    const m2 = computeTaskMetrics(ctx.index, gt([ten[0]], [ten[0]]), normOf(ten), extras);
    const exp10 = ten.slice(0, 10).map((s) => countTokens(render(s.split('::')[1], 'mt1/many.ts'))).reduce((a, b) => a + b, 0);
    expect(m2.uniform_tokens_top10).toBe(exp10);
  });
  it('recall@budget counts only symbols whose cumulative rendering fits; budget boundary is inclusive-by-<=', () => {
    // big renders 80 lines (> 1000 tokens), then f1, f3 are cheap.
    const bigTok = countTokens(render('big', 'mt1/big.ts'));
    expect(bigTok).toBeGreaterThan(1000);
    expect(bigTok).toBeLessThan(2000);
    const rel = [k('f1'), k('f3')];
    const m = computeTaskMetrics(ctx.index, gt(rel, [k('f3')]), normOf(['mt1/big.ts::big', k('f1'), k('f3')]), extras);
    expect(m.recall_at_budget[1000]).toBe(0); // first item alone already exceeds 1k -> nothing fits (no skipping)
    expect(m.rc_hit_at_budget[1000]).toBe(0);
    expect(m.recall_at_budget[2000]).toBe(1);
    expect(m.rc_hit_at_budget[2000]).toBe(1);
    expect(m.recall_at_budget[8000]).toBe(1);
  });
});

describe('aggregation', () => {
  it('ttr_mean_capped caps unfound at 16k; median over found only (survivorship)', () => {
    const mk = (ttr: number | null) => ({ ...computeTaskMetrics(ctx.index, gt([k('f1')], [k('f1')]), normOf([k('f1')]), extras), tokens_to_root_cause: ttr });
    const a = aggregate([mk(100), mk(300), mk(null)]);
    expect(a.ttr_median_found).toBe(200);
    expect(a.ttr_mean_capped).toBeCloseTo((100 + 300 + TTR_CAP) / 3);
    expect(a.rc_found_rate).toBeCloseTo(2 / 3);
  });
});

describe('spec conformance', () => {
  it('FIXED (C1): root-cause rank only considers the first 50 returned symbols', () => {
    const syms = Array.from({ length: 60 }, (_, i) => k(`g${i}`, 'mt1/many.ts'));
    const m = computeTaskMetrics(ctx.index, gt([syms[54]], [syms[54]]), normOf(syms), extras);
    expect(m.rc_rank).toBeNull(); // actual: 55 -> rc_mrr 1/55, tokens_to_root_cause counted, rc_found_rate counts it
  });
  it('normalisation evaluates only the first 50 returned items (harness fix C1)', () => {
    const items = Array.from({ length: 60 }, (_, i) => ({ file: 'mt1/many.ts', symbol: `g${i}`, start_line: null, end_line: null, score: null }));
    const n = normaliseOutput(ctx.index, { task_id: 't', method: 'm', results: items, context: '', latency_ms: 0, llm_tokens: null });
    expect(n.rankedSymbols).toHaveLength(50);
  });
});

describe('bootstrap statistics', () => {
  it('PRNG is deterministic, in [0,1) and seed-sensitive', () => {
    const a = rng(7), b = rng(7), c = rng(8);
    const xa = Array.from({ length: 5 }, a), xb = Array.from({ length: 5 }, b), xc = Array.from({ length: 5 }, c);
    expect(xa).toEqual(xb);
    expect(xa).not.toEqual(xc);
    for (const x of Array.from({ length: 1000 }, a)) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(1); }
  });
  it('bootstrapCI is deterministic for a seed and brackets the mean', () => {
    const xs = [0.03, 0.91, 0.77, 0.12, 0.64, 0.5, 0.25, 0.08, 0.99, 0.81, 0.36, 0.75, 0.58, 0.2];
    expect(bootstrapCI(xs, 99)).toEqual(bootstrapCI(xs, 99));
    expect(bootstrapCI(xs, 99)).not.toEqual(bootstrapCI(xs, 100));
    const [lo, hi] = bootstrapCI(xs);
    expect(lo).toBeLessThan(mean(xs));
    expect(hi).toBeGreaterThan(mean(xs));
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(1);
  });
  it('CI of a constant sample is degenerate; empty sample is NaN', () => {
    expect(bootstrapCI([0.5, 0.5, 0.5])).toEqual([0.5, 0.5]);
    expect(bootstrapCI([]).every(Number.isNaN)).toBe(true);
  });
  it('CI width shrinks with n (sanity of percentile indexing)', () => {
    const small = Array.from({ length: 10 }, (_, i) => i % 2);
    const large = Array.from({ length: 400 }, (_, i) => i % 2);
    const w = (c: [number, number]) => c[1] - c[0];
    expect(w(bootstrapCI(large))).toBeLessThan(w(bootstrapCI(small)));
    // for 0/1 data with p=.5, n=400: approx 1.96*sqrt(.25/400)*2 = 0.098
    expect(w(bootstrapCI(large))).toBeGreaterThan(0.07);
    expect(w(bootstrapCI(large))).toBeLessThan(0.13);
  });
  it('pairedBootstrap: deterministic; identical samples -> diff 0, CI [0,0], P(diff<=0)=1 (ties count as <=0)', () => {
    const a = [1, 0, 1, 1, 0, 0.5];
    const p = pairedBootstrap(a, a);
    expect(p.mean_diff).toBe(0);
    expect(p.ci).toEqual([0, 0]);
    expect(p.p_le_0).toBe(1);
    expect(pairedBootstrap(a, [0, 0, 1, 0, 0, 0])).toEqual(pairedBootstrap(a, [0, 0, 1, 0, 0, 0]));
  });
  it('pairedBootstrap: uniformly better method -> P(diff<=0)=0 and CI above 0; worse -> P=1', () => {
    const a = [1, 1, 1, 0.5, 1, 1, 0.75, 1];
    const b = [0, 0.5, 0.25, 0, 0.5, 0, 0, 0.5];
    const up = pairedBootstrap(a, b);
    expect(up.mean_diff).toBeGreaterThan(0.5);
    expect(up.ci[0]).toBeGreaterThan(0);
    expect(up.p_le_0).toBe(0);
    const down = pairedBootstrap(b, a);
    expect(down.p_le_0).toBe(1);
    expect(down.ci[1]).toBeLessThan(0);
  });
  it('mean/median helpers', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(Number.isNaN(mean([]))).toBe(true);
  });
});
