import { afterAll, describe, expect, it } from 'vitest';
import { makeIndex, lines } from './helpers.js';
import { normaliseItem, normaliseOutput } from '../../src/evaluation/normalise.js';
import { buildChunks } from '../../src/retrieval/chunker.js';
import { chunkToItem } from '../../src/retrieval/bm25.js';
import type { RetrievedItem, RetrievalOutput } from '../../src/types.js';

const F = 'nm1/a.ts';
const ctx = makeIndex({
  [F]: lines(
    /* 1 */ "import { X } from './x';",
    /* 2 */ 'export class Svc {',
    /* 3 */ '  alpha() {',
    /* 4 */ '    return 1;',
    /* 5 */ '  }',
    /* 6 */ '  beta() {',
    /* 7 */ '    return 2;',
    /* 8 */ '  }',
    /* 9 */ '  gamma() { return 3; }',
    /* 10 */ '}',
    /* 11 */ 'export function lone() {',
    /* 12 */ '  return 1;',
    /* 13 */ '}',
    /* 14 */ 'bootstrap();',
  ),
  'nm1/main.ts': lines(
    /* 1 */ "import { x } from './x';",
    /* 2 */ 'async function bootstrap() {',
    /* 3 */ '  await x();',
    /* 4 */ '  await x();',
    /* 5 */ '  await x();',
    /* 6 */ '}',
    /* 7 */ 'void bootstrap();',
  ),
});
afterAll(() => ctx.cleanup());
const it_ = (o: Partial<RetrievedItem>): RetrievedItem => ({ file: F, symbol: null, start_line: null, end_line: null, score: null, ...o });
const key = (n: string) => `${F}::${n}`;
const norm = (o: Partial<RetrievedItem>) => normaliseItem(ctx.index, it_(o), 1);

describe('normaliseItem', () => {
  it('rule 2: name resolution (qualified, unqualified, Graphify style) wins over lines', () => {
    expect(norm({ symbol: 'Svc.beta', start_line: 3, end_line: 5 })).toMatchObject({ symbolKey: key('Svc.beta'), how: 'name' });
    expect(norm({ symbol: 'beta' }).symbolKey).toBe(key('Svc.beta'));
    expect(norm({ symbol: '.beta()', start_line: 6, end_line: null }).symbolKey).toBe(key('Svc.beta'));
  });
  it('rule 2 fallthrough: unknown name falls back to lines', () => {
    expect(norm({ symbol: 'nonexistent', start_line: 4, end_line: 4 })).toMatchObject({ symbolKey: key('Svc.alpha'), how: 'lines' });
  });
  it('rule 3: single line -> innermost enclosing declaration', () => {
    expect(norm({ start_line: 4, end_line: 4 }).symbolKey).toBe(key('Svc.alpha'));
    expect(norm({ start_line: 2, end_line: 2 }).symbolKey).toBe(key('Svc')); // class header line
    expect(norm({ start_line: 12 }).symbolKey).toBe(key('lone'));
  });
  it('rule 3: end_line null (Graphify start-line-only) behaves exactly like a single line', () => {
    expect(norm({ start_line: 7, end_line: null }).symbolKey).toBe(norm({ start_line: 7, end_line: 7 }).symbolKey);
    expect(norm({ start_line: 7, end_line: null }).symbolKey).toBe(key('Svc.beta'));
  });
  it('rule 3: end_line < start_line is treated as a single line', () => {
    expect(norm({ start_line: 7, end_line: 3 }).symbolKey).toBe(key('Svc.beta'));
  });
  it('rule 3: exact method range -> that method (Jaccard 1)', () => {
    expect(norm({ start_line: 3, end_line: 5 }).symbolKey).toBe(key('Svc.alpha'));
  });
  it('rule 3: class-sized range -> the class, not an arbitrary method', () => {
    expect(norm({ start_line: 2, end_line: 10 }).symbolKey).toBe(key('Svc'));
  });
  it('rule 3: straddling range picks the highest Jaccard (hand-computed)', () => {
    // range 5-7: alpha(3-5) ov=1 union=5 -> .2 ; beta(6-8) ov=2 union=4 -> .5 ; Svc(2-10) ov=3 union=9 -> .33
    expect(norm({ start_line: 5, end_line: 7 }).symbolKey).toBe(key('Svc.beta'));
  });
  it('rule 3: a line outside any declaration maps to <module>', () => {
    expect(norm({ start_line: 1, end_line: 1 }).symbolKey).toBe(key('<module>'));
  });
  it('rule 4: file only -> no symbol, but file is kept', () => {
    expect(norm({})).toMatchObject({ file: F, symbolKey: null, how: 'file-only' });
  });
  it('rule 1: files outside the corpus are unresolved; absolute and ./ paths are normalised', () => {
    expect(norm({ file: 'package.json', start_line: 3 })).toMatchObject({ how: 'unresolved', file: null });
    expect(norm({ file: `./${F}`, start_line: 4 }).symbolKey).toBe(key('Svc.alpha'));
    expect(norm({ file: `${ctx.root}/${F}`, start_line: 4 }).symbolKey).toBe(key('Svc.alpha'));
  });
});

describe('normaliseOutput', () => {
  const out = (results: RetrievedItem[]): RetrievalOutput => ({ task_id: 't', method: 'm', results, context: '', latency_ms: 0, llm_tokens: null });
  it('dedups symbols to the first (best) rank and keeps first anchor line', () => {
    const n = normaliseOutput(ctx.index, out([it_({ start_line: 4 }), it_({ start_line: 7 }), it_({ start_line: 5 }), it_({ start_line: 12 })]));
    expect(n.rankedSymbols).toEqual([key('Svc.alpha'), key('Svc.beta'), key('lone')]);
    expect(n.anchorLines.get(key('Svc.alpha'))).toBe(4);
    expect(n.rankedFiles).toEqual([F]);
  });
  it('file-only items add to the file ranking and occupy a (never-relevant) symbol slot', () => {
    const n = normaliseOutput(ctx.index, out([it_({ file: 'nm1/main.ts' }), it_({ start_line: 4 })]));
    expect(n.rankedSymbols).toEqual(['#file:nm1/main.ts', key('Svc.alpha')]);
    expect(n.rankedFiles).toEqual(['nm1/main.ts', F]);
  });
  it('unresolved (non-corpus) items occupy top-k slots (harness fix M3)', () => {
    const n = normaliseOutput(ctx.index, out([it_({ file: 'package.json', start_line: 1 }), it_({ file: 'tsconfig.json', start_line: 1 }), it_({ start_line: 4 })]));
    expect(n.unresolved).toBe(2);
    expect(n.rankedSymbols[2]).toBe(key('Svc.alpha')); // still rank 3, as returned
  });
});

describe('known mapping problems for method-native formats', () => {
  it('FIXED (C2): a BM25/embedding <module> chunk maps to <module>', () => {
    const chunks = buildChunks(ctx.index).filter((c) => c.file === 'nm1/main.ts' && c.kind === 'module');
    expect(chunks).toHaveLength(1); // imports (line 1) + `void bootstrap();` (line 7)
    const n = normaliseItem(ctx.index, chunkToItem(chunks[0], 1), 1);
    expect(n.symbolKey).toBe('nm1/main.ts::<module>'); // actual: nm1/main.ts::bootstrap
  });
  it('FIXED (M2): a whole-file range (CRG `File` node, start 1..end N) is file-level', () => {
    const lastLine = ctx.index.fileLines.get(F)!.length - 1;
    const n = norm({ start_line: 1, end_line: lastLine });
    expect(n.symbolKey === null || n.symbolKey === key('<module>')).toBe(true); // actual: Svc
  });
  it('DOCUMENTS: Graphify file node (L1, no end) is credited to whatever declaration starts on line 1', () => {
    const c = makeIndex({ 'nm2/noimports.ts': lines('export enum FileDriver {', '  LOCAL', '}', 'export class Other {}') });
    try {
      expect(normaliseItem(c.index, { file: 'nm2/noimports.ts', symbol: null, start_line: 1, end_line: null, score: null }, 1).symbolKey).toBe('nm2/noimports.ts::FileDriver');
      expect(normaliseItem(ctx.index, { file: F, symbol: null, start_line: 1, end_line: null, score: null }, 1).symbolKey).toBe(key('<module>'));
    } finally { c.cleanup(); }
  });
  it('DOCUMENTS: Jaccard favours the smaller symbol when a rg cluster straddles a big method and a tiny neighbour', () => {
    // cluster lines 8-9 (hit in beta's closing brace line 8 and in gamma line 9): beta(6-8) ov=1 union=3 -> .33, gamma(9-9) ov=1 union=2 -> .5
    expect(norm({ start_line: 8, end_line: 9 }).symbolKey).toBe(key('Svc.gamma'));
  });
  it('multi-line properties get their own chunk; single-line properties stay in the class header (harness fix M1)', () => {
    const c = makeIndex({ 'nm3/p.ts': lines('export class D {', '  @Transform(() => 1)', '  path: string;', '  go() {}', '}') });
    try {
      const ids = new Set(buildChunks(c.index).map((x) => x.id));
      expect(c.index.byKey.has('nm3/p.ts::D.path')).toBe(true);
      expect(ids.has('nm3/p.ts::D.path')).toBe(true);
      expect(ids.has('nm3/p.ts::D.go')).toBe(true);
    } finally { c.cleanup(); }
  });
});
