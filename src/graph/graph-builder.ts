/**
 * Deterministic TypeScript-Compiler-API code graph builder.
 *
 * Pipeline: program -> declarations (pass 1) -> imports/exports/heritage/HAS_TYPE (pass 2) ->
 * framework pre-pass (roles, DI bindings, entities, routes) -> body walk (pass 3) -> sort + stats + coverage.
 */
import type { CoverageReport, GraphEdge, GraphNode, GraphStats } from './graph-schema.js';
import { createProject } from '../parser/typescript-parser.js';
import { GraphCtx, newDiagnostics, type Diagnostics, type Env, type FrameworkIndex } from '../parser/graph-context.js';
import { extractSymbols } from '../parser/symbol-extractor.js';
import { extractHasType, extractHeritage, extractImportsExports } from '../parser/structural-extractor.js';
import { FrameworkExtractor } from '../parser/framework-extractor.js';
import { walkOwners } from '../parser/body-walker.js';
import { computeCoverage } from './graph-validator.js';

export interface BuildOptions { repoRoot: string; files: string[]; tsconfigPath?: string }
export interface BuiltGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  coverage: CoverageReport;
  stats: GraphStats;
  build_ms: number;
  /** Extraction diagnostics (call-site capture log etc.); not persisted in the graph. */
  diagnostics: Diagnostics;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function computeStats(nodes: GraphNode[], edges: GraphEdge[]): GraphStats {
  const nb: Record<string, number> = {}; const eb: Record<string, number> = {}; const ev: Record<string, number> = {};
  for (const n of nodes) nb[n.type] = (nb[n.type] ?? 0) + 1;
  for (const e of edges) { eb[e.type] = (eb[e.type] ?? 0) + 1; ev[e.verification] = (ev[e.verification] ?? 0) + 1; }
  const sortKeys = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => cmp(a, b)));
  return { nodes_by_type: sortKeys(nb), edges_by_type: sortKeys(eb), edges_by_verification: sortKeys(ev) };
}

export function buildGraph(opts: BuildOptions): BuiltGraph {
  const t0 = performance.now();
  const project = createProject(opts);
  const ctx = new GraphCtx();
  const diag = newDiagnostics();
  const fwIndex: FrameworkIndex = { roles: new Map(), bindings: new Map(), entities: new Map(), implementers: new Map() };
  const env: Env = { project, ctx, diag, owners: [], heritage: new Map(), fw: fwIndex };

  const symbolPass = extractSymbols(env);
  extractImportsExports(env);
  extractHeritage(env);
  extractHasType(env, symbolPass);
  const fw = new FrameworkExtractor(env);
  fw.prepare(symbolPass);
  walkOwners(env, symbolPass, fw);
  fw.finish();

  const nodes = [...ctx.nodes.values()].sort((a, b) => cmp(a.id, b.id));
  const edges = [...ctx.edges.values()].sort((a, b) => cmp(a.id, b.id));
  const stats = computeStats(nodes, edges);
  const coverage = computeCoverage(project, { nodes, edges }, diag);
  return { nodes, edges, coverage, stats, build_ms: Math.round(performance.now() - t0), diagnostics: diag };
}
