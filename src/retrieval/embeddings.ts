/**
 * Baseline C: dense retrieval over the same declaration-level chunks as BM25.
 * Model: Qwen/Qwen3-Embedding-0.6B (sentence-transformers, fp16 on CUDA if available),
 * fixed query instruction (scripts/embeddings/embed.py). Vectors are cached by content hash.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Corpus, IndexStats, RetrievalBudget, RetrievalMethod, RetrievalOutput, RetrievalQuery } from '../types.js';
import { SymbolIndex } from '../evaluation/symbol-index.js';
import { buildChunks, type Chunk } from './chunker.js';
import { chunkToItem, renderChunksWithinBudget } from './bm25.js';
import { abs, loadConfig } from '../config.js';

export interface EmbedItem { id: string; text: string; kind: 'query' | 'doc' }

export class Embedder {
  readonly model: string;
  readonly revision: string;
  private python: string;
  private script: string;
  private batch: number;
  private maxSeq: number;
  constructor(private cacheDir: string) {
    const cfg = loadConfig();
    this.model = cfg.embeddings.model;
    this.revision = cfg.embeddings.revision;
    this.python = abs(cfg.embeddings.python);
    this.script = abs(cfg.embeddings.script);
    this.batch = cfg.embeddings.batch;
    this.maxSeq = cfg.embeddings.max_seq;
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }
  private key(it: EmbedItem) {
    return crypto.createHash('sha256').update(`${this.model}@${this.revision}\0${this.maxSeq}\0${it.kind}\0${it.text}`).digest('hex');
  }
  /** Returns vectors (and model-token counts) for items, computing missing ones in one subprocess call. */
  embed(items: EmbedItem[]): { vectors: Map<string, Float32Array>; tokens: Map<string, number>; computed: number } {
    const cacheFile = path.join(this.cacheDir, 'vectors.jsonl');
    const cache = new Map<string, { v: number[]; t: number }>();
    if (fs.existsSync(cacheFile)) {
      for (const l of fs.readFileSync(cacheFile, 'utf8').split('\n')) {
        if (!l) continue;
        const d = JSON.parse(l);
        cache.set(d.k, { v: d.v, t: d.t });
      }
    }
    const missing = items.filter((it) => !cache.has(this.key(it)));
    const uniq = new Map<string, EmbedItem>();
    for (const it of missing) uniq.set(this.key(it), { ...it, id: this.key(it) });
    if (uniq.size) {
      const tmpIn = path.join(this.cacheDir, `in-${process.pid}.jsonl`);
      const tmpOut = path.join(this.cacheDir, `out-${process.pid}.jsonl`);
      fs.writeFileSync(tmpIn, [...uniq.values()].map((x) => JSON.stringify(x)).join('\n') + '\n');
      const r = spawnSync(this.python, [this.script, '--model', this.model, '--in', tmpIn, '--out', tmpOut, '--batch', String(this.batch), '--max-seq', String(this.maxSeq), '--revision', this.revision], {
        encoding: 'utf8', env: { ...process.env, HF_HUB_OFFLINE: '1', TOKENIZERS_PARALLELISM: 'false' }, maxBuffer: 64 * 1024 * 1024,
      });
      if (r.status !== 0) throw new Error(`embedding failed: ${r.stderr}`);
      const add: string[] = [];
      for (const l of fs.readFileSync(tmpOut, 'utf8').split('\n')) {
        if (!l) continue;
        const d = JSON.parse(l);
        cache.set(d.id, { v: d.vector, t: d.tokens });
        add.push(JSON.stringify({ k: d.id, v: d.vector, t: d.tokens }));
      }
      fs.appendFileSync(cacheFile, add.join('\n') + '\n');
      fs.rmSync(tmpIn); fs.rmSync(tmpOut);
    }
    const vectors = new Map<string, Float32Array>();
    const tokens = new Map<string, number>();
    for (const it of items) {
      const c = cache.get(this.key(it))!;
      vectors.set(it.id, Float32Array.from(c.v));
      tokens.set(it.id, c.t);
    }
    return { vectors, tokens, computed: uniq.size };
  }
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export class EmbeddingRetriever implements RetrievalMethod {
  readonly name = 'embeddings';
  chunks: Chunk[] = [];
  vecs: Float32Array[] = [];
  embedder!: Embedder;
  private queryCache = new Map<string, { v: Float32Array; tokens: number }>();

  async prepare(corpus: Corpus): Promise<IndexStats> {
    const t0 = performance.now();
    this.embedder = new Embedder(path.join(path.dirname(corpus.cacheDir), 'embeddings')); // content-hash cache shared across snapshots
    const symIndex = new SymbolIndex(corpus.repoRoot, corpus.files);
    this.chunks = buildChunks(symIndex);
    const { vectors, tokens, computed } = this.embedder.embed(this.chunks.map((c) => ({ id: c.id + '#' + c.start_line, text: c.text, kind: 'doc' as const })));
    this.vecs = this.chunks.map((c) => vectors.get(c.id + '#' + c.start_line)!);
    const embTokens = [...tokens.values()].reduce((a, b) => a + b, 0);
    return {
      method: this.name, index_ms: performance.now() - t0, index_llm_tokens: 0, embedding_tokens: embTokens,
      details: { model: this.embedder.model, revision: this.embedder.revision, chunks: this.chunks.length, newly_embedded: computed, note: 'index_ms includes model load unless vectors were cached' },
    };
  }

  /** Embed all queries in one model invocation (avoids per-query model start-up). */
  warmQueries(qs: RetrievalQuery[]) {
    const { vectors, tokens } = this.embedder.embed(qs.map((q) => ({ id: q.task_id, text: q.query, kind: 'query' as const })));
    for (const q of qs) this.queryCache.set(q.query, { v: vectors.get(q.task_id)!, tokens: tokens.get(q.task_id)! });
  }

  scoreAll(query: string): number[] {
    if (!this.queryCache.has(query)) this.warmQueries([{ task_id: '_q', query }]);
    const qv = this.queryCache.get(query)!.v;
    return this.vecs.map((v) => dot(qv, v));
  }

  queryTokens(query: string): number | null {
    return this.queryCache.get(query)?.tokens ?? null;
  }

  async retrieve(q: RetrievalQuery, budget: RetrievalBudget): Promise<RetrievalOutput> {
    const t0 = performance.now();
    const scores = this.scoreAll(q.query);
    const order = scores.map((s, i) => [i, s] as [number, number]).sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, budget.maxResults);
    const { context, included } = renderChunksWithinBudget(order.map(([i]) => this.chunks[i]), budget);
    const results = order.slice(0, included).map(([i, s]) => chunkToItem(this.chunks[i], s));
    return {
      task_id: q.task_id, method: this.name, results, context, latency_ms: performance.now() - t0, llm_tokens: { input: 0, output: 0 },
      metadata: { query_embedding_tokens: this.queryTokens(q.query), note: 'latency excludes query embedding (batched up-front)' },
    };
  }

  async retrieveBatch(qs: RetrievalQuery[], budget: RetrievalBudget): Promise<RetrievalOutput[]> {
    const t0 = performance.now();
    this.warmQueries(qs);
    const embedMs = (performance.now() - t0) / Math.max(1, qs.length);
    const outs: RetrievalOutput[] = [];
    for (const q of qs) {
      const o = await this.retrieve(q, budget);
      o.metadata = { ...o.metadata, amortised_query_embed_ms: embedMs };
      o.latency_ms += embedMs;
      outs.push(o);
    }
    return outs;
  }
}
