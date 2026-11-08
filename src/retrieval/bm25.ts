/**
 * Okapi BM25 over declaration-level chunks (baseline B) — also reused as the lexical
 * signal inside graph seeding and hybrid retrieval.
 */
import type { Corpus, IndexStats, RetrievalBudget, RetrievalMethod, RetrievalOutput, RetrievalQuery, RetrievedItem } from '../types.js';
import { SymbolIndex } from '../evaluation/symbol-index.js';
import { buildChunks, renderChunk, type Chunk } from './chunker.js';
import { tokenize } from './text.js';
import { countTokens } from '../evaluation/token-accounting.js';

export class BM25Index<D> {
  private df = new Map<string, number>();
  private tf: Map<string, number>[] = [];
  private len: number[] = [];
  private avgdl = 0;
  constructor(readonly docs: D[], toTokens: (d: D) => string[], readonly k1 = 1.2, readonly b = 0.75) {
    for (const d of docs) {
      const toks = toTokens(d);
      const m = new Map<string, number>();
      for (const t of toks) m.set(t, (m.get(t) ?? 0) + 1);
      this.tf.push(m);
      this.len.push(toks.length);
      for (const t of m.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
    this.avgdl = this.len.reduce((a, b2) => a + b2, 0) / Math.max(1, this.len.length);
  }
  idf(t: string): number {
    const n = this.df.get(t) ?? 0;
    const N = this.docs.length;
    return Math.log(1 + (N - n + 0.5) / (n + 0.5));
  }
  /** Returns [docIndex, score] sorted by score desc, ties by index (deterministic). */
  search(queryTokens: string[], limit = Infinity): [number, number][] {
    const q = new Map<string, number>();
    for (const t of queryTokens) q.set(t, (q.get(t) ?? 0) + 1);
    const scores: [number, number][] = [];
    for (let i = 0; i < this.docs.length; i++) {
      const tf = this.tf[i];
      let s = 0;
      for (const [t, qf] of q) {
        const f = tf.get(t);
        if (!f) continue;
        s += qf * this.idf(t) * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * this.len[i]) / this.avgdl)));
      }
      if (s > 0) scores.push([i, s]);
    }
    scores.sort((a, b2) => b2[1] - a[1] || a[0] - b2[0]);
    return scores.slice(0, limit);
  }
}

export function chunkTokens(c: Chunk): string[] {
  return tokenize(c.text);
}

/** Assemble native context: render items in rank order until the token budget is exhausted. */
export function renderChunksWithinBudget(chunks: Chunk[], budget: RetrievalBudget): { context: string; included: number } {
  let used = 0;
  const parts: string[] = [];
  let included = 0;
  for (const c of chunks.slice(0, budget.maxResults)) {
    const r = renderChunk(c);
    const t = countTokens(r);
    if (used + t > budget.maxContextTokens) break;
    parts.push(r);
    used += t;
    included++;
  }
  return { context: parts.join('\n'), included };
}

export function chunkToItem(c: Chunk, score: number): RetrievedItem {
  return { file: c.file, symbol: c.symbol === '<module>' ? null : c.symbol, start_line: c.start_line, end_line: c.end_line, score, node_type: c.kind, raw_id: c.id };
}

export class BM25Retriever implements RetrievalMethod {
  readonly name = 'bm25';
  chunks: Chunk[] = [];
  index!: BM25Index<Chunk>;
  async prepare(corpus: Corpus): Promise<IndexStats> {
    const t0 = performance.now();
    const symIndex = new SymbolIndex(corpus.repoRoot, corpus.files);
    this.chunks = buildChunks(symIndex);
    this.index = new BM25Index(this.chunks, chunkTokens);
    return { method: this.name, index_ms: performance.now() - t0, index_llm_tokens: 0, embedding_tokens: null, details: { chunks: this.chunks.length, k1: 1.2, b: 0.75 } };
  }
  async retrieve(q: RetrievalQuery, budget: RetrievalBudget): Promise<RetrievalOutput> {
    const t0 = performance.now();
    const hits = this.index.search(tokenize(q.query), budget.maxResults);
    const ranked = hits.map(([i]) => this.chunks[i]);
    // Results are limited to what is actually shown in the native context.
    const { context, included } = renderChunksWithinBudget(ranked, budget);
    const results = hits.slice(0, included).map(([i, s]) => chunkToItem(this.chunks[i], s));
    return { task_id: q.task_id, method: this.name, results, context, latency_ms: performance.now() - t0, llm_tokens: { input: 0, output: 0 } };
  }
}
