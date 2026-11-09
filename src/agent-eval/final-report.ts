#!/usr/bin/env tsx
/**
 * Final report for experiment 2 (protocol Amendment A). Reads the run directories, never re-runs anything, and uses the
 * frozen analysis functions (analysis.ts) unchanged:
 *   - confirmatory family = agentic p2 runs + single-shot runs (conditions `agentic:*`, `single:*@B`);
 *   - agentic p1 runs are relabelled `agentic-p1:*` and reported as secondary (same comparisons, no correction).
 *
 *   tsx src/agent-eval/final-report.ts [--split test|dev] [--out results/final-report.md]
 */
import fs from 'node:fs';
import path from 'node:path';
import { abs } from '../config.js';
import { mean } from '../evaluation/metrics.js';
import { compare, confirmatoryReport, perTask, PRIMARY, repeatAgreement, report, type Comparison } from './analysis.js';
import { isUsageLimitExclusion } from './backends/claude-code.js';
import { EXP_DIR } from './contexts.js';
import type { ScoredRun } from './runner.js';

const arg = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const RES = abs(path.join(EXP_DIR, 'results'));
const readJsonl = (p: string): any[] => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

/** Run directories per split (dev = the pilot: stage 1 + stage 2). */
export const RUN_DIRS: Record<'test' | 'dev', { p2: string[]; p1: string[]; single2k: string[]; single8k: string[] }> = {
  test: { p2: ['stage3-agentic-test-p2'], p1: ['stage3-agentic-test-p1'], single2k: ['stage3-single-test-2000'], single8k: ['stage3-single-test-8000'] },
  dev: { p2: ['stage2-agentic-dev-p2'], p1: ['stage1-agentic-dev', 'stage2-agentic-dev-p1'], single2k: ['stage1-single-dev-2000', 'stage2-single-dev-2000'], single8k: ['stage1-single-dev-8000', 'stage2-single-dev-8000'] },
};

export const relabelP1 = (runs: ScoredRun[]): ScoredRun[] => runs.map((r) => ({ ...r, condition: r.condition.replace(/^agentic:/, 'agentic-p1:') }));

const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '—');
const f0 = (x: number) => (Number.isFinite(x) ? Math.round(x).toLocaleString('en-US') : '—');
const tok = (r: ScoredRun) => (r.usage ? r.usage.input + r.usage.output + r.usage.cache_read + r.usage.cache_write : NaN);

function load(dirs: string[]): { runs: ScoredRun[]; status: string[] } {
  const runs: ScoredRun[] = [], status: string[] = [];
  for (const d of dirs) {
    const dir = path.join(RES, d);
    if (!fs.existsSync(path.join(dir, 'runs.jsonl'))) { status.push(`| ${d} | not run | — | — | — |`); continue; }
    const rs = readJsonl(path.join(dir, 'runs.jsonl')) as ScoredRun[];
    runs.push(...rs);
    let meta: any = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch { /* none */ }
    const excl = readJsonl(path.join(dir, 'excluded.jsonl'));
    const kinds = new Map<string, number>();
    for (const e of excl) { const k = isUsageLimitExclusion(e) ? 'usage-limit interruption (re-run)' : String(e.excluded); kinds.set(k, (kinds.get(k) ?? 0) + 1); }
    const pending = meta.n_pending ?? (meta.n_items != null ? meta.n_items - rs.length : '—');
    status.push(`| ${d} | ${meta.status ?? '—'}${meta.halted ? ` (${String(meta.halted).slice(0, 60)})` : ''} | ${rs.length} | ${[...kinds].map(([k, n]) => `${k} ×${n}`).join(', ') || '0'} | ${pending} |`);
  }
  return { runs, status };
}

/** Tool adoption per condition: share of runs with ≥1 retrieval call; efficiency split by whether the tool was used. */
function adoption(runs: ScoredRun[]): string {
  const by = new Map<string, ScoredRun[]>();
  for (const r of runs) { if (!by.has(r.condition)) by.set(r.condition, []); by.get(r.condition)!.push(r); }
  const lines = ['| Condition | runs | used a retrieval tool | calls/run | tokens/run (used / not used) | turns/run (used / not used) | RC+line@1 (used / not used) |', '|---|---:|---:|---:|---:|---:|---:|'];
  for (const [c, rs] of [...by].sort()) {
    const used = rs.filter((r) => (r.retrieval_calls ?? 0) > 0), not = rs.filter((r) => !((r.retrieval_calls ?? 0) > 0));
    const m = (xs: ScoredRun[], f: (r: ScoredRun) => number) => (xs.length ? mean(xs.map(f)) : NaN);
    lines.push(`| ${c} | ${rs.length} | ${(used.length / rs.length).toFixed(2)} | ${f2(m(rs, (r) => r.retrieval_calls ?? 0))} | ${f0(m(used, tok))} / ${f0(m(not, tok))} | ${f2(m(used, (r) => r.turns ?? NaN))} / ${f2(m(not, (r) => r.turns ?? NaN))} | ${f2(m(used, (r) => r.score[PRIMARY]))} / ${f2(m(not, (r) => r.score[PRIMARY]))} |`);
  }
  return lines.join('\n');
}

function comparisons(runs: ScoredRun[], cs: Comparison[]): string {
  const pt = perTask(runs);
  const fmt = (x: number, m: string) => (m === 'cost' ? x.toFixed(4) : m === PRIMARY || m === 'turns' ? x.toFixed(2) : Math.round(x).toLocaleString('en-US'));
  const lines = ['| ID | Comparison | n tasks | A | B | Improvement [95% CI] | W/L/T | p (one-sided, uncorrected) |', '|---|---|---:|---:|---:|---:|---:|---:|'];
  for (const c of cs.map((x) => compare(pt, x))) {
    if (c.missing) { lines.push(`| ${c.id} | ${c.hypothesis} | — | — | — | not run | — | — |`); continue; }
    lines.push(`| ${c.id} | ${c.hypothesis} | ${c.n} | ${fmt(c.mean_a, c.metric)} | ${fmt(c.mean_b, c.metric)} | ${fmt(c.improvement, c.metric)} [${fmt(c.ci[0], c.metric)}, ${fmt(c.ci[1], c.metric)}] | ${c.wins}/${c.losses}/${c.ties} | ${c.p_one_sided.toFixed(3)} |`);
  }
  return lines.join('\n');
}

/** The confirmatory agentic comparisons and the competitor (RQ3) comparisons, for a given label prefix. */
function agenticComparisons(prefix: string, tag: string): Comparison[] {
  const a = (c: string) => `${prefix}:${c}`;
  return [
    { id: `${tag}H1a`, hypothesis: 'hybrid > baseline (RC+line@1)', a: a('hybrid'), b: a('baseline'), metric: PRIMARY },
    { id: `${tag}H1b`, hypothesis: 'hybrid > embeddings (RC+line@1)', a: a('hybrid'), b: a('embeddings'), metric: PRIMARY },
    { id: `${tag}H2-tokens`, hypothesis: 'hybrid fewer tokens than baseline', a: a('hybrid'), b: a('baseline'), metric: 'tokens', lowerIsBetter: true },
    { id: `${tag}H2-cost`, hypothesis: 'hybrid cheaper than baseline', a: a('hybrid'), b: a('baseline'), metric: 'cost', lowerIsBetter: true },
    { id: `${tag}E-latency`, hypothesis: 'hybrid faster than baseline (wall)', a: a('hybrid'), b: a('baseline'), metric: 'latency', lowerIsBetter: true },
    { id: `${tag}E-turns`, hypothesis: 'hybrid fewer turns than baseline', a: a('hybrid'), b: a('baseline'), metric: 'turns', lowerIsBetter: true },
    { id: `${tag}E-emb-tokens`, hypothesis: 'embeddings fewer tokens than baseline', a: a('embeddings'), b: a('baseline'), metric: 'tokens', lowerIsBetter: true },
    { id: `${tag}RQ3-graphify-acc`, hypothesis: 'graphify vs baseline (RC+line@1)', a: a('graphify'), b: a('baseline'), metric: PRIMARY },
    { id: `${tag}RQ3-crg-acc`, hypothesis: 'crg vs baseline (RC+line@1)', a: a('crg'), b: a('baseline'), metric: PRIMARY },
    { id: `${tag}RQ3-graphify-tokens`, hypothesis: 'graphify fewer tokens than baseline', a: a('graphify'), b: a('baseline'), metric: 'tokens', lowerIsBetter: true },
    { id: `${tag}RQ3-crg-tokens`, hypothesis: 'crg fewer tokens than baseline', a: a('crg'), b: a('baseline'), metric: 'tokens', lowerIsBetter: true },
    { id: `${tag}RQ3-crg-cost`, hypothesis: 'crg cheaper than baseline', a: a('crg'), b: a('baseline'), metric: 'cost', lowerIsBetter: true },
  ];
}

export function finalReport(split: 'test' | 'dev'): string {
  const d = RUN_DIRS[split];
  const p2 = load(d.p2), p1 = load(d.p1), s2 = load(d.single2k), s8 = load(d.single8k);
  const p1r = relabelP1(p1.runs);
  const single = [...s2.runs, ...s8.runs];
  const ledger = readJsonl(abs(path.join(EXP_DIR, 'spend-ledger.jsonl')));
  const spent = ledger.reduce((a, r) => a + (r.cost_usd ?? 0), 0);
  const out: string[] = [
    `# Experiment 2: ${split === 'test' ? 'main run (test split)' : 'dev pilot'} report`,
    '',
    `Generated ${new Date().toISOString()} by \`src/agent-eval/final-report.ts\` from the run directories (no model calls). Model claude-sonnet-5-5, effort high, Claude Code restricted-oauth profile; RC+line@1 = right function and its mutated lines, top candidate.`,
    '',
    '## Run status',
    '',
    '| Run | Status | Scored runs | Excluded (not scored) | Pending |',
    '|---|---|---:|---|---:|',
    ...p2.status, ...p1.status, ...s2.status, ...s8.status,
    '',
    `Cumulative list-price spend (all stages, spend-ledger.jsonl): $${spent.toFixed(2)} over ${ledger.length} billable runs (subscription billing; Claude Code's estimate or our list recomputation, whichever is higher).`,
    '',
    '## Confirmatory family (Holm over 6; agentic tests on the p2 arm)',
    '',
    confirmatoryReport([...p2.runs, ...single]),
    '',
    '## Agentic, p2 (directed to the MCP tool when attached)',
    '',
    p2.runs.length ? report(p2.runs, 'agentic:baseline') : '_not run_',
    '',
    p2.runs.length ? comparisons(p2.runs, agenticComparisons('agentic', 'p2-')) : '',
    '',
    '## Agentic, p1 (natural tool choice; secondary)',
    '',
    p1r.length ? report(p1r, 'agentic-p1:baseline') : '_not run_',
    '',
    p1r.length ? comparisons(p1r, agenticComparisons('agentic-p1', 'p1-')) : '',
    '',
    '## Tool adoption (pre-specified secondary)',
    '',
    adoption([...p2.runs, ...p1r].filter((r) => !/:baseline$/.test(r.condition))),
    '',
    '## Single-shot (one call, no tools, one method\'s retrieved context)',
    '',
    '### 2,000-token budget', '', s2.runs.length ? report(s2.runs, 'single:none@2000') : '_not run_',
    '', '### 8,000-token budget', '', s8.runs.length ? report(s8.runs, 'single:none@8000') : '_not run_',
    '', '### Exploratory method comparisons (not confirmatory, uncorrected)', '',
    single.length ? comparisons(single, [2000, 8000].flatMap((b) => [
      { id: `X-graph-vs-emb@${b}`, hypothesis: `custom_graph > embeddings @${b}`, a: `single:custom_graph@${b}`, b: `single:embeddings@${b}`, metric: PRIMARY },
      { id: `X-graph-vs-hybrid@${b}`, hypothesis: `custom_graph > hybrid @${b}`, a: `single:custom_graph@${b}`, b: `single:hybrid@${b}`, metric: PRIMARY },
      { id: `X-hybrid-vs-bm25@${b}`, hypothesis: `hybrid > bm25 @${b}`, a: `single:hybrid@${b}`, b: `single:bm25@${b}`, metric: PRIMARY },
      { id: `X-hybrid-vs-graphify@${b}`, hypothesis: `hybrid > graphify @${b}`, a: `single:hybrid@${b}`, b: `single:graphify@${b}`, metric: PRIMARY },
      { id: `X-hybrid-vs-crg@${b}`, hypothesis: `hybrid > code_review_graph @${b}`, a: `single:hybrid@${b}`, b: `single:code_review_graph@${b}`, metric: PRIMARY },
    ] as Comparison[])) : '',
    '',
    'Repeat agreement, all conditions: ' + Object.entries(repeatAgreement([...p2.runs, ...p1r, ...single])).sort().map(([c, v]) => `${c} ${f2(v)}`).join(' · '),
  ];
  return out.join('\n') + '\n';
}

if (process.argv[1]?.endsWith('final-report.ts')) {
  const split = (arg('split', 'test') as 'test' | 'dev');
  const md = finalReport(split);
  const outFile = abs(arg('out', path.join(EXP_DIR, 'results', split === 'test' ? 'final-report.md' : 'dev-pilot-report.md'))!);
  fs.writeFileSync(outFile, md);
  console.log(md);
  console.error(`wrote ${outFile}`);
}
