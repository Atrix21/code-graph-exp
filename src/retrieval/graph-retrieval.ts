/**
 * Method F: our custom graph, used on its own.
 * Seeds: lexical match of the bug report against typed graph fact documents (no code-text BM25,
 * no embeddings). Ranking: seed relevance + propagated graph relevance (typed, confidence-weighted,
 * depth-bounded, hub-damped). Output: ranked declarations with evidence and source snippets.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Corpus, IndexStats, RetrievalBudget, RetrievalMethod, RetrievalOutput, RetrievalQuery, RetrievedItem } from '../types.js';
import type { GraphEdge, GraphNode } from '../graph/graph-schema.js';
import { countTokens } from '../evaluation/token-accounting.js';
import { DEFAULT_GRAPH_CONFIG, GraphEngine, type GraphConfig, type Propagated } from './graph-engine.js';

export interface LoadedGraph { nodes: GraphNode[]; edges: GraphEdge[]; build_ms: number; cached: boolean; hash?: string }

const graphCache = new Map<string, LoadedGraph>();

/** Build (or load the cached) custom graph for this corpus revision. */
export async function loadOrBuildGraph(corpus: Corpus): Promise<LoadedGraph> {
  const dir = path.join(corpus.cacheDir, 'custom-graph');
  const jf = path.join(dir, 'graph.json');
  const mem = graphCache.get(jf);
  if (mem) return mem;
  if (fs.existsSync(jf)) {
    const g = JSON.parse(fs.readFileSync(jf, 'utf8'));
    const lg = { nodes: g.nodes, edges: g.edges, build_ms: g.build_ms ?? 0, cached: true, hash: g.hash };
    graphCache.set(jf, lg);
    return lg;
  }
  const { buildGraph } = await import('../graph/graph-builder.js');
  const g = buildGraph({ repoRoot: corpus.repoRoot, files: corpus.files, tsconfigPath: path.join(corpus.repoRoot, 'tsconfig.json') });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(jf, JSON.stringify({ nodes: g.nodes, edges: g.edges, build_ms: g.build_ms }));
  fs.writeFileSync(path.join(dir, 'coverage.json'), JSON.stringify(g.coverage, null, 2));
  fs.writeFileSync(path.join(dir, 'stats.json'), JSON.stringify(g.stats, null, 2));
  const lg = { nodes: g.nodes, edges: g.edges, build_ms: g.build_ms, cached: false };
  graphCache.set(jf, lg);
  return lg;
}

export interface SnippetConfig { fullTop: number; maxLinesFull: number; skeletonMaxLines: number; evidence: boolean }
export const DEFAULT_SNIPPETS: SnippetConfig = { fullTop: 5, maxLinesFull: 80, skeletonMaxLines: 14, evidence: true };

export interface RankedSymbol { node: GraphNode | null; key: string; file: string; qualified: string; start: number; end: number; score: number; why: string[]; prop?: Propagated }

const lineCache = new Map<string, string[]>();
function fileLines(repoRoot: string, file: string): string[] {
  const k = repoRoot + '\0' + file;
  let l = lineCache.get(k);
  if (!l) { l = fs.readFileSync(path.join(repoRoot, file), 'utf8').split('\n'); lineCache.set(k, l); }
  return l;
}

function describePath(engine: GraphEngine, p: Propagated | undefined): string | null {
  const c = p?.contributions[0];
  if (!c || !c.path.length) return null;
  const last = c.path[c.path.length - 1];
  const prev = engine.nodes.get(last.from);
  const arrow = last.dir === 'fwd' ? `${last.type}←` : `${last.type}→`;
  return `${arrow} ${prev?.qualified_name ?? prev?.name ?? last.from} (${last.verification}${c.path.length > 1 ? `, ${c.path.length} hops from seed` : ''})`;
}

/** Render ranked symbols into native context within budget: full bodies for the top ones, control/data-flow skeletons after. */
export function renderRanked(engine: GraphEngine | null, repoRoot: string, ranked: RankedSymbol[], budget: RetrievalBudget, sn: SnippetConfig): { context: string; items: RetrievedItem[] } {
  const parts: string[] = [];
  const items: RetrievedItem[] = [];
  let used = 0;
  for (let i = 0; i < ranked.length && items.length < budget.maxResults; i++) {
    const r = ranked[i];
    const lines = fileLines(repoRoot, r.file);
    const end = Math.min(r.end, lines.length);
    let body: string;
    if (i < sn.fullTop || !engine || !r.node) {
      const b = Math.min(end, r.start + sn.maxLinesFull - 1);
      body = lines.slice(r.start - 1, b).join('\n') + (b < end ? '\n  …' : '');
    } else {
      const ev = engine.evidenceLines(r.node.id).filter((l) => l >= r.start && l <= end);
      const keep = [...new Set([r.start, r.start + 1, ...ev])].filter((l) => l <= end).sort((a, b) => a - b).slice(0, sn.skeletonMaxLines);
      const out: string[] = [];
      let prev = 0;
      for (const l of keep) {
        if (prev && l > prev + 1) out.push('  …');
        out.push(lines[l - 1]);
        prev = l;
      }
      if (prev < end) out.push('  …');
      body = out.join('\n');
    }
    const why = sn.evidence && r.why.length ? ` [${r.why.join('; ')}]` : '';
    const block = `// ${r.file}:${r.start}-${end} ${r.qualified}${why}\n${body}\n`;
    const t = countTokens(block);
    if (used + t > budget.maxContextTokens) break;
    used += t;
    parts.push(block);
    items.push({ file: r.file, symbol: r.qualified, start_line: r.start, end_line: end, score: r.score, node_type: r.node?.type ?? null, raw_id: r.node?.id ?? r.key, evidence: r.why });
  }
  return { context: parts.join('\n'), items };
}

export interface CustomGraphConfig { graph: GraphConfig; propagationWeight: number; snippets: SnippetConfig }
export const DEFAULT_CUSTOM: CustomGraphConfig = { graph: DEFAULT_GRAPH_CONFIG, propagationWeight: 0.7, snippets: DEFAULT_SNIPPETS };

export class GraphRetriever implements RetrievalMethod {
  readonly name: string;
  engine!: GraphEngine;
  private repoRoot = '';
  constructor(private cfg: CustomGraphConfig = DEFAULT_CUSTOM, name = 'custom_graph') { this.name = name; }

  async prepare(corpus: Corpus): Promise<IndexStats> {
    const t0 = performance.now();
    const g = await loadOrBuildGraph(corpus);
    this.repoRoot = corpus.repoRoot;
    this.engine = new GraphEngine(g.nodes, g.edges, this.cfg.graph);
    return {
      method: this.name, index_ms: g.cached ? g.build_ms + (performance.now() - t0) : performance.now() - t0, index_llm_tokens: 0, embedding_tokens: null,
      details: { nodes: g.nodes.length, edges: g.edges.length, graph_build_ms: g.build_ms, cached: g.cached, config: this.cfg },
    };
  }

  async retrieve(q: RetrievalQuery, budget: RetrievalBudget): Promise<RetrievalOutput> {
    const t0 = performance.now();
    const fact = this.engine.factScores(q.query);
    const seedList = [...fact.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, this.cfg.graph.seeds);
    const prop = this.engine.propagate(new Map(seedList));
    const scores = new Map<string, number>();
    for (const d of this.engine.outputDecls()) {
      const s = this.engine.prior(d.type, d.file!, d.id) * ((fact.get(d.id) ?? 0) + this.cfg.propagationWeight * (prop.get(d.id)?.score ?? 0));
      if (s > 0) scores.set(d.id, s);
    }
    const ranked: RankedSymbol[] = [...scores.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, budget.maxResults)
      .map(([id, s]) => {
        const n = this.engine.nodes.get(id)!;
        const why: string[] = [];
        if (fact.get(id)) why.push(`match ${fact.get(id)!.toFixed(2)}`);
        const d = describePath(this.engine, prop.get(id));
        if (d) why.push(d);
        return { node: n, key: this.engine.keyOf(n) ?? id, file: n.file!, qualified: n.qualified_name ?? n.name, start: n.start_line ?? 1, end: n.end_line ?? n.start_line ?? 1, score: s, why, prop: prop.get(id) };
      });
    const { context, items } = renderRanked(this.engine, this.repoRoot, ranked, budget, this.cfg.snippets);
    return {
      task_id: q.task_id, method: this.name, results: items, context, latency_ms: performance.now() - t0, llm_tokens: { input: 0, output: 0 },
      metadata: { seeds: seedList.map(([id, s]) => [this.engine.nodes.get(id)?.qualified_name, Number(s.toFixed(3))]) },
    };
  }
}
