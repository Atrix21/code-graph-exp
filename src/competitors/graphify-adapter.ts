/**
 * Method D: Graphify (Graphify-Labs/graphify v0.9.104, pinned in vendor/manifest.json).
 * Build: `graphify extract <repo> --code-only` (tree-sitter, no LLM).
 * Query: the real `graphify query "<bug report>"` CLI (lexical seeding + BFS depth 2).
 * See research/notes/graphify.md.
 */
import path from 'node:path';
import type { Corpus, IndexStats, RetrievalBudget, RetrievalMethod, RetrievalOutput, RetrievalQuery } from '../types.js';
import { abs } from '../config.js';
import { lastJsonLine, readOutputs, runPython, writeQueries } from './py-adapter.js';

const PY = abs('vendor/.venvs/graphify/bin/python');
const SCRIPT = abs('src/competitors/py/graphify_adapter.py');
const ENV = { GRAPHIFY_NO_AUTO_REFRESH: '1', GRAPHIFY_QUERY_LOG_DISABLE: '1', GRAPHIFY_BACKEND: 'none' };

export interface GraphifyOptions { name?: string; budget?: 'shared' | number; depth?: number; mode?: 'bfs' | 'dfs' }

export class GraphifyRetriever implements RetrievalMethod {
  readonly name: string;
  private outDir = '';
  private repo = '';
  constructor(private opts: GraphifyOptions = {}) {
    this.name = opts.name ?? 'graphify';
  }
  async prepare(corpus: Corpus): Promise<IndexStats> {
    this.repo = corpus.repoRoot;
    this.outDir = path.join(corpus.cacheDir, 'graphify');
    const t0 = performance.now();
    const r = runPython(PY, SCRIPT, ['build', '--repo', this.repo, '--out', this.outDir], ENV);
    const info = lastJsonLine(r.stdout);
    return {
      method: this.name, index_ms: info.build_ms ?? performance.now() - t0, index_llm_tokens: 0, embedding_tokens: null,
      details: { nodes: info.nodes, edges: info.edges, version: info.graphify_version, commit: info.commit, edge_relations: info.edge_relations, edge_confidence: info.edge_confidence },
    };
  }
  async retrieve(q: RetrievalQuery, budget: RetrievalBudget): Promise<RetrievalOutput> {
    return (await this.retrieveBatch([q], budget))[0];
  }
  async retrieveBatch(qs: RetrievalQuery[], budget: RetrievalBudget): Promise<RetrievalOutput[]> {
    const qfile = writeQueries(path.join(this.outDir, 'q'), qs);
    const ofile = qfile.replace('queries-', 'out-');
    const b = this.opts.budget === undefined || this.opts.budget === 'shared' ? budget.maxContextTokens : this.opts.budget;
    const args = ['query', '--graph', this.outDir, '--repo', this.repo, '--queries', qfile, '--out', ofile, '--budget', String(b), '--mode', this.opts.mode ?? 'bfs'];
    if (this.opts.depth) args.push('--depth', String(this.opts.depth));
    runPython(PY, SCRIPT, args, ENV);
    return readOutputs(ofile, this.name).map((o) => ({ ...o, llm_tokens: { input: 0, output: 0 }, metadata: { ...o.metadata, graphify_budget: b } }));
  }
}
