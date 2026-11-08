/**
 * Map every method's native results onto canonical symbol keys (symbol-index.ts).
 * The same rules are applied to every method.
 *
 * Rules (in order):
 *  1. File path is normalised to repo-relative POSIX. Unknown files -> unresolved.
 *  2. If the item names a symbol, resolve the name inside that file (exact qualified
 *     name, else unique last-segment match, else line-disambiguated match).
 *  3. Else, if it has a line range, pick the canonical symbol with the highest
 *     Jaccard overlap between the item's range and the symbol span (ties -> smaller
 *     span). A single line therefore maps to its innermost enclosing declaration and
 *     a class-sized range maps to the class, not to an arbitrary method.
 *  4. Else (file only) the item counts at file level but not at symbol level.
 *  File nodes (node_type 'file'/'File') and whole-file ranges without a symbol name are file-only.
 *  Every returned item occupies a rank slot in the symbol ranking (file-only and unresolved items get
 *  placeholder keys that are never relevant), so no method gets free noise removal (harness review M3).
 *  Only the first MAX_EVAL_RESULTS items are evaluated (harness review C1).
 */
export const MAX_EVAL_RESULTS = 50;
export const PLACEHOLDER_PREFIX = '#';
import path from 'node:path';
import type { RetrievedItem, RetrievalOutput } from '../types.js';
import { SymbolIndex, type CanonicalSymbol } from './symbol-index.js';

export interface NormalisedItem {
  rank: number; // 1-based rank in the method's native list
  file: string | null;
  symbolKey: string | null;
  anchorLine: number | null;
  how: 'name' | 'lines' | 'file-only' | 'unresolved';
}

export interface NormalisedOutput {
  task_id: string;
  method: string;
  items: NormalisedItem[];
  rankedSymbols: string[]; // unique, in order
  rankedFiles: string[]; // unique, in order
  anchorLines: Map<string, number>;
  unresolved: number;
}

export function normaliseFile(repoRoot: string, f: string, index: SymbolIndex): string | null {
  if (!f) return null;
  let p = f.replace(/\\/g, '/');
  if (path.isAbsolute(p)) p = path.relative(repoRoot, p).replace(/\\/g, '/');
  p = p.replace(/^\.\//, '');
  if (index.byFile.has(p)) return p;
  return null;
}

function bestByOverlap(index: SymbolIndex, file: string, start: number, end: number): CanonicalSymbol | null {
  const syms = index.byFile.get(file) ?? [];
  let best: CanonicalSymbol | null = null;
  let bestScore = -1;
  for (const s of syms) {
    if (s.kind === 'module') continue;
    const ov = Math.min(end, s.end_line) - Math.max(start, s.start_line) + 1;
    if (ov <= 0) continue;
    const union = Math.max(end, s.end_line) - Math.min(start, s.start_line) + 1;
    const score = ov / union;
    if (score > bestScore + 1e-9 || (Math.abs(score - bestScore) <= 1e-9 && best && s.end_line - s.start_line < best.end_line - best.start_line)) {
      best = s;
      bestScore = score;
    }
  }
  return best ?? index.byKey.get(`${file}::<module>`) ?? null;
}

export function normaliseItem(index: SymbolIndex, it: RetrievedItem, rank: number): NormalisedItem {
  const file = normaliseFile(index.repoRoot, it.file, index);
  if (!file) return { rank, file: null, symbolKey: null, anchorLine: null, how: 'unresolved' };
  const line = it.start_line ?? null;
  if (it.node_type && /^file$/i.test(it.node_type)) return { rank, file, symbolKey: null, anchorLine: null, how: 'file-only' };
  if (it.symbol === '<module>') return { rank, file, symbolKey: `${file}::<module>`, anchorLine: line, how: 'name' };
  if (!it.symbol && line != null && it.end_line != null) {
    const n = index.fileLines.get(file)?.length ?? 0;
    if (line <= 1 && n > 0 && it.end_line - line + 1 >= 0.9 * n) return { rank, file, symbolKey: null, anchorLine: null, how: 'file-only' };
  }
  if (it.symbol) {
    const s = index.resolveName(file, it.symbol, line);
    if (s) return { rank, file, symbolKey: s.key, anchorLine: line ?? s.start_line, how: 'name' };
  }
  if (line != null && line > 0) {
    const end = it.end_line != null && it.end_line >= line ? it.end_line : line;
    const s = bestByOverlap(index, file, line, end);
    if (s) return { rank, file, symbolKey: s.key, anchorLine: line, how: 'lines' };
  }
  return { rank, file, symbolKey: null, anchorLine: null, how: 'file-only' };
}

export function normaliseOutput(index: SymbolIndex, out: RetrievalOutput, maxItems = MAX_EVAL_RESULTS): NormalisedOutput {
  const items = out.results.slice(0, maxItems).map((r, i) => normaliseItem(index, r, i + 1));
  const rankedSymbols: string[] = [];
  const rankedFiles: string[] = [];
  const seenS = new Set<string>();
  const seenF = new Set<string>();
  const anchorLines = new Map<string, number>();
  let unresolved = 0;
  for (const it of items) {
    if (it.how === 'unresolved') {
      unresolved++;
      rankedSymbols.push(`${PLACEHOLDER_PREFIX}unresolved:${it.rank}`); // occupies a slot, never relevant
      continue;
    }
    if (it.file && !seenF.has(it.file)) { seenF.add(it.file); rankedFiles.push(it.file); }
    const key = it.symbolKey ?? `${PLACEHOLDER_PREFIX}file:${it.file}`;
    if (!seenS.has(key)) {
      seenS.add(key);
      rankedSymbols.push(key);
      if (it.symbolKey && it.anchorLine != null) anchorLines.set(it.symbolKey, it.anchorLine);
    }
  }
  return { task_id: out.task_id, method: out.method, items, rankedSymbols, rankedFiles, anchorLines, unresolved };
}
