/**
 * Method E: Code Review Graph (tirth8205/code-review-graph v2.3.9, pinned in vendor/manifest.json).
 * Build: build_or_update_graph(full_rebuild) — tree-sitter + SQLite, no LLM.
 * Query policy (default `search_expand`): semantic_search_nodes(report) -> callers_of/callees_of
 * on the top-2 callable hits, mirroring CRG's own debug_issue prompt. See research/notes/code-review-graph.md.
 *
 * CRG stores absolute paths in FTS-indexed columns, so it is run on a clone at a neutral path
 * (NEUTRAL_REPO) whose words cannot match bug-report vocabulary.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Corpus, IndexStats, RetrievalBudget, RetrievalMethod, RetrievalOutput, RetrievalQuery } from '../types.js';
import { abs } from '../config.js';
import { lastJsonLine, readOutputs, runPython, writeQueries } from './py-adapter.js';

const PY = abs('vendor/.venvs/code-review-graph/bin/python');
const SCRIPT = abs('src/competitors/py/crg_adapter.py');
export const NEUTRAL_REPO = '/tmp/cgbench/w';

export interface CrgOptions { name?: string; policy?: string; embeddings?: boolean }

export class CodeReviewGraphRetriever implements RetrievalMethod {
  readonly name: string;
  private outDir = '';
  constructor(private opts: CrgOptions = {}) {
    this.name = opts.name ?? 'code_review_graph';
  }
  async prepare(corpus: Corpus): Promise<IndexStats> {
    // Fresh clone of the benchmark commit at the neutral path.
    fs.rmSync(NEUTRAL_REPO, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(NEUTRAL_REPO), { recursive: true });
    const c = spawnSync('git', ['clone', '-q', '--no-hardlinks', corpus.repoRoot, NEUTRAL_REPO], { encoding: 'utf8' });
    if (c.status !== 0) throw new Error(c.stderr);
    spawnSync('git', ['-C', NEUTRAL_REPO, 'checkout', '-q', corpus.commit]);
    this.outDir = path.join(corpus.cacheDir, this.opts.embeddings ? 'crg-emb' : 'crg');
    fs.rmSync(this.outDir, { recursive: true, force: true });
    const args = ['build', '--repo', NEUTRAL_REPO, '--out', this.outDir];
    if (this.opts.embeddings) args.push('--embeddings');
    const r = runPython(PY, SCRIPT, args);
    const info = lastJsonLine(r.stdout);
    return {
      method: this.name, index_ms: info.build_ms, index_llm_tokens: 0, embedding_tokens: this.opts.embeddings ? null : null,
      details: { nodes: info.nodes, edges: info.edges, version: info.version, commit: info.commit, policy: this.opts.policy ?? 'search_expand (default)', embeddings: !!this.opts.embeddings, ...info.details },
    };
  }
  async retrieve(q: RetrievalQuery, budget: RetrievalBudget): Promise<RetrievalOutput> {
    return (await this.retrieveBatch([q], budget))[0];
  }
  async retrieveBatch(qs: RetrievalQuery[], _budget: RetrievalBudget): Promise<RetrievalOutput[]> {
    const qfile = writeQueries(path.join(this.outDir, 'q'), qs);
    const ofile = qfile.replace('queries-', 'out-');
    const args = ['query', '--graph', this.outDir, '--repo', NEUTRAL_REPO, '--queries', qfile, '--out', ofile];
    if (this.opts.policy) args.push('--policy', this.opts.policy);
    runPython(PY, SCRIPT, args);
    // CRG has no context budget parameter; its native output is reported as-is.
    return readOutputs(ofile, this.name).map((o) => ({ ...o, llm_tokens: { input: 0, output: 0 } }));
  }
}
