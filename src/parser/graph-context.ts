/**
 * Shared mutable state for graph construction: node/edge registries, id helpers,
 * effect emission (function-level + branch-level + guard metadata) and diagnostics.
 */
import ts from 'typescript';
import crypto from 'node:crypto';
import type { EdgeType, GraphEdge, GraphNode, NodeType, Verification } from '../graph/graph-schema.js';
import type { Project, Span } from './typescript-parser.js';
import { lineColOfPos, shortText, startOf } from './typescript-parser.js';

export interface EdgeInput {
  type: EdgeType;
  src: string;
  dst: string;
  file?: string | null;
  line?: number | null;
  col?: number | null;
  extraction: string;
  confidence: number;
  verification: Verification;
  evidence?: string | null;
  meta?: Record<string, unknown>;
  /** Extra discriminator for the edge id when two distinct edges share type/src/dst/location. */
  key?: string;
}

export const UNRESOLVED_ID = 'external_dependency:<unresolved>';
export const STDLIB_ID = 'external_dependency:<stdlib>';

export class GraphCtx {
  readonly nodes = new Map<string, GraphNode>();
  readonly edges = new Map<string, GraphEdge>();

  hasNode(id: string): boolean { return this.nodes.has(id); }

  /** Adds a node (first write wins, except spans/meta of overloads are merged by the caller). */
  addNode(n: GraphNode): GraphNode {
    const prev = this.nodes.get(n.id);
    if (prev) return prev;
    this.nodes.set(n.id, n);
    return n;
  }

  node(
    type: NodeType, id: string, name: string, qualified: string | null, file: string | null,
    span: Span | null, meta: Record<string, unknown>,
  ): GraphNode {
    return this.addNode({
      id, type, name, qualified_name: qualified, file,
      start_line: span?.start_line ?? null, end_line: span?.end_line ?? null,
      start_col: span?.start_col ?? null, end_col: span?.end_col ?? null, meta,
    });
  }

  /** Node id that does not collide with an existing node of a different kind (deterministic suffix). */
  uniqueId(base: string, kind: string): string {
    const ex = this.nodes.get(base);
    if (!ex || ex.meta.kind === kind) return base;
    let i = 2;
    while (this.nodes.has(`${base}~${i}`) && this.nodes.get(`${base}~${i}`)!.meta.kind !== kind) i++;
    return `${base}~${i}`;
  }

  edge(e: EdgeInput): GraphEdge | null {
    const h = crypto.createHash('sha1')
      .update(`${e.src}|${e.dst}|${e.file ?? ''}|${e.line ?? ''}|${e.col ?? ''}|${e.key ?? ''}`)
      .digest('hex').slice(0, 16);
    const id = `edge:${e.type}:${h}`;
    if (this.edges.has(id)) return this.edges.get(id)!;
    const out: GraphEdge = {
      id, type: e.type, src: e.src, dst: e.dst,
      file: e.file ?? null, line: e.line ?? null, col: e.col ?? null,
      extraction: e.extraction, confidence: round(e.confidence), verification: e.verification,
      evidence: e.evidence ?? null, meta: e.meta ?? {},
    };
    this.edges.set(id, out);
    return out;
  }

  ensureExternal(pkg: string, extra: Record<string, unknown> = {}): string {
    const id = `external_dependency:${pkg}`;
    if (!this.nodes.has(id)) {
      this.nodes.set(id, {
        id, type: 'external_dependency', name: pkg, qualified_name: null, file: null,
        start_line: null, end_line: null, start_col: null, end_col: null,
        meta: { package: pkg, kind: 'npm_package', ...extra },
      });
    }
    return id;
  }

  ensureSpecial(id: string, name: string, kind: string): string {
    if (!this.nodes.has(id)) {
      this.nodes.set(id, {
        id, type: 'external_dependency', name, qualified_name: null, file: null,
        start_line: null, end_line: null, start_col: null, end_col: null,
        meta: { kind, synthetic: true },
      });
    }
    return id;
  }
}

export function round(n: number): number { return Math.round(n * 1000) / 1000; }

// ---- ownership & walk state

export interface Owner {
  id: string;
  type: NodeType;
  /** Qualified name within the file (`Class.member`, `fn`, or `<module>`). */
  qualified: string;
  file: string;
  sf: ts.SourceFile;
  /** The declaration node (class/method/function/variable/property) or SourceFile for <module>. */
  decl: ts.Node;
  /** Function-like node with parameters/body, if the owner is executable. */
  fn: ts.FunctionLikeDeclaration | ts.MethodSignature | ts.ConstructorDeclaration | null;
  className: string | null;
  isConstructor: boolean;
  symbolKey: string;
}

export interface BranchRef { conditionId: string; branchId: string; polarity: string }

export interface WalkState {
  owner: Owner;
  branchStack: BranchRef[];
  tryStack: string[]; // exception_handler ids whose try-block we are in
  handlerStack: string[]; // exception_handler ids whose catch-block we are in
  callbackDepth: number;
}

export function currentGuard(st: WalkState): BranchRef | null {
  return st.branchStack.length ? st.branchStack[st.branchStack.length - 1] : null;
}

/** Per-call-site capture record used by the validator's coverage comparison. */
export interface CallSiteRecord {
  file: string; line: number; col: number;
  kind: 'call' | 'new' | 'decorator' | 'super';
  status: 'internal' | 'external' | 'stdlib' | 'unresolved';
  category: string;
  edge: boolean;
}

export interface Diagnostics {
  callSites: CallSiteRecord[];
  unresolvedReferences: number;
  unresolvedReferenceSamples: string[];
  unsupported: Record<string, number>;
  importRecords: { file: string; specifier: string; kind: string; line: number; resolved: boolean; target: string | null }[];
  notes: string[];
}

export interface Env {
  project: Project;
  ctx: GraphCtx;
  diag: Diagnostics;
  /** Filled by symbol-extractor */
  owners: Owner[];
  /** class node id -> directly extended/implemented project type node ids */
  heritage: Map<string, { extends: string[]; implements: string[] }>;
  /** Filled by framework-extractor */
  fw: FrameworkIndex;
}

export interface FrameworkIndex {
  /** class node id -> role */
  roles: Map<string, string>;
  /** abstract/token class id -> bound implementation class ids (provide/useClass) */
  bindings: Map<string, { impl: string; file: string; line: number }[]>;
  /** class node id -> db_entity node id */
  entities: Map<string, string>;
  /** all concrete implementers (transitive) of a class/interface id */
  implementers: Map<string, Set<string>>;
}

export function newDiagnostics(): Diagnostics {
  return { callSites: [], unresolvedReferences: 0, unresolvedReferenceSamples: [], unsupported: {}, importRecords: [], notes: [] };
}

export function bump(rec: Record<string, number>, key: string, n = 1) { rec[key] = (rec[key] ?? 0) + n; }

/** Emit an effect edge from the owner (function level) and, when inside a branch, from the branch node too. */
export function emitEffect(
  env: Env, st: WalkState,
  e: Omit<EdgeInput, 'src'> & { node?: ts.Node },
  opts: { branch?: boolean } = {},
): void {
  const { ctx } = env;
  const owner = st.owner;
  const guard = currentGuard(st);
  const meta: Record<string, unknown> = { ...(e.meta ?? {}) };
  if (guard) meta.guard = { condition_id: guard.conditionId, polarity: guard.polarity };
  if (st.callbackDepth > 0) meta.in_callback = true;
  if (st.tryStack.length) meta.caught_by = st.tryStack[st.tryStack.length - 1];
  if (st.handlerStack.length) meta.in_handler = st.handlerStack[st.handlerStack.length - 1];
  ctx.edge({ ...e, src: owner.id, file: e.file ?? owner.file, meta });
  if (guard && opts.branch !== false) {
    const bmeta = { ...(e.meta ?? {}), owner: owner.id, guard: { condition_id: guard.conditionId, polarity: guard.polarity } };
    ctx.edge({ ...e, src: guard.branchId, file: e.file ?? owner.file, meta: bmeta });
  }
}

export function locOf(sf: ts.SourceFile, node: ts.Node, file: string) {
  const p = startOf(sf, node);
  return { file, line: p.line, col: p.col };
}

export function locOfPos(sf: ts.SourceFile, pos: number, file: string) {
  const p = lineColOfPos(sf, pos);
  return { file, line: p.line, col: p.col };
}

export function evidenceOf(sf: ts.SourceFile, node: ts.Node, max = 140): string {
  return shortText(node.getText(sf), max);
}
