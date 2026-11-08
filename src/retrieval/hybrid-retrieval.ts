/**
 * Method G: hybrid retrieval = exact symbol match + BM25 (code chunks) + embeddings + graph facts,
 * fused into seed scores, then expanded/re-ranked by typed graph propagation.
 *
 *   base(s)  = wLex·bm25(s) + wSem·sem(s) + wSym·exact(s) + wFact·graphFacts(s)
 *   final(s) = base(s) + wGraph·propagated(seeds = top-k by base)
 *
 * Every weight and graph switch is configurable (ablations in src/cli/ablation.ts).
 * Signals are normalised per query: bm25/facts by the max score; embedding cosine by
 * (cos − median)/(max − median), clipped at 0.
 */
import type { Corpus, IndexStats, RetrievalBudget, RetrievalMethod, RetrievalOutput, RetrievalQuery } from '../types.js';
import { BM25Retriever } from './bm25.js';
import { EmbeddingRetriever } from './embeddings.js';
import { DEFAULT_GRAPH_CONFIG, GraphEngine, basePrior, type GraphConfig } from './graph-engine.js';
import { DEFAULT_SNIPPETS, loadOrBuildGraph, renderRanked, resetSourceCache, type RankedSymbol, type SnippetConfig } from './graph-retrieval.js';
import { extractIdentifierLikeTerms, tokenize } from './text.js';

export interface HybridConfig {
  wLex: number;
  wSem: number;
  wSym: number;
  wFact: number;
  wGraph: number;
  graph: GraphConfig;
  snippets: SnippetConfig;
  candidatePool: number; // how many top chunks per signal enter fusion
}

export const DEFAULT_HYBRID: HybridConfig = {
  wLex: 1, wSem: 1, wSym: 0.5, wFact: 0.5, wGraph: 0.6,
  graph: DEFAULT_GRAPH_CONFIG, snippets: DEFAULT_SNIPPETS, candidatePool: 200,
};

export class HybridRetriever implements RetrievalMethod {
  readonly name: string;
  private bm25 = new BM25Retriever();
  private emb = new EmbeddingRetriever();
  private engine: GraphEngine | null = null;
  private repoRoot = '';
  constructor(private cfg: HybridConfig = DEFAULT_HYBRID, name = 'hybrid') { this.name = name; }

  async prepare(corpus: Corpus): Promise<IndexStats> {
    const t0 = performance.now();
    this.repoRoot = corpus.repoRoot;
    resetSourceCache();
    const b = await this.bm25.prepare(corpus);
    const needEmb = this.cfg.wSem > 0;
    const e = needEmb ? await this.emb.prepare(corpus) : null;
    const needGraph = this.cfg.wGraph > 0 || this.cfg.wFact > 0;
    let gInfo: Record<string, unknown> = {};
    if (needGraph) {
      const g = await loadOrBuildGraph(corpus);
      this.engine = new GraphEngine(g.nodes, g.edges, this.cfg.graph);
      gInfo = { nodes: g.nodes.length, edges: g.edges.length, graph_build_ms: g.build_ms };
    }
    return {
      method: this.name, index_ms: performance.now() - t0, index_llm_tokens: 0, embedding_tokens: e?.embedding_tokens ?? null,
      details: { bm25: b.details, embeddings: e?.details ?? null, graph: gInfo, config: { ...this.cfg, graph: { ...this.cfg.graph } } },
    };
  }

  async retrieveBatch(qs: RetrievalQuery[], budget: RetrievalBudget): Promise<RetrievalOutput[]> {
    if (this.cfg.wSem > 0) this.emb.warmQueries(qs);
    const out: RetrievalOutput[] = [];
    for (const q of qs) out.push(await this.retrieve(q, budget));
    return out;
  }

  async retrieve(q: RetrievalQuery, budget: RetrievalBudget): Promise<RetrievalOutput> {
    const t0 = performance.now();
    const c = this.cfg;
    const chunks = this.bm25.chunks;
    const base = new Map<string, number>(); // symbol key -> fused base score
    const parts = new Map<string, Record<string, number>>();
    const addSig = (key: string, sig: string, v: number, w: number) => {
      if (v <= 0 || w <= 0) return;
      base.set(key, (base.get(key) ?? 0) + w * v);
      if (!parts.has(key)) parts.set(key, {});
      parts.get(key)![sig] = v;
    };
    // Lexical (BM25 over code chunks)
    if (c.wLex > 0) {
      const hits = this.bm25.index.search(tokenize(q.query), c.candidatePool);
      const max = hits[0]?.[1] ?? 1;
      for (const [i, s] of hits) addSig(chunks[i].id, 'bm25', s / max, c.wLex);
    }
    // Semantic (embeddings over the same chunks)
    if (c.wSem > 0) {
      const sc = this.emb.scoreAll(q.query);
      const sorted = [...sc].sort((a, b) => a - b);
      const med = sorted[Math.floor(sorted.length / 2)];
      const max = sorted[sorted.length - 1];
      const order = sc.map((s, i) => [i, s] as [number, number]).sort((a, b) => b[1] - a[1]).slice(0, c.candidatePool);
      for (const [i, s] of order) addSig(this.emb.chunks[i].id, 'sem', Math.max(0, (s - med) / Math.max(1e-9, max - med)), c.wSem);
    }
    // Exact symbol match (identifier-like terms in the report equal a declaration name)
    if (c.wSym > 0) {
      const ids = extractIdentifierLikeTerms(q.query).map((t) => t.toLowerCase());
      if (ids.length) for (const ch of chunks) {
        const last = ch.symbol.split('.').pop()!.toLowerCase();
        if (ids.includes(last) || ids.includes(ch.symbol.toLowerCase())) addSig(ch.id, 'symbol', 1, c.wSym);
      }
    }
    // Graph facts (typed lexical over graph-derived documents)
    const eng = this.engine;
    if (eng && c.wFact > 0) {
      for (const [id, s] of eng.factScores(q.query)) {
        const k = eng.keyOf(eng.nodes.get(id)!);
        if (k) addSig(k, 'facts', s, c.wFact);
      }
    }
    // Graph propagation from top seeds
    const final = new Map(base);
    let seedsOut: [string, number][] = [];
    const propByKey = new Map<string, ReturnType<GraphEngine['propagate']> extends Map<string, infer V> ? V : never>();
    if (eng && c.wGraph > 0) {
      const seedKeys = [...base.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, c.graph.seeds);
      const maxB = seedKeys[0]?.[1] ?? 1;
      const seeds = new Map<string, number>();
      for (const [k, s] of seedKeys) { const n = eng.byKey.get(k); if (n) seeds.set(n.id, s / maxB); }
      seedsOut = seedKeys;
      const prop = eng.propagate(seeds);
      for (const [id, p] of prop) {
        const n = eng.nodes.get(id)!;
        if (!c.graph.outputTypes.includes(n.type)) continue;
        const k = eng.keyOf(n);
        if (!k) continue;
        final.set(k, (final.get(k) ?? 0) + c.wGraph * p.score);
        propByKey.set(k, p);
      }
    }
    const chunkByKey = new Map(chunks.map((ch) => [ch.id, ch]));
    for (const [k, v] of final) {
      const node = eng?.byKey.get(k) ?? null;
      const kind = node?.type ?? chunkByKey.get(k)?.kind ?? 'module';
      const file = k.split('::')[0];
      // Without a graph only the kind/test-path prior applies (the control-flow bonus needs the graph).
      final.set(k, v * (eng ? eng.prior(kind, file, node?.id ?? null) : basePrior(c.graph, kind, file)));
    }
    const ranked: RankedSymbol[] = [...final.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, budget.maxResults)
      .map(([k, s]) => {
        const node = eng?.byKey.get(k) ?? null;
        const ch = chunkByKey.get(k);
        const file = node?.file ?? ch?.file ?? k.split('::')[0];
        const qualified = node?.qualified_name ?? ch?.symbol ?? k.split('::')[1];
        const why = Object.entries(parts.get(k) ?? {}).map(([sig, v]) => `${sig} ${v.toFixed(2)}`);
        const p = propByKey.get(k);
        const c0 = p?.contributions[0];
        if (c0 && c0.path.length && eng) {
          const last = c0.path[c0.path.length - 1];
          const from = eng.nodes.get(last.from);
          why.push(`${last.type}${last.dir === 'fwd' ? '←' : '→'} ${from?.qualified_name ?? from?.name} (${last.verification})`);
        }
        return {
          node, key: k, file, qualified: qualified === '<module>' ? '<module>' : qualified,
          start: node?.start_line ?? ch?.start_line ?? 1, end: node?.end_line ?? ch?.end_line ?? 1, score: s, why,
        };
      });
    const { context, items } = renderRanked(eng, this.repoRoot, ranked, budget, c.snippets);
    return {
      task_id: q.task_id, method: this.name, results: items, context, latency_ms: performance.now() - t0, llm_tokens: { input: 0, output: 0 },
      metadata: { seeds: seedsOut.map(([k, s]) => [k, Number(s.toFixed(3))]), query_embedding_tokens: this.emb.queryTokens?.(q.query) ?? null },
    };
  }
}
