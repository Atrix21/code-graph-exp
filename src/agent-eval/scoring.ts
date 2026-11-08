/**
 * Diagnosis scoring (automatic, no LLM judge). Applied identically to every condition and backend.
 *
 *   rc_at_1 / rc_at_3   a candidate (rank ≤ k) resolves to a root-cause symbol (canonical key, same normaliser as exp. 1)
 *   file_at_1           the top candidate's file contains a root-cause symbol
 *   line_at_1 / _at_3   the candidate's line range overlaps the mutated lines of the bug patch (± LINE_SLACK)
 *   rc_line_at_1        rc_at_1 AND line_at_1 — "found the function and pointed at the defect" (primary metric)
 *   valid               the backend returned a parseable, schema-valid diagnosis
 */
import fs from 'node:fs';
import path from 'node:path';
import { abs, type BenchmarkConfig } from '../config.js';
import { SymbolIndex } from '../evaluation/symbol-index.js';
import { normaliseItem } from '../evaluation/normalise.js';
import type { GroundTruthTask } from '../types.js';
import type { Diagnosis } from './types.js';
import { buildWorkspace } from './workspace.js';

export const LINE_SLACK = 2;
/** A candidate's line range earns line credit only if it is at most (span of the declaration containing the defect + this). */
export const RANGE_ALLOWANCE = 10;

/** Workspace prefixes an agent may report (Claude Code tools print absolute paths; CRG output is absolute). */
const WORKSPACE_PREFIX = /^(?:\/tmp\/work\/[^/]+\/app|\/workspace\/app|\/tmp\/cgbench\/w)\//;

/** Normalise a reported file: strip workspace prefixes, './', and a trailing ':line' or ':a-b' (audit F-02). */
export function normaliseCandidateFile(f: string): { file: string; line?: number; end?: number } {
  let file = (f ?? '').trim().replace(WORKSPACE_PREFIX, '').replace(/^\.\//, '');
  const m = /^(.*?\.tsx?):(\d+)(?:-(\d+))?$/.exec(file);
  if (m) return { file: m[1], line: Number(m[2]), end: m[3] ? Number(m[3]) : undefined };
  return { file };
}

/** Strip prose annotations and call syntax from a reported symbol (audit F-13). */
export function normaliseCandidateSymbol(sym: string): string {
  return (sym ?? '').trim().replace(/\s*\(.*$/s, '').replace(/\s+.*$/s, '').trim();
}

/** Symbol index of a task snapshot built from a read-only `git archive` export (safe under concurrency). */
export function snapshotIndex(cfg: BenchmarkConfig, taskId: string, tag = 'score'): SymbolIndex {
  const ws = buildWorkspace(cfg, taskId, tag);
  return new SymbolIndex(ws.dir, ws.files);
}

export interface BugLocation { file: string; lines: number[] } // line numbers in the BUGGY snapshot

/** Parse the task's unified diff: new-side line numbers of added lines (or of the deletion point for pure removals). */
export function bugLocations(cfg: BenchmarkConfig, taskId: string): BugLocation[] {
  const patch = fs.readFileSync(path.join(abs(cfg.dataset.bugs_dir), `${taskId}.patch`), 'utf8');
  const out: BugLocation[] = [];
  let file: string | null = null;
  let newLine = 0;
  let cur: BugLocation | null = null;
  let pendingDeletion = false;
  for (const l of patch.split('\n')) {
    if (l.startsWith('+++ ')) {
      file = l.slice(4).replace(/^b\//, '').trim();
      cur = { file, lines: [] };
      out.push(cur);
      continue;
    }
    if (l.startsWith('--- ') || l.startsWith('diff ') || l.startsWith('index ')) continue;
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) { newLine = Number(h[1]); pendingDeletion = false; continue; }
    if (!cur) continue;
    if (l.startsWith('+')) { cur.lines.push(newLine); newLine++; pendingDeletion = false; }
    else if (l.startsWith('-')) { if (!pendingDeletion) { cur.lines.push(newLine); pendingDeletion = true; } }
    else if (l.startsWith(' ') || l === '') { newLine++; pendingDeletion = false; }
  }
  return out.filter((b) => b.lines.length);
}

export interface DiagnosisScore {
  valid: number;
  rc_at_1: number;
  rc_at_3: number;
  file_at_1: number;
  line_at_1: number;
  line_at_3: number;
  rc_line_at_1: number;
  rc_rank: number | null;
  resolved: (string | null)[]; // canonical key per candidate
}

export function scoreDiagnosis(index: SymbolIndex, gt: GroundTruthTask, bugs: BugLocation[], d: Diagnosis | null): DiagnosisScore {
  const zero: DiagnosisScore = { valid: 0, rc_at_1: 0, rc_at_3: 0, file_at_1: 0, line_at_1: 0, line_at_3: 0, rc_line_at_1: 0, rc_rank: null, resolved: [] };
  if (!d || !Array.isArray(d.candidates) || !d.candidates.length) return zero;
  const rc = new Set(gt.root_cause_symbols);
  const rcFiles = new Set(gt.root_cause_symbols.map((k) => k.split('::')[0]));
  const cands = d.candidates.slice(0, 3).map((c) => {
    const nf = normaliseCandidateFile(c.file);
    const start = c.start_line ?? nf.line;
    return { ...c, file: nf.file, symbol: normaliseCandidateSymbol(c.symbol), start_line: start, end_line: c.end_line ?? nf.end ?? start };
  });
  const resolved = cands.map((c, i) => normaliseItem(index, {
    file: c.file, symbol: c.symbol, start_line: c.start_line ?? null, end_line: c.end_line ?? c.start_line ?? null, score: null,
  }, i + 1).symbolKey);
  const lineHit = (i: number) => {
    const c = cands[i];
    if (c.start_line == null) return false;
    const a = c.start_line, b = Math.max(c.end_line ?? c.start_line, c.start_line);
    return bugs.some((bl) => {
      if (bl.file !== c.file) return false;
      // Audit F-12: a range much wider than the defective declaration (e.g. the whole file) earns no line credit.
      const decl = index.symbolAtLine(bl.file, bl.lines[0]);
      const span = decl && decl.kind !== 'module' ? decl.end_line - decl.start_line + 1 : 40;
      if (b - a + 1 > span + RANGE_ALLOWANCE) return false;
      return bl.lines.some((x) => x >= a - LINE_SLACK && x <= b + LINE_SLACK);
    });
  };
  const rcRank = resolved.findIndex((k) => k != null && rc.has(k));
  const top = cands[0];
  return {
    valid: 1,
    rc_at_1: rcRank === 0 ? 1 : 0,
    rc_at_3: rcRank >= 0 ? 1 : 0,
    file_at_1: rcFiles.has(top.file) ? 1 : 0,
    line_at_1: lineHit(0) ? 1 : 0,
    line_at_3: cands.some((_, i) => lineHit(i)) ? 1 : 0,
    rc_line_at_1: rcRank === 0 && lineHit(0) ? 1 : 0,
    rc_rank: rcRank >= 0 ? rcRank + 1 : null,
    resolved,
  };
}

/** Lenient JSON extraction for backends that return text (structured-output backends return objects directly). */
export function parseDiagnosis(raw: unknown): { diagnosis: Diagnosis | null; error?: string } {
  let obj: any = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
    const body = fence ? fence[1] : s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1);
    try { obj = JSON.parse(body); } catch (e) { return { diagnosis: null, error: `invalid JSON: ${(e as Error).message}` }; }
  }
  if (!obj || !Array.isArray(obj.candidates) || !obj.candidates.length) return { diagnosis: null, error: 'missing candidates' };
  const candidates = obj.candidates.slice(0, 3).filter((c: any) => c && typeof c.file === 'string' && typeof c.symbol === 'string')
    .map((c: any) => ({ file: c.file, symbol: c.symbol, start_line: Number.isInteger(c.start_line) ? c.start_line : undefined, end_line: Number.isInteger(c.end_line) ? c.end_line : undefined, explanation: String(c.explanation ?? '') }));
  if (!candidates.length) return { diagnosis: null, error: 'no valid candidates' };
  return { diagnosis: { candidates, fix: obj.fix } };
}
