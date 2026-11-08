/**
 * Structural edges: IMPORTS, EXPORTS, EXTENDS, IMPLEMENTS, HAS_TYPE (pass 2) and the per-owner
 * REFERENCES collector used while walking bodies.
 */
import ts from 'typescript';
import { builtinModules } from 'node:module';
import type { Env, WalkState } from './graph-context.js';
import { STDLIB_ID, UNRESOLVED_ID, bump } from './graph-context.js';
import { externalMeta, externalPackageOf, packageOfSpecifier, stripParens } from './call-extractor.js';
import { aliasTarget, declInfo, symbolKey, type DeclInfo, type SymbolPass } from './symbol-extractor.js';
import { lineColOfPos, shortText, startOf } from './typescript-parser.js';

const BUILTINS = new Set(builtinModules.map((m) => m.replace(/^node:/, '')));

interface Resolved { kind: 'file' | 'external' | 'none' | 'unresolved'; file?: string; pkg?: string; builtin?: boolean }

function resolveSpecifier(env: Env, spec: string, sf: ts.SourceFile, specNode: ts.Node | undefined, cache: Map<string, Resolved>): Resolved {
  const key = `${sf.fileName}\0${spec}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const { project } = env;
  let out: Resolved = { kind: 'unresolved' };
  const r = ts.resolveModuleName(spec, sf.fileName, project.options, ts.sys).resolvedModule;
  if (r) {
    const rel = project.relOf(r.resolvedFileName);
    if (rel) out = { kind: 'file', file: rel };
    else if (r.isExternalLibraryImport || r.resolvedFileName.includes('/node_modules/')) out = { kind: 'external', pkg: packageOfSpecifier(spec) };
    else out = { kind: 'none' }; // resolved to a non-corpus project file (e.g. .json / .d.ts)
  } else if (BUILTINS.has(spec.replace(/^node:/, ''))) {
    out = { kind: 'external', pkg: packageOfSpecifier(spec), builtin: true };
  } else if (specNode) {
    try {
      if (project.checker.getSymbolAtLocation(specNode)) out = { kind: 'external', pkg: packageOfSpecifier(spec) }; // ambient module
    } catch { /* unresolved */ }
  }
  cache.set(key, out);
  return out;
}

export function extractImportsExports(env: Env): void {
  const { project, ctx, diag } = env;
  const cache = new Map<string, Resolved>();
  for (const rel of project.files) {
    const sf = project.sourceFiles.get(rel);
    if (!sf) continue;
    const fileId = `file:${rel}`;
    const modKey = symbolKey(rel, '<module>');

    const handleModuleRef = (spec: string, specNode: ts.Node, node: ts.Node, kind: string, names: string[], typeOnly: boolean) => {
      const p = startOf(sf, node);
      const r = resolveSpecifier(env, spec, sf, specNode, cache);
      const importId = `import:${rel}#${spec}@L${p.line}:C${p.col}`;
      let dst: string | null = null;
      let verification: 'static_verified' | 'unknown' = 'static_verified';
      let conf = 1;
      if (r.kind === 'file') dst = `file:${r.file}`;
      else if (r.kind === 'external') dst = ctx.ensureExternal(r.pkg!, { ...externalMeta(env, r.pkg!), ...(r.builtin ? { builtin: true } : {}) });
      else if (r.kind === 'unresolved') {
        dst = ctx.ensureExternal(packageOfSpecifier(spec), { ...externalMeta(env, packageOfSpecifier(spec)), unresolved_module: true });
        verification = 'unknown'; conf = 0.5;
      }
      const resolved = r.kind !== 'unresolved';
      diag.importRecords.push({ file: rel, specifier: spec, kind, line: p.line, resolved, target: dst });
      ctx.node('import', importId, spec, spec, rel, { start_line: p.line, end_line: sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1, start_col: p.col, end_col: 1 }, {
        symbol_key: modKey, specifier: spec, names, type_only: typeOnly, kind, resolved, target: dst,
        relative: spec.startsWith('.'),
      });
      ctx.edge({ type: 'CONTAINS', src: fileId, dst: importId, file: rel, line: p.line, col: p.col, extraction: 'ts-syntax', confidence: 1, verification: 'static_verified', key: 'contains' });
      if (dst) {
        ctx.edge({
          type: 'IMPORTS', src: fileId, dst, file: rel, line: p.line, col: p.col, extraction: 'ts-module-resolution', confidence: conf, verification,
          evidence: shortText(node.getText(sf), 140), meta: { specifier: spec, names, type_only: typeOnly, import_node: importId, kind },
        });
      }
      return { r, dst, importId };
    };

    const exportNode = (node: ts.Node, name: string, meta: Record<string, unknown>): string => {
      const p = startOf(sf, node);
      const id = `export:${rel}#${name}@L${p.line}:C${p.col}`;
      ctx.node('export', id, name, name, rel, { start_line: p.line, end_line: sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1, start_col: p.col, end_col: 1 }, { symbol_key: modKey, ...meta });
      ctx.edge({ type: 'CONTAINS', src: fileId, dst: id, file: rel, line: p.line, col: p.col, extraction: 'ts-syntax', confidence: 1, verification: 'static_verified', key: 'contains' });
      return id;
    };
    const exportsEdge = (dst: string, node: ts.Node, meta: Record<string, unknown>) => {
      const p = startOf(sf, node);
      ctx.edge({ type: 'EXPORTS', src: fileId, dst, file: rel, line: p.line, col: p.col, extraction: 'ts-checker', confidence: 1, verification: 'static_verified', evidence: shortText(node.getText(sf), 120), meta });
    };

    const visitStatement = (stmt: ts.Statement) => {
      if (ts.isImportDeclaration(stmt) && ts.isStringLiteralLike(stmt.moduleSpecifier)) {
        const c = stmt.importClause;
        const names: string[] = [];
        if (c?.name) names.push(`default:${c.name.text}`);
        if (c?.namedBindings) {
          if (ts.isNamespaceImport(c.namedBindings)) names.push(`*:${c.namedBindings.name.text}`);
          else for (const e of c.namedBindings.elements) names.push(e.propertyName ? `${e.propertyName.text} as ${e.name.text}` : e.name.text);
        }
        handleModuleRef(stmt.moduleSpecifier.text, stmt.moduleSpecifier, stmt, 'import', names, !!c?.isTypeOnly);
      } else if (ts.isImportEqualsDeclaration(stmt) && ts.isExternalModuleReference(stmt.moduleReference) && ts.isStringLiteralLike(stmt.moduleReference.expression)) {
        handleModuleRef(stmt.moduleReference.expression.text, stmt.moduleReference.expression, stmt, 'import_equals', [stmt.name.text], !!stmt.isTypeOnly);
      } else if (ts.isExportDeclaration(stmt)) {
        const names = stmt.exportClause && ts.isNamedExports(stmt.exportClause) ? stmt.exportClause.elements.map((e) => e.name.text) : ['*'];
        if (stmt.moduleSpecifier && ts.isStringLiteralLike(stmt.moduleSpecifier)) {
          const { dst, importId } = handleModuleRef(stmt.moduleSpecifier.text, stmt.moduleSpecifier, stmt, 'export_from', names, stmt.isTypeOnly);
          const eid = exportNode(stmt, names.join(','), { kind: 'reexport', names, from: stmt.moduleSpecifier.text, import_node: importId });
          if (dst) exportsEdge(dst, stmt, { reexport: true, names, export_node: eid });
        } else if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
          const eid = exportNode(stmt, names.join(','), { kind: 'named', names });
          for (const spec of stmt.exportClause.elements) {
            let sym: ts.Symbol | undefined;
            try { sym = project.checker.getExportSpecifierLocalTargetSymbol(spec); } catch { /* ignore */ }
            sym = aliasTarget(project.checker, sym);
            const d = sym?.declarations?.[0];
            const info = d ? declInfo(project, d) : null;
            if (info && ctx.hasNode(info.id)) exportsEdge(info.id, spec, { exported_as: spec.name.text, export_node: eid });
          }
        }
      } else if (ts.isExportAssignment(stmt)) {
        const e = stripParens(stmt.expression);
        const eid = exportNode(stmt, stmt.isExportEquals ? 'export=' : 'default', { kind: stmt.isExportEquals ? 'export_equals' : 'default', expression: shortText(e.getText(sf), 100) });
        if (ts.isIdentifier(e)) {
          const sym = aliasTarget(project.checker, project.checker.getSymbolAtLocation(e));
          const d = sym?.declarations?.[0];
          const info = d ? declInfo(project, d) : null;
          if (info && ctx.hasNode(info.id)) exportsEdge(info.id, stmt, { default: true, export_node: eid });
        }
      } else if (ts.isModuleDeclaration(stmt) && stmt.body && ts.isModuleBlock(stmt.body)) {
        stmt.body.statements.forEach(visitStatement);
      }
      // exported declarations
      const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
      if (mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
        const isDefault = !!mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
        const decls: ts.Node[] = ts.isVariableStatement(stmt) ? [...stmt.declarationList.declarations] : [stmt];
        for (const d of decls) {
          const info = declInfo(project, d);
          if (info && ctx.hasNode(info.id)) exportsEdge(info.id, d, { default: isDefault || undefined, modifier: true });
        }
      }
    };
    sf.statements.forEach(visitStatement);

    // dynamic import('literal') anywhere in the file
    const findDynamic = (n: ts.Node) => {
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const a = n.arguments[0];
        if (a && ts.isStringLiteralLike(a)) handleModuleRef(a.text, a, n, 'dynamic', [], false);
        else bump(diag.unsupported, 'dynamic_import_non_literal');
      }
      ts.forEachChild(n, findDynamic);
    };
    findDynamic(sf);
  }
}

// ----------------------------------------------------------------- heritage

export function extractHeritage(env: Env): void {
  const { project, ctx, diag } = env;
  for (const rel of project.files) {
    const sf = project.sourceFiles.get(rel);
    if (!sf) continue;
    const visit = (stmt: ts.Statement) => {
      if (ts.isModuleDeclaration(stmt) && stmt.body && ts.isModuleBlock(stmt.body)) { stmt.body.statements.forEach(visit); return; }
      let node: ts.ClassDeclaration | ts.InterfaceDeclaration | null = null;
      if (ts.isClassDeclaration(stmt) || ts.isInterfaceDeclaration(stmt)) node = stmt;
      if (!node) return;
      const info = declInfo(project, node);
      if (!info || !ctx.hasNode(info.id)) return;
      const rec = { extends: [] as string[], implements: [] as string[] };
      env.heritage.set(info.id, rec);
      for (const clause of node.heritageClauses ?? []) {
        const isExt = clause.token === ts.SyntaxKind.ExtendsKeyword;
        for (const t of clause.types) {
          const p = startOf(sf, t);
          const type = isExt ? 'EXTENDS' as const : 'IMPLEMENTS' as const;
          let expr = stripParens(t.expression);
          const mixin = ts.isCallExpression(expr);
          if (ts.isCallExpression(expr)) expr = stripParens(expr.expression);
          let sym: ts.Symbol | undefined;
          try {
            sym = ts.isIdentifier(expr) ? project.checker.getSymbolAtLocation(expr) : ts.isPropertyAccessExpression(expr) ? project.checker.getSymbolAtLocation(expr.name) : undefined;
          } catch { sym = undefined; }
          sym = aliasTarget(project.checker, sym);
          const decl = sym?.declarations?.find((d) => ts.isClassDeclaration(d) || ts.isInterfaceDeclaration(d) || ts.isFunctionDeclaration(d) || ts.isVariableDeclaration(d)) ?? sym?.declarations?.[0];
          const common = { type, src: info.id, file: rel, line: p.line, col: p.col, evidence: shortText(t.getText(sf), 120) };
          if (decl && project.relOf(decl.getSourceFile()) && !mixin) {
            const di = declInfo(project, decl);
            if (di && ctx.hasNode(di.id)) {
              (isExt ? rec.extends : rec.implements).push(di.id);
              ctx.edge({ ...common, dst: di.id, extraction: 'ts-checker', confidence: 1, verification: 'static_verified', meta: { clause: isExt ? 'extends' : 'implements' } });
              continue;
            }
          }
          if (decl && !project.relOf(decl.getSourceFile())) {
            const sfd = decl.getSourceFile();
            const pkg = project.isLib(sfd) ? null : externalPackageOf(decl);
            const dst = pkg ? ctx.ensureExternal(pkg, externalMeta(env, pkg)) : ctx.ensureSpecial(STDLIB_ID, '<stdlib>', 'language_builtin');
            ctx.edge({ ...common, dst, extraction: 'ts-checker', confidence: 1, verification: 'static_verified', meta: { base: shortText(t.getText(sf), 100), mixin: mixin || undefined, external: true, clause: isExt ? 'extends' : 'implements' } });
            continue;
          }
          if (decl && mixin) { // project function used as mixin factory
            ctx.edge({ ...common, dst: UNRESOLVED_ID, extraction: 'ts-checker', confidence: 0, verification: 'unknown', meta: { base: shortText(t.getText(sf), 100), mixin: true } });
            ctx.ensureSpecial(UNRESOLVED_ID, '<unresolved>', 'unresolved_placeholder');
            continue;
          }
          ctx.ensureSpecial(UNRESOLVED_ID, '<unresolved>', 'unresolved_placeholder');
          ctx.edge({ ...common, dst: UNRESOLVED_ID, extraction: 'ts-checker', confidence: 0, verification: 'unknown', meta: { base: shortText(t.getText(sf), 100), unresolved: true } });
          diag.unresolvedReferences++;
        }
      }
    };
    sf.statements.forEach(visit);
  }
}

// ----------------------------------------------------------------- HAS_TYPE

export function extractHasType(env: Env, pass: SymbolPass): void {
  const { project, ctx } = env;
  const emit = (srcId: string, typeNode: ts.TypeNode | undefined, file: string, sf: ts.SourceFile) => {
    if (!typeNode) return;
    const seen = new Set<string>();
    const visit = (n: ts.Node, nested: boolean) => {
      if (ts.isTypeReferenceNode(n)) {
        let sym: ts.Symbol | undefined;
        try { sym = aliasTarget(project.checker, project.checker.getSymbolAtLocation(n.typeName)); } catch { sym = undefined; }
        const decl = sym?.declarations?.find((d) => ts.isClassDeclaration(d) || ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d) || ts.isEnumDeclaration(d));
        const info = decl ? declInfo(project, decl) : null;
        if (info && ctx.hasNode(info.id) && !seen.has(info.id)) {
          seen.add(info.id);
          const p = startOf(sf, n);
          ctx.edge({
            type: 'HAS_TYPE', src: srcId, dst: info.id, file, line: p.line, col: p.col, extraction: 'ts-checker', confidence: 1,
            verification: 'static_verified', evidence: shortText(n.getText(sf), 100), meta: { role: nested ? 'type_arg' : 'primary', type_text: shortText(typeNode.getText(sf), 100) },
          });
        }
        if (n.typeArguments) n.typeArguments.forEach((a) => visit(a, true));
        return;
      }
      ts.forEachChild(n, (c) => visit(c, nested));
    };
    visit(typeNode, false);
  };
  for (const p of pass.params) emit(p.id, p.decl.type, ctx.nodes.get(p.id)!.file!, p.decl.getSourceFile());
  for (const p of pass.props) {
    const d = p.decl;
    emit(p.id, d.type, ctx.nodes.get(p.id)!.file!, d.getSourceFile());
  }
}

// ----------------------------------------------------------------- REFERENCES collector

export class ReferenceCollector {
  private refs = new Map<string, { line: number; col: number; evidence: string; count: number; kind: string }>();
  readonly instantiated = new Set<string>();
  readonly suppress = new Set<string>();

  constructor(private env: Env) {}

  reset() { this.refs.clear(); this.instantiated.clear(); this.suppress.clear(); }

  private static isDeclName(id: ts.Identifier): boolean {
    const p = id.parent as ts.Node & { name?: ts.Node; propertyName?: ts.Node };
    if (!p) return false;
    if (ts.isPropertyAccessExpression(p)) return p.name === id;
    if (ts.isQualifiedName(p)) return p.left !== id;
    if (ts.isShorthandPropertyAssignment(p)) return false;
    if (ts.isBindingElement(p) && p.propertyName === id) return true;
    if (ts.isBreakOrContinueStatement(p) || ts.isLabeledStatement(p) || ts.isJsxAttribute(p)) return true;
    if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isNamedTupleMember(p) || ts.isTypePredicateNode(p)) return true;
    if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isEnumMember(p)) && p.name === id) return true;
    return p.name === id;
  }

  onIdentifier(id: ts.Identifier, st: WalkState): ts.Symbol | undefined {
    const { env } = this;
    const checker = env.project.checker;
    if (ReferenceCollector.isDeclName(id)) return undefined;
    let sym: ts.Symbol | undefined;
    try {
      sym = ts.isShorthandPropertyAssignment(id.parent) ? checker.getShorthandAssignmentValueSymbol(id.parent) : checker.getSymbolAtLocation(id);
    } catch { sym = undefined; }
    if (!sym) {
      env.diag.unresolvedReferences++;
      if (env.diag.unresolvedReferenceSamples.length < 40) {
        const p = startOf(id.getSourceFile(), id);
        env.diag.unresolvedReferenceSamples.push(`${st.owner.file}:${p.line}:${p.col} ${id.text}`);
      }
      return undefined;
    }
    const target = aliasTarget(checker, sym);
    const decl = target?.declarations?.find((d) => ts.isClassDeclaration(d) || ts.isInterfaceDeclaration(d) || ts.isEnumDeclaration(d) || ts.isTypeAliasDeclaration(d) || ts.isVariableDeclaration(d));
    if (decl) {
      const info = declInfo(env.project, decl);
      if (info && (info.type === 'class' || info.type === 'interface' || info.type === 'type' || info.type === 'variable') && env.ctx.hasNode(info.id)) {
        const k = info.id;
        const ex = this.refs.get(k);
        if (ex) ex.count++;
        else {
          const p = startOf(id.getSourceFile(), id);
          this.refs.set(k, { line: p.line, col: p.col, evidence: shortText(id.parent.getText(id.getSourceFile()), 100), count: 1, kind: info.type });
        }
      }
    }
    return sym;
  }

  flush(st: WalkState): void {
    const { env } = this;
    const o = st.owner;
    const ownClass = o.className ? `class:${o.file}#${o.className}` : null;
    for (const [dst, r] of this.refs) {
      if (dst === o.id || dst === ownClass || this.instantiated.has(dst) || this.suppress.has(dst)) continue;
      const node = env.ctx.nodes.get(dst);
      if (node?.meta.synthetic) continue;
      env.ctx.edge({
        type: 'REFERENCES', src: o.id, dst, file: o.file, line: r.line, col: r.col, extraction: 'ts-checker', confidence: 1,
        verification: 'static_verified', evidence: r.evidence, meta: { ref_kind: r.kind, count: r.count },
      });
    }
    this.refs.clear(); this.instantiated.clear(); this.suppress.clear();
  }
}

export { lineColOfPos };
export type { DeclInfo };
