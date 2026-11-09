/**
 * Graph validation: coverage by INDEPENDENT syntactic counting (own AST walks, no shared extractor logic),
 * structural integrity checks, and a reproducibility check (build twice -> identical SHA-256).
 */
import ts from 'typescript';
import crypto from 'node:crypto';
import type { CoverageReport, GraphEdge, GraphNode } from './graph-schema.js';
import type { Project } from '../parser/typescript-parser.js';
import type { Diagnostics } from '../parser/graph-context.js';
import { buildGraph, type BuildOptions } from './graph-builder.js';

// ------------------------------------------------------------ canonical hash

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x === undefined ? null : x)).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

/**
 * SHA-256 of canonicalJson({ nodes, edges }) with both arrays sorted by id.
 * Streamed element by element so that graphs whose canonical JSON exceeds V8's maximum string length
 * (~512 MB; e.g. a 10k-file repository) can be hashed. The bytes hashed are identical to
 * canonicalJson({ edges, nodes }) (keys sorted: "edges" < "nodes"), so existing hashes are unchanged.
 */
export function graphHash(nodes: GraphNode[], edges: GraphEdge[]): string {
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const n = [...nodes].sort(byId);
  const e = [...edges].sort(byId);
  const h = crypto.createHash('sha256');
  const arr = (xs: unknown[]) => { for (let i = 0; i < xs.length; i++) { if (i) h.update(','); h.update(canonicalJson(xs[i] === undefined ? null : xs[i])); } };
  h.update('{"edges":['); arr(e); h.update('],"nodes":['); arr(n); h.update(']}');
  return h.digest('hex');
}

// ------------------------------------------------------------ independent syntactic facts

function nm(n: ts.Node & { name?: ts.Node }, sf: ts.SourceFile): string | null {
  const x = n.name;
  if (!x) return null;
  if (ts.isIdentifier(x) || ts.isStringLiteral(x) || ts.isNumericLiteral(x) || ts.isPrivateIdentifier(x)) return x.text;
  if (ts.isComputedPropertyName(x)) return `[${x.expression.getText(sf)}]`;
  return x.getText(sf);
}

/** Unique declared-function keys (`file::Qualified`) found by a fresh walk of the file's declarations. */
export function declaredFunctionKeys(file: string, sf: ts.SourceFile): { keys: Set<string>; nested: number } {
  const keys = new Set<string>();
  const isFn = (e: ts.Node | undefined) => !!e && (ts.isArrowFunction(e) || ts.isFunctionExpression(e));
  const members = (cls: ts.ClassLikeDeclaration | ts.InterfaceDeclaration, cn: string) => {
    for (const m of cls.members) {
      if (ts.isConstructorDeclaration(m)) keys.add(`${file}::${cn}.constructor`);
      else if (ts.isMethodDeclaration(m) || ts.isMethodSignature(m) || ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)) {
        const n = nm(m, sf); if (n) keys.add(`${file}::${cn}.${n}`);
      } else if (ts.isPropertyDeclaration(m) && isFn(m.initializer)) {
        const n = nm(m, sf); if (n) keys.add(`${file}::${cn}.${n}`);
      }
    }
  };
  const top = (s: ts.Node) => {
    if (ts.isFunctionDeclaration(s)) keys.add(`${file}::${s.name?.text ?? 'default'}`);
    else if (ts.isClassDeclaration(s)) members(s, s.name?.text ?? 'default');
    else if (ts.isInterfaceDeclaration(s)) members(s, s.name.text);
    else if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        if (isFn(d.initializer)) keys.add(`${file}::${d.name.text}`);
        if (d.initializer && ts.isClassExpression(d.initializer)) members(d.initializer, d.name.text);
      }
    } else if (ts.isModuleDeclaration(s) && s.body && ts.isModuleBlock(s.body)) s.body.statements.forEach(top);
  };
  sf.statements.forEach(top);
  // all function-like nodes anywhere (to report how many are anonymous/nested closures)
  let all = 0;
  const walk = (n: ts.Node) => { if (ts.isFunctionLike(n) && !ts.isFunctionTypeNode(n) && !ts.isMethodSignature(n)) all++; ts.forEachChild(n, walk); };
  walk(sf);
  return { keys, nested: all };
}

function calleePos(sf: ts.SourceFile, c: ts.CallExpression | ts.NewExpression): string {
  let e: ts.Expression = c.expression;
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
  const n: ts.Node = ts.isPropertyAccessExpression(e) ? e.name : ts.isElementAccessExpression(e) ? e.argumentExpression : e;
  const p = sf.getLineAndCharacterOfPosition(n.getStart(sf));
  return `${p.line + 1}:${p.character + 1}`;
}

interface SyntacticFacts {
  calls: Map<string, number>; // `${file}:${line}:${col}` -> multiplicity
  imports: { file: string; spec: string; line: number }[];
  tagged: number; requires: number; generators: number;
}

function countFacts(project: Project): SyntacticFacts {
  const f: SyntacticFacts = { calls: new Map(), imports: [], tagged: 0, requires: 0, generators: 0 };
  for (const rel of project.files) {
    const sf = project.sourceFiles.get(rel);
    if (!sf) continue;
    const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const walk = (n: ts.Node) => {
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const a = n.arguments[0];
          if (a && ts.isStringLiteralLike(a)) f.imports.push({ file: rel, spec: a.text, line: line(n) });
        } else {
          const k = `${rel}:${calleePos(sf, n)}`;
          f.calls.set(k, (f.calls.get(k) ?? 0) + 1);
          if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'require') f.requires++;
        }
      } else if (ts.isTaggedTemplateExpression(n)) f.tagged++;
      else if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isFunctionExpression(n)) && n.asteriskToken) f.generators++;
      if (ts.isImportDeclaration(n) && ts.isStringLiteralLike(n.moduleSpecifier)) f.imports.push({ file: rel, spec: n.moduleSpecifier.text, line: line(n) });
      else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteralLike(n.moduleReference.expression)) f.imports.push({ file: rel, spec: n.moduleReference.expression.text, line: line(n) });
      else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteralLike(n.moduleSpecifier)) f.imports.push({ file: rel, spec: n.moduleSpecifier.text, line: line(n) });
      ts.forEachChild(n, walk);
    };
    walk(sf);
  }
  return f;
}

// ------------------------------------------------------------ coverage

export function computeCoverage(project: Project, graph: { nodes: GraphNode[]; edges: GraphEdge[] }, diag: Diagnostics): CoverageReport {
  const notes: string[] = [];
  const failedFiles = new Set(project.parseFailures.map((p) => p.file));
  const parsed = [...project.sourceFiles.keys()].filter((f) => !failedFiles.has(f)).length;

  // functions
  const declared = new Set<string>();
  let closures = 0;
  for (const [rel, sf] of project.sourceFiles) {
    const r = declaredFunctionKeys(rel, sf);
    r.keys.forEach((k) => declared.add(k));
    closures += r.nested;
  }
  const graphFnKeys = new Set<string>();
  for (const n of graph.nodes) if ((n.type === 'function' || n.type === 'method') && typeof n.meta.symbol_key === 'string') graphFnKeys.add(n.meta.symbol_key);
  let extracted = 0;
  const missingFns: string[] = [];
  for (const k of declared) { if (graphFnKeys.has(k)) extracted++; else missingFns.push(k); }
  const extraFns = [...graphFnKeys].filter((k) => !declared.has(k)).length;
  if (missingFns.length) notes.push(`declared functions missing from graph (first 10): ${missingFns.slice(0, 10).join(', ')}`);
  if (extraFns) notes.push(`${extraFns} graph function/method nodes were not found by the independent syntactic count`);
  notes.push(`${closures} function-like AST nodes in total (incl. anonymous callbacks/closures); only named declarations are graph nodes, closures are attributed to their enclosing declaration`);

  // calls
  const facts = countFacts(project);
  let detected = 0;
  for (const c of facts.calls.values()) detected += c;
  const logged = new Map<string, typeof diag.callSites>();
  for (const r of diag.callSites) {
    const k = `${r.file}:${r.line}:${r.col}`;
    const a = logged.get(k) ?? []; a.push(r); logged.set(k, a);
  }
  let internal = 0, external = 0, unresolved = 0, missing = 0, stdlib = 0, local = 0, noNode = 0, mismatch = 0;
  const edgeLocs = new Map<string, number>();
  for (const e of graph.edges) {
    if ((e.type === 'CALLS' || e.type === 'INSTANTIATES') && e.file && e.line != null) {
      const k = `${e.file}:${e.line}:${e.col}`;
      edgeLocs.set(k, (edgeLocs.get(k) ?? 0) + 1);
    }
  }
  for (const [k, mult] of facts.calls) {
    const recs = logged.get(k) ?? [];
    for (let i = 0; i < mult; i++) {
      const r = recs[i];
      if (!r) { missing++; unresolved++; continue; }
      if (r.status === 'internal') { internal++; if (r.category === 'local_closure') local++; if (r.category === 'no_node') noNode++; }
      else if (r.status === 'external') external++;
      else if (r.status === 'stdlib') { external++; stdlib++; }
      else unresolved++;
      if (r.edge && !edgeLocs.has(k)) mismatch++;
    }
  }
  if (missing) notes.push(`${missing} syntactic call sites were not visited by the extractor (counted as unresolved)`);
  if (mismatch) notes.push(`${mismatch} call sites logged with an edge but no CALLS/INSTANTIATES edge found at that location`);
  notes.push(`call split: ${internal - local - noNode} internal with graph edge, ${local} internal local closures (no edge), ${noNode} internal without a graph node (e.g. object-literal methods), ${external - stdlib} external-package, ${stdlib} TypeScript-stdlib (counted as resolved, no edge emitted), ${unresolved} unresolved`);
  const decoCalls = diag.callSites.filter((c) => c.kind === 'decorator').length;
  notes.push(`${decoCalls} of the detected call sites are decorator calls (e.g. @Injectable(), @ApiProperty())`);
  if (facts.requires) notes.push(`${facts.requires} require() calls counted as ordinary calls`);

  // imports
  const recByKey = new Map<string, Diagnostics['importRecords'][number]>();
  for (const r of diag.importRecords) recByKey.set(`${r.file}|${r.specifier}|${r.line}`, r);
  let resolvedImports = 0;
  const unresolvedImports: string[] = [];
  const importEdges = new Set<string>();
  for (const e of graph.edges) if (e.type === 'IMPORTS' && e.verification === 'static_verified') importEdges.add(`${e.file}|${e.meta.specifier}|${e.line}`);
  for (const im of facts.imports) {
    const key = `${im.file}|${im.spec}|${im.line}`;
    const r = recByKey.get(key);
    if (r && r.resolved && (r.target === null || importEdges.has(key))) resolvedImports++;
    else unresolvedImports.push(`${im.file}: ${im.spec}`);
  }
  unresolvedImports.sort();

  const unsupported: Record<string, number> = { ...diag.unsupported };
  if (facts.tagged) unsupported.tagged_template_calls = facts.tagged;
  if (facts.generators) unsupported.generator_functions = facts.generators;
  if (diag.unresolvedReferenceSamples.length) notes.push(`unresolved reference samples: ${diag.unresolvedReferenceSamples.slice(0, 8).join('; ')}`);
  for (const n of diag.notes) notes.push(n);
  for (const issue of validateIntegrity(graph)) notes.push(`INTEGRITY: ${issue}`);

  return {
    eligible_files: project.files.length,
    parsed_files: parsed,
    parse_failures: project.parseFailures,
    declared_functions: declared.size,
    extracted_functions: extracted,
    detected_calls: detected,
    resolved_calls_internal: internal,
    resolved_calls_external: external,
    unresolved_calls: unresolved,
    detected_imports: facts.imports.length,
    resolved_imports: resolvedImports,
    unresolved_imports: unresolvedImports,
    unresolved_references: diag.unresolvedReferences,
    unsupported_syntax: Object.fromEntries(Object.entries(unsupported).sort(([a], [b]) => (a < b ? -1 : 1))),
    notes,
  };
}

/** Structural integrity: unique ids, no dangling edge endpoints, valid confidences. */
export function validateIntegrity(graph: { nodes: GraphNode[]; edges: GraphEdge[] }): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const n of graph.nodes) { if (ids.has(n.id)) issues.push(`duplicate node id ${n.id}`); ids.add(n.id); }
  const eids = new Set<string>();
  let dangling = 0;
  for (const e of graph.edges) {
    if (eids.has(e.id)) issues.push(`duplicate edge id ${e.id}`);
    eids.add(e.id);
    if (!ids.has(e.src) || !ids.has(e.dst)) { if (dangling++ < 5) issues.push(`dangling edge ${e.type} ${e.src} -> ${e.dst}`); }
    if (e.confidence < 0 || e.confidence > 1) issues.push(`bad confidence on ${e.id}`);
    if (e.verification === 'static_verified' && e.extraction.includes('infer')) issues.push(`static_verified edge with inferred extraction ${e.id}`);
  }
  if (dangling > 5) issues.push(`... ${dangling} dangling edges total`);
  return issues;
}

// ------------------------------------------------------------ reproducibility

export function checkReproducibility(opts: BuildOptions): { identical: boolean; hash_a: string; hash_b: string; nodes: number; edges: number; build_ms: [number, number] } {
  const a = buildGraph(opts);
  const b = buildGraph(opts);
  const ha = graphHash(a.nodes, a.edges);
  const hb = graphHash(b.nodes, b.edges);
  return { identical: ha === hb, hash_a: ha, hash_b: hb, nodes: a.nodes.length, edges: a.edges.length, build_ms: [a.build_ms, b.build_ms] };
}
