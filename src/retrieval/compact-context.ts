/**
 * Experiment 3 prototype: compact, agent-facing rendering of a ranked symbol list.
 *
 * Experiment 2 showed that a ~4k-token code-snippet tool result is re-read on every later turn and cost more
 * tokens than it saved. This renderer returns POINTERS instead of source: for each ranked symbol its location,
 * a one-line signature and its nearest graph neighbours (callers/callees/implementations/dispatch) with
 * locations, plus the links among the returned symbols. The agent reads exact line ranges itself.
 *
 * It works on any GraphNode/GraphEdge graph (src/graph/graph-schema.ts), so it is backend-agnostic: the same
 * renderer with `relations: false` is the no-graph control (same format, same budget, no relationship lines).
 */
import type { GraphEdge, GraphNode, EdgeType } from '../graph/graph-schema.js';
import { countTokens } from '../evaluation/token-accounting.js';

const DECL: ReadonlySet<string> = new Set(['function', 'method', 'class', 'interface', 'type', 'variable', 'property']);
/** Relationship edges shown to the agent, with the verb used in both directions. */
const REL: Partial<Record<EdgeType, { out: string; in: string }>> = {
  CALLS: { out: 'calls', in: 'called by' },
  SERVICE_USES: { out: 'calls', in: 'called by' },
  CONTROLLER_CALLS: { out: 'calls', in: 'called by' },
  REPOSITORY_ACCESSES: { out: 'calls', in: 'called by' },
  ROUTES_TO: { out: 'routes to', in: 'route' },
  IMPLEMENTS: { out: 'implements', in: 'implemented by' },
  EXTENDS: { out: 'extends', in: 'extended by' },
  INJECTS_DEPENDENCY: { out: 'injects', in: 'injected into' },
  PUBLISHES_EVENT: { out: 'publishes', in: 'published by' },
  CONSUMES_EVENT: { out: 'consumes', in: 'consumed by' },
  INSTANTIATES: { out: 'creates', in: 'created by' },
};

interface Rel { other: string; type: EdgeType; dir: 'out' | 'in'; verification: string; line: number | null }

export class CompactIndex {
  readonly nodes = new Map<string, GraphNode>();
  private owner = new Map<string, string>();
  readonly rels = new Map<string, Rel[]>();
  readonly byKey = new Map<string, GraphNode>();

  constructor(nodes: GraphNode[], edges: GraphEdge[]) {
    for (const n of nodes) this.nodes.set(n.id, n);
    const parent = new Map<string, string>();
    for (const e of edges) if (e.type === 'CONTAINS') parent.set(e.dst, e.src);
    const own = (id: string): string => {
      let cur = id;
      for (let i = 0; i < 12; i++) {
        const n = this.nodes.get(cur);
        if (!n || DECL.has(n.type) || n.type === 'route' || n.type === 'event') return cur;
        const p = parent.get(cur);
        if (!p) return cur;
        cur = p;
      }
      return cur;
    };
    for (const n of nodes) {
      this.owner.set(n.id, own(n.id));
      if (DECL.has(n.type) && n.file && n.qualified_name) this.byKey.set(`${n.file}::${n.qualified_name}`, n);
    }
    const seen = new Set<string>();
    for (const e of edges) {
      if (!REL[e.type] || e.verification === 'unknown') continue;
      const a = this.owner.get(e.src) ?? e.src, b = this.owner.get(e.dst) ?? e.dst;
      const na = this.nodes.get(a), nb = this.nodes.get(b);
      if (!na || !nb || a === b || na.type === 'external_dependency' || nb.type === 'external_dependency') continue;
      const k = `${a}\0${b}\0${REL[e.type]!.out}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const push = (id: string, r: Rel) => { let l = this.rels.get(id); if (!l) this.rels.set(id, (l = [])); l.push(r); };
      push(a, { other: b, type: e.type, dir: 'out', verification: e.verification, line: e.line });
      push(b, { other: a, type: e.type, dir: 'in', verification: e.verification, line: e.line });
    }
  }

  label(id: string): string {
    const n = this.nodes.get(id);
    if (!n) return id;
    if (n.type === 'route') return `${(n.meta?.method as string) ?? ''} ${(n.meta?.path as string) ?? n.name}`.trim();
    return n.qualified_name ?? n.name;
  }
  loc(id: string): string {
    const n = this.nodes.get(id);
    return n?.file ? `${n.file}:${n.start_line ?? '?'}` : '';
  }
}

export interface CompactOptions {
  /** Hard cap on rendered tokens (proxy tokenizer, src/evaluation/token-accounting.ts). */
  maxTokens: number;
  /** Max symbols listed. */
  maxSymbols: number;
  /** Neighbours shown per direction per symbol. */
  neighbours: number;
  /** false = no-graph control: identical format without relationship lines. */
  relations: boolean;
}
export const DEFAULT_COMPACT: CompactOptions = { maxTokens: 800, maxSymbols: 10, neighbours: 3, relations: true };

export interface CompactInput { file: string; symbol: string | null; start_line: number | null; end_line: number | null; why?: string[] }
export interface CompactOutput { text: string; tokens: number; listed: string[]; mentioned: string[] }

function signatureOf(n: GraphNode | undefined): string | null {
  const s = n?.meta?.signature;
  if (typeof s !== 'string') return null;
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > 110 ? one.slice(0, 107) + '…' : one;
}

const VERIFIED = new Set(['static_verified']);

export function renderCompact(idx: CompactIndex, query: string, ranked: CompactInput[], opt: CompactOptions = DEFAULT_COMPACT): CompactOutput {
  const header = `Relevant code for: "${query.length > 80 ? query.slice(0, 77) + '…' : query}". Pointers only — read the line ranges you need.`;
  const lines: string[] = [header];
  const listed: string[] = [];
  const mentioned = new Set<string>();
  const listedIds: string[] = [];
  let used = countTokens(header);
  for (const r of ranked) {
    if (listed.length >= opt.maxSymbols) break;
    const key = r.symbol ? `${r.file}::${r.symbol}` : r.file;
    const n = r.symbol ? idx.byKey.get(key) : undefined;
    const block: string[] = [];
    const i = listed.length + 1;
    const span = r.start_line ? `${r.file}:${r.start_line}-${r.end_line ?? r.start_line}` : r.file;
    block.push(`${i}. ${r.symbol ?? '(file)'} — ${span}${n ? ` [${n.type}${n.meta?.is_async ? ', async' : ''}]` : ''}`);
    const sig = signatureOf(n);
    if (sig) block.push(`   ${sig}`);
    const ment: string[] = [];
    if (opt.relations && n) {
      const rel = idx.rels.get(n.id) ?? [];
      const inSet = (id: string) => listedIds.includes(id) || ranked.some((x) => x.symbol && idx.byKey.get(`${x.file}::${x.symbol}`)?.id === id);
      for (const dir of ['out', 'in'] as const) {
        const byVerb = new Map<string, Rel[]>();
        for (const x of rel.filter((y) => y.dir === dir)) {
          const verb = REL[x.type]![dir];
          let l = byVerb.get(verb); if (!l) byVerb.set(verb, (l = [])); l.push(x);
        }
        for (const [verb, xs] of byVerb) {
          xs.sort((a, b) => Number(inSet(b.other)) - Number(inSet(a.other)) || (idx.label(a.other) < idx.label(b.other) ? -1 : 1));
          const shown = xs.slice(0, opt.neighbours).map((x) => {
            const tag = VERIFIED.has(x.verification) ? '' : ` (${x.verification.replace('_inferred', '')})`;
            const loc = idx.loc(x.other);
            ment.push(x.other);
            return `${idx.label(x.other)}${loc ? ` ${loc}` : ''}${tag}`;
          });
          const more = xs.length > opt.neighbours ? ` +${xs.length - opt.neighbours} more` : '';
          block.push(`   ${dir === 'out' ? '→' : '←'} ${verb}: ${shown.join('; ')}${more}`);
        }
      }
    }
    const text = block.join('\n');
    const t = countTokens(text) + 1;
    if (used + t > opt.maxTokens) break;
    used += t;
    lines.push(text);
    listed.push(key);
    if (n) listedIds.push(n.id);
    for (const m of ment) { const mn = idx.nodes.get(m); if (mn?.file && mn.qualified_name) mentioned.add(`${mn.file}::${mn.qualified_name}`); }
  }
  const text = lines.join('\n');
  return { text, tokens: countTokens(text), listed, mentioned: [...mentioned] };
}
