/**
 * Baseline A: ripgrep. Simulates the deterministic part of how an agent greps:
 *  - keyword search: content words of the bug report (stopwords removed), matched
 *    case-insensitively as stems (so "charged" finds "charge", "retryCharge");
 *  - symbol search: identifier-like terms (camelCase, snake_case, quoted strings,
 *    dotted names, paths) matched verbatim with a weight boost, plus a definition boost
 *    when the line declares that identifier;
 *  - file and line retrieval: hits within 3 lines are merged into one cluster; clusters
 *    are ranked by the IDF-weighted number of distinct terms they contain.
 * One `rg --json` invocation per query over exactly the corpus files.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { stemmer } from 'stemmer';
import type { Corpus, IndexStats, RetrievalBudget, RetrievalMethod, RetrievalOutput, RetrievalQuery, RetrievedItem } from '../types.js';
import { ENGLISH_STOPWORDS, CODE_STOPWORDS, extractIdentifierLikeTerms } from './text.js';
import { countTokens } from '../evaluation/token-accounting.js';

export interface RipgrepOptions {
  clusterGap: number;
  identifierWeight: number;
  definitionBoost: number;
  maxTerms: number;
}

const DEFAULTS: RipgrepOptions = { clusterGap: 3, identifierWeight: 2, definitionBoost: 1.5, maxTerms: 16 };

interface Term { label: string; re: RegExp; rgPattern: string; weight: number; identifier: boolean }

function escapeRe(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function extractTerms(query: string, opts: RipgrepOptions = DEFAULTS): Term[] {
  const terms = new Map<string, Term>();
  for (const id of extractIdentifierLikeTerms(query)) {
    const label = id;
    const pat = escapeRe(id);
    terms.set(`id:${label.toLowerCase()}`, { label, re: new RegExp(pat, 'i'), rgPattern: pat, weight: opts.identifierWeight, identifier: true });
  }
  const words = query.toLowerCase().match(/[a-z][a-z0-9]+/g) ?? [];
  for (const w of words) {
    if (w.length < 3 || ENGLISH_STOPWORDS.has(w) || CODE_STOPWORDS.has(w)) continue;
    const st = stemmer(w);
    const key = `w:${st}`;
    if (terms.has(key)) continue;
    const pat = st.length >= 4 ? escapeRe(st) : `\\b${escapeRe(w)}\\b`;
    terms.set(key, { label: st, re: new RegExp(pat, 'i'), rgPattern: pat, weight: 1, identifier: false });
  }
  return [...terms.values()].slice(0, opts.maxTerms);
}

const RG_PATH: string = createRequire(import.meta.url)('@vscode/ripgrep').rgPath;

interface LineHit { file: string; line: number; text: string; terms: Set<number> }

export class RipgrepRetriever implements RetrievalMethod {
  readonly name = 'ripgrep';
  private corpus!: Corpus;
  constructor(private opts: RipgrepOptions = DEFAULTS, private rgBin = process.env.RG_BIN ?? RG_PATH) {}

  async prepare(corpus: Corpus): Promise<IndexStats> {
    this.corpus = corpus;
    const v = spawnSync(this.rgBin, ['--version'], { encoding: 'utf8' });
    return { method: this.name, index_ms: 0, index_llm_tokens: 0, embedding_tokens: null, details: { rg_version: v.stdout.split('\n')[0], options: this.opts, note: 'no index; searches files at query time' } };
  }

  async retrieve(q: RetrievalQuery, budget: RetrievalBudget): Promise<RetrievalOutput> {
    const t0 = performance.now();
    const terms = extractTerms(q.query, this.opts);
    if (!terms.length) return { task_id: q.task_id, method: this.name, results: [], context: '', latency_ms: performance.now() - t0, llm_tokens: { input: 0, output: 0 } };
    const args = ['--json', '-i', '-n', '--no-config', ...terms.flatMap((t) => ['-e', t.rgPattern]), '--', ...this.corpus.files];
    const r = spawnSync(this.rgBin, args, { cwd: this.corpus.repoRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    const hits: LineHit[] = [];
    for (const l of r.stdout.split('\n')) {
      if (!l) continue;
      const ev = JSON.parse(l);
      if (ev.type !== 'match') continue;
      const text: string = (ev.data.lines.text ?? '').replace(/\n$/, '');
      const set = new Set<number>();
      terms.forEach((t, i) => { if (t.re.test(text)) set.add(i); });
      if (set.size) hits.push({ file: ev.data.path.text, line: ev.data.line_number, text, terms: set });
    }
    // document frequency per term (files)
    const N = this.corpus.files.length;
    const df = terms.map((_, i) => new Set(hits.filter((h) => h.terms.has(i)).map((h) => h.file)).size);
    const idf = df.map((d) => Math.log(1 + N / Math.max(1, d)));
    // cluster
    hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    const clusters: { file: string; lines: LineHit[] }[] = [];
    for (const h of hits) {
      const c = clusters[clusters.length - 1];
      if (c && c.file === h.file && h.line - c.lines[c.lines.length - 1].line <= this.opts.clusterGap) c.lines.push(h);
      else clusters.push({ file: h.file, lines: [h] });
    }
    const scored = clusters.map((c) => {
      const ts = new Set<number>();
      let defBoost = 1;
      for (const h of c.lines) {
        h.terms.forEach((i) => ts.add(i));
        for (const i of h.terms) {
          const t = terms[i];
          if (t.identifier && new RegExp(`(class|function|interface|enum|type|const|let|async)\\s+${t.rgPattern}\\b|^\\s*(public |private |protected |async |static )*${t.rgPattern}\\s*\\(`, 'i').test(h.text)) defBoost = this.opts.definitionBoost;
        }
      }
      let s = 0;
      ts.forEach((i) => (s += idf[i] * terms[i].weight));
      return { c, score: s * defBoost, nterms: ts.size };
    });
    scored.sort((a, b) => b.score - a.score || a.c.file.localeCompare(b.c.file) || a.c.lines[0].line - b.c.lines[0].line);

    const results: RetrievedItem[] = [];
    const parts: string[] = [];
    let used = 0;
    for (const s of scored) {
      if (results.length >= budget.maxResults) break;
      const block = s.c.lines.map((h) => `${h.file}:${h.line}:${h.text.length > 200 ? h.text.slice(0, 200) + '…' : h.text}`).join('\n') + '\n';
      const t = countTokens(block);
      if (used + t > budget.maxContextTokens) break;
      used += t;
      parts.push(block);
      results.push({
        file: s.c.file, symbol: null, start_line: s.c.lines[0].line, end_line: s.c.lines[s.c.lines.length - 1].line,
        score: s.score, node_type: 'line-cluster', raw_id: `${s.c.file}:${s.c.lines[0].line}`,
        evidence: { terms: [...new Set(s.c.lines.flatMap((h) => [...h.terms].map((i) => terms[i].label)))] },
      });
    }
    return {
      task_id: q.task_id, method: this.name, results, context: parts.join(''), latency_ms: performance.now() - t0,
      llm_tokens: { input: 0, output: 0 }, metadata: { terms: terms.map((t) => t.label), total_line_hits: hits.length, clusters: clusters.length },
    };
  }
}
