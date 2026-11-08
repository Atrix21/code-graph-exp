/**
 * Graph engine shared by custom_graph (F) and hybrid (G) retrieval.
 *
 *  1. Symbol projection: intra-function nodes (conditions, branches, returns, loops, handlers,
 *     parameters) are attributed to their owning declaration, so edges become
 *     declaration→declaration (e.g. condition-CHECKS→User.status becomes method-CHECKS→User.status).
 *  2. Fact documents: for each declaration we build a typed bag of words from graph facts
 *     (name, path, route, condition text, thrown errors, properties read/written, callees, config keys).
 *     Each fact is tagged with the edge family it comes from, so ablations can remove it.
 *  3. Propagation: bounded best-path propagation from seeds over typed edges, with per-type
 *     forward/backward weights, edge confidence, per-hop decay and hub damping.
 */
import type { GraphEdge, GraphNode, EdgeFamily, EdgeType, NodeType } from '../graph/graph-schema.js';
import { CONTROL_FLOW_EDGES, edgeFamily } from '../graph/graph-schema.js';
import { BM25Index } from './bm25.js';
import { tokenize } from './text.js';

export const DECL_TYPES: NodeType[] = ['class', 'function', 'method', 'interface', 'type', 'variable', 'property'];
const NO_TRANSIT = new Set<NodeType>(['external_dependency', 'repository']);
const INTRA_TYPES: NodeType[] = ['condition', 'branch', 'return', 'loop', 'exception_handler', 'parameter'];

export type FactKind = 'name' | 'path' | 'route' | 'control_flow' | 'data_flow' | 'execution' | 'application' | 'structural';

export interface EdgeWeight { fwd: number; back: number }

export interface GraphConfig {
  depth: number;
  seeds: number;
  maxVisited: number;
  decay: number;
  hubPenalty: number; // exponent on log2(degree) for intermediate nodes
  useConfidence: boolean;
  aggregation: 'max' | 'sum';
  disabledFamilies: EdgeFamily[];
  disableControlFlow: boolean;
  edgeWeights: Partial<Record<EdgeType, EdgeWeight>>;
  factWeights: Record<FactKind, number>; // token repetition factor in fact documents (0 = off)
  outputTypes: NodeType[];
}

export const DEFAULT_EDGE_WEIGHTS: Record<EdgeType, EdgeWeight> = {
  // execution
  CALLS: { fwd: 0.8, back: 0.7 },
  RECURSES_TO: { fwd: 0, back: 0 },
  RETURNS: { fwd: 0, back: 0 },
  THROWS: { fwd: 0.15, back: 0.15 },
  CATCHES: { fwd: 0, back: 0 },
  BRANCHES_TO: { fwd: 0, back: 0 },
  CHECKS: { fwd: 0.5, back: 0.4 },
  LOOPS: { fwd: 0, back: 0 },
  // data flow
  READS: { fwd: 0.45, back: 0.35 },
  WRITES: { fwd: 0.5, back: 0.45 },
  MUTATES: { fwd: 0.5, back: 0.45 },
  PASSES_TO: { fwd: 0.7, back: 0.6 },
  RECEIVES_FROM: { fwd: 0.7, back: 0.6 },
  RETURNS_VALUE_TO: { fwd: 0.6, back: 0.7 },
  // structural
  CONTAINS: { fwd: 0.25, back: 0.35 },
  IMPORTS: { fwd: 0.1, back: 0.1 },
  EXPORTS: { fwd: 0.05, back: 0.05 },
  EXTENDS: { fwd: 0.5, back: 0.5 },
  IMPLEMENTS: { fwd: 0.5, back: 0.5 },
  INSTANTIATES: { fwd: 0.35, back: 0.25 },
  REFERENCES: { fwd: 0.25, back: 0.2 },
  DEFINES: { fwd: 0.2, back: 0.2 },
  HAS_TYPE: { fwd: 0.2, back: 0.15 },
  // application
  ROUTES_TO: { fwd: 0.9, back: 0.9 },
  CONTROLLER_CALLS: { fwd: 0.85, back: 0.75 },
  SERVICE_USES: { fwd: 0.8, back: 0.7 },
  REPOSITORY_ACCESSES: { fwd: 0.8, back: 0.7 },
  QUERIES_DATABASE: { fwd: 0.3, back: 0.2 },
  PUBLISHES_EVENT: { fwd: 0.6, back: 0.6 },
  CONSUMES_EVENT: { fwd: 0.6, back: 0.6 },
  INJECTS_DEPENDENCY: { fwd: 0.15, back: 0.1 },
  CALLS_EXTERNAL_API: { fwd: 0.3, back: 0.2 },
};

export const DEFAULT_GRAPH_CONFIG: GraphConfig = {
  depth: 2,
  seeds: 8,
  maxVisited: 3000,
  decay: 0.85,
  hubPenalty: 1,
  useConfidence: true,
  aggregation: 'sum',
  disabledFamilies: [],
  disableControlFlow: false,
  edgeWeights: {},
  factWeights: { name: 3, path: 1, route: 2, control_flow: 1, data_flow: 1, execution: 1, application: 1, structural: 0 },
  outputTypes: ['function', 'method', 'class', 'variable', 'property', 'interface', 'type'],
};

interface PEdge { to: string; type: EdgeType; w: number; conf: number; dir: 'fwd' | 'back'; ev: string | null; line: number | null; verification: string }

export interface PathStep { from: string; to: string; type: EdgeType; dir: 'fwd' | 'back'; verification: string; line: number | null }
export interface Propagated { score: number; contributions: { seed: string; score: number; path: PathStep[] }[] }

export class GraphEngine {
  readonly nodes = new Map<string, GraphNode>();
  readonly owner = new Map<string, string>(); // node id -> owning declaration id (self for decls)
  readonly adj = new Map<string, PEdge[]>();
  readonly degree = new Map<string, number>();
  readonly decls: GraphNode[] = [];
  readonly byKey = new Map<string, GraphNode>(); // symbol key -> decl node
  facts = new Map<string, { kind: FactKind; text: string }[]>();
  factIndex: BM25Index<GraphNode> | null = null;

  constructor(nodes: GraphNode[], readonly edges: GraphEdge[], readonly cfg: GraphConfig) {
    for (const n of nodes) this.nodes.set(n.id, n);
    // Owner map from CONTAINS chains.
    const parent = new Map<string, string>();
    for (const e of edges) if (e.type === 'CONTAINS') parent.set(e.dst, e.src);
    const resolveOwner = (id: string): string => {
      let cur = id;
      for (let i = 0; i < 12; i++) {
        const n = this.nodes.get(cur);
        if (!n) return id;
        if (!INTRA_TYPES.includes(n.type)) return cur;
        const p = parent.get(cur);
        if (!p) return cur;
        cur = p;
      }
      return cur;
    };
    for (const n of nodes) this.owner.set(n.id, resolveOwner(n.id));
    for (const n of nodes) {
      if (DECL_TYPES.includes(n.type)) {
        this.decls.push(n);
        const key = (n.meta?.symbol_key as string | undefined) ?? (n.file && n.qualified_name ? `${n.file}::${n.qualified_name}` : null);
        if (key) this.byKey.set(key, n);
      }
    }
    this.buildAdjacency();
    this.buildFacts();
  }

  private edgeAllowed(t: EdgeType): boolean {
    if (this.cfg.disableControlFlow && CONTROL_FLOW_EDGES.includes(t)) return false;
    return !this.cfg.disabledFamilies.includes(edgeFamily(t));
  }

  private weight(t: EdgeType): EdgeWeight {
    return this.cfg.edgeWeights[t] ?? DEFAULT_EDGE_WEIGHTS[t];
  }

  private buildAdjacency() {
    const best = new Map<string, PEdge>(); // dedupe parallel projected edges: keep strongest
    for (const e of this.edges) {
      if (!this.edgeAllowed(e.type)) continue;
      const a = this.owner.get(e.src) ?? e.src;
      const b = this.owner.get(e.dst) ?? e.dst;
      if (a === b) continue;
      const w = this.weight(e.type);
      const conf = this.cfg.useConfidence ? e.confidence : 1;
      for (const [from, to, dir, ww] of [[a, b, 'fwd', w.fwd], [b, a, 'back', w.back]] as const) {
        if (ww <= 0) continue;
        const k = `${from}\0${to}`;
        const cand: PEdge = { to, type: e.type, w: ww, conf, dir, ev: e.evidence, line: e.line, verification: e.verification };
        const prev = best.get(k);
        if (!prev || cand.w * cand.conf > prev.w * prev.conf) best.set(k, cand);
      }
    }
    for (const [k, pe] of best) {
      const from = k.split('\0')[0];
      if (!this.adj.has(from)) this.adj.set(from, []);
      this.adj.get(from)!.push(pe);
    }
    for (const [from, list] of this.adj) {
      list.sort((x, y) => (x.to < y.to ? -1 : x.to > y.to ? 1 : 0));
      this.degree.set(from, list.length);
    }
  }

  /** Typed fact documents per declaration, derived only from graph facts. */
  private buildFacts() {
    const add = (id: string, kind: FactKind, text: string | null | undefined) => {
      if (!text) return;
      const o = this.owner.get(id) ?? id;
      if (!this.facts.has(o)) this.facts.set(o, []);
      this.facts.get(o)!.push({ kind, text });
    };
    for (const d of this.decls) {
      add(d.id, 'name', d.qualified_name ?? d.name);
      add(d.id, 'path', d.file);
    }
    for (const n of this.nodes.values()) {
      if (n.type === 'condition') add(n.id, 'control_flow', (n.meta?.text as string) ?? n.name);
    }
    for (const e of this.edges) {
      const fam = edgeFamily(e.type);
      const dst = this.nodes.get(e.dst);
      const dstName = dst ? dst.qualified_name ?? dst.name : null;
      if (e.type === 'ROUTES_TO') { const r = this.nodes.get(e.src); add(e.dst, 'route', r?.name ?? (r?.meta?.path as string)); continue; }
      if (e.type === 'THROWS') { add(e.src, 'control_flow', `${dstName ?? ''} ${e.evidence ?? ''}`); continue; }
      if (e.type === 'CHECKS' || e.type === 'RETURNS') { add(e.src, 'control_flow', e.type === 'CHECKS' ? dstName : e.evidence); continue; }
      if (fam === 'data_flow') { add(e.src, 'data_flow', `${dstName ?? ''} ${(e.meta?.key as string) ?? ''}`); continue; }
      if (e.type === 'CALLS') { add(e.src, 'execution', dstName ?? (e.meta?.member as string)); continue; }
      if (fam === 'application') { add(e.src, 'application', dstName); continue; }
      if (fam === 'structural' && (e.type === 'REFERENCES' || e.type === 'INSTANTIATES' || e.type === 'HAS_TYPE')) add(e.src, 'structural', dstName);
    }
  }

  factFamilyEnabled(kind: FactKind): boolean {
    if (kind === 'control_flow') return !this.cfg.disableControlFlow && !this.cfg.disabledFamilies.includes('execution');
    if (kind === 'data_flow') return !this.cfg.disabledFamilies.includes('data_flow');
    if (kind === 'application' || kind === 'route') return !this.cfg.disabledFamilies.includes('application');
    if (kind === 'execution') return !this.cfg.disabledFamilies.includes('execution');
    if (kind === 'structural') return !this.cfg.disabledFamilies.includes('structural');
    return true;
  }

  factTokens(id: string): string[] {
    const out: string[] = [];
    for (const f of this.facts.get(id) ?? []) {
      const w = this.cfg.factWeights[f.kind] ?? 0;
      if (w <= 0 || !this.factFamilyEnabled(f.kind)) continue;
      const toks = tokenize(f.text);
      for (let i = 0; i < w; i++) out.push(...toks);
    }
    return out;
  }

  outputDecls(): GraphNode[] {
    return this.decls.filter((d) => this.cfg.outputTypes.includes(d.type) && d.file && d.start_line != null && !d.meta?.synthetic);
  }

  /** Lexical seed scores over fact documents (0..1 normalised). */
  factScores(query: string): Map<string, number> {
    if (!this.factIndex) this.factIndex = new BM25Index(this.outputDecls(), (d) => this.factTokens(d.id));
    const hits = this.factIndex.search(tokenize(query), 200);
    const max = hits[0]?.[1] ?? 1;
    const out = new Map<string, number>();
    for (const [i, s] of hits) out.set(this.factIndex.docs[i].id, s / max);
    return out;
  }

  /** Bounded best-path propagation from seeds. Returns per-node aggregated graph relevance. */
  propagate(seeds: Map<string, number>): Map<string, Propagated> {
    const result = new Map<string, Propagated>();
    const hub = (id: string) => Math.pow(Math.max(1, Math.log2(1 + (this.degree.get(id) ?? 1))), this.cfg.hubPenalty);
    for (const [seed, s0] of seeds) {
      const best = new Map<string, { score: number; path: PathStep[] }>();
      best.set(seed, { score: s0, path: [] });
      let frontier = [seed];
      let visited = 0;
      for (let depth = 1; depth <= this.cfg.depth && frontier.length; depth++) {
        const next = new Set<string>();
        for (const u of frontier) {
          const bu = best.get(u)!;
          // External packages / stdlib / config-less synthetic hubs are reachable but never expanded:
          // they would otherwise connect unrelated project code through e.g. '@nestjs/common'.
          if (u !== seed && NO_TRANSIT.has(this.nodes.get(u)?.type as NodeType)) continue;
          const damp = u === seed ? 1 : hub(u);
          for (const e of this.adj.get(u) ?? []) {
            const sc = (bu.score * e.w * e.conf * this.cfg.decay) / damp;
            const prev = best.get(e.to);
            if (!prev || sc > prev.score + 1e-12) {
              best.set(e.to, { score: sc, path: [...bu.path, { from: u, to: e.to, type: e.type, dir: e.dir, verification: e.verification, line: e.line }] });
              next.add(e.to);
            }
            if (++visited > this.cfg.maxVisited) break;
          }
        }
        frontier = [...next].sort();
      }
      for (const [n, b] of best) {
        if (n === seed) continue;
        let r = result.get(n);
        if (!r) result.set(n, (r = { score: 0, contributions: [] }));
        r.contributions.push({ seed, score: b.score, path: b.path });
      }
    }
    for (const r of result.values()) {
      r.contributions.sort((a, b) => b.score - a.score || (a.seed < b.seed ? -1 : 1));
      r.score = this.cfg.aggregation === 'max' ? r.contributions[0].score : r.contributions.slice(0, 3).reduce((a, c) => a + c.score, 0);
    }
    return result;
  }

  keyOf(n: GraphNode): string | null {
    return (n.meta?.symbol_key as string | undefined) ?? (n.file && n.qualified_name ? `${n.file}::${n.qualified_name}` : null);
  }

  /** Evidence lines owned by a declaration (conditions, calls, throws, writes, returns) for skeleton snippets. */
  evidenceLines(id: string): number[] {
    const lines = new Set<number>();
    for (const e of this.edges) {
      if ((this.owner.get(e.src) ?? e.src) !== id || e.line == null) continue;
      if (['CALLS', 'THROWS', 'CHECKS', 'RETURNS', 'WRITES', 'MUTATES', 'CATCHES', 'BRANCHES_TO', 'QUERIES_DATABASE', 'CALLS_EXTERNAL_API'].includes(e.type)) lines.add(e.line);
    }
    return [...lines].sort((a, b) => a - b);
  }
}
