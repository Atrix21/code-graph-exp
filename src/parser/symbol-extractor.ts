/**
 * Pass 1: declaration nodes (repository/file/class/function/method/interface/type/variable/property/parameter)
 * and CONTAINS edges. Also exports `declInfo`, the single source of truth that maps any ts declaration
 * node to its graph node id (used by every other extractor).
 *
 * Qualified names mirror src/evaluation/symbol-index.ts exactly: `Class.member` / `name`,
 * symbol key = `<file>::<qualified_name>`.
 */
import ts from 'typescript';
import type { NodeType } from '../graph/graph-schema.js';
import type { Env, Owner } from './graph-context.js';
import { shortText, spanOf, type Project } from './typescript-parser.js';

export interface DeclInfo {
  id: string;
  type: NodeType;
  qualified: string;
  file: string;
  key: string;
  /** Normalised declaration node (arrow/function-expression -> its variable/property). */
  decl: ts.Node;
  className: string | null;
}

export const nodeId = (type: NodeType, file: string, qualified: string) => `${type}:${file}#${qualified}`;
export const symbolKey = (file: string, qualified: string) => `${file}::${qualified}`;

const isTop = (n: ts.Node | undefined): boolean => !!n && (ts.isSourceFile(n) || ts.isModuleBlock(n));
export const isFnInit = (e: ts.Node | undefined): e is ts.ArrowFunction | ts.FunctionExpression =>
  !!e && (ts.isArrowFunction(e) || ts.isFunctionExpression(e));

export function memberName(m: ts.Node & { name?: ts.Node }, sf: ts.SourceFile): string | null {
  const nm = m.name;
  if (!nm) return null;
  if (ts.isIdentifier(nm) || ts.isPrivateIdentifier(nm) || ts.isStringLiteral(nm) || ts.isNumericLiteral(nm)) return nm.text;
  if (ts.isComputedPropertyName(nm)) return `[${nm.expression.getText(sf)}]`;
  return nm.getText(sf);
}

/** Maps arrow/function-expression/function-type nodes to the variable/property declaration that names them. */
export function normalizeDecl(node: ts.Node): ts.Node {
  const p = node.parent;
  if (p && isFnInit(node) && (ts.isVariableDeclaration(p) || ts.isPropertyDeclaration(p)) && p.initializer === node) return p;
  if (p && ts.isFunctionTypeNode(node) && (ts.isPropertySignature(p) || ts.isPropertyDeclaration(p)) && p.type === node) return p;
  return node;
}

function classNameOf(cls: ts.Node, sf: ts.SourceFile): string | null {
  if (ts.isClassDeclaration(cls)) return cls.name?.text ?? 'default';
  if (ts.isInterfaceDeclaration(cls)) return cls.name.text;
  if (ts.isClassExpression(cls)) {
    const p = cls.parent;
    if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && isTop(p.parent?.parent?.parent)) return p.name.text;
  }
  void sf;
  return null;
}

function isTopLevelClassLike(cls: ts.Node): boolean {
  if (ts.isClassDeclaration(cls) || ts.isInterfaceDeclaration(cls)) return isTop(cls.parent);
  if (ts.isClassExpression(cls)) return classNameOf(cls, cls.getSourceFile()) !== null;
  return false;
}

export function isParamProperty(p: ts.ParameterDeclaration): boolean {
  return ts.isConstructorDeclaration(p.parent) &&
    !!ts.getModifiers(p)?.some((m) => [ts.SyntaxKind.PublicKeyword, ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword, ts.SyntaxKind.ReadonlyKeyword].includes(m.kind));
}

/** Graph identity of a declaration node, or null when the declaration is not a graph node (nested closures, etc.). */
export function declInfo(project: Project, raw: ts.Node): DeclInfo | null {
  const decl = normalizeDecl(raw);
  const sf = decl.getSourceFile();
  const file = project.relOf(sf);
  if (!file) return null;
  const mk = (type: NodeType, qualified: string, className: string | null = null): DeclInfo =>
    ({ id: nodeId(type, file, qualified), type, qualified, file, key: symbolKey(file, qualified), decl, className });

  if (ts.isClassDeclaration(decl)) return isTop(decl.parent) ? mk('class', decl.name?.text ?? 'default') : null;
  if (ts.isInterfaceDeclaration(decl)) return isTop(decl.parent) ? mk('interface', decl.name.text) : null;
  if (ts.isTypeAliasDeclaration(decl)) return isTop(decl.parent) ? mk('type', decl.name.text) : null;
  if (ts.isEnumDeclaration(decl)) return isTop(decl.parent) ? mk('type', decl.name.text) : null;
  if (ts.isFunctionDeclaration(decl)) return isTop(decl.parent) ? mk('function', decl.name?.text ?? 'default') : null;
  if (ts.isClassExpression(decl)) { // class expression named by a module-level variable
    const p = decl.parent;
    return p && ts.isVariableDeclaration(p) ? declInfo(project, p) : null;
  }
  if (ts.isVariableDeclaration(decl)) {
    if (!ts.isIdentifier(decl.name)) return null;
    const stmt = decl.parent?.parent;
    if (!stmt || !ts.isVariableStatement(stmt) || !isTop(stmt.parent)) return null;
    return mk(isFnInit(decl.initializer) ? 'function' : 'variable', decl.name.text);
  }
  if (ts.isMethodDeclaration(decl) || ts.isMethodSignature(decl) || ts.isConstructorDeclaration(decl) ||
      ts.isGetAccessorDeclaration(decl) || ts.isSetAccessorDeclaration(decl) ||
      ts.isPropertyDeclaration(decl) || ts.isPropertySignature(decl)) {
    const cls = decl.parent;
    if (!cls || !isTopLevelClassLike(cls)) return null;
    const cn = classNameOf(cls, sf)!;
    const nm = ts.isConstructorDeclaration(decl) ? 'constructor' : memberName(decl, sf);
    if (!nm) return null;
    const isProp = (ts.isPropertyDeclaration(decl) && !isFnInit(decl.initializer)) || ts.isPropertySignature(decl);
    return mk(isProp ? 'property' : 'method', `${cn}.${nm}`, cn);
  }
  if (ts.isParameter(decl)) {
    const fnNode = decl.parent;
    if (!fnNode || ts.isFunctionTypeNode(fnNode)) return null;
    const ownerInfo = declInfo(project, fnNode);
    if (!ownerInfo) return null;
    const idx = fnNode.parameters.indexOf(decl);
    const nm = ts.isIdentifier(decl.name) ? decl.name.text : `$${idx}`;
    const q = `${ownerInfo.qualified}(${nm})`;
    return { id: nodeId('parameter', file, q), type: 'parameter', qualified: q, file, key: ownerInfo.key, decl, className: ownerInfo.className };
  }
  return null;
}

/** The property node that a constructor parameter-property declares (`private readonly x: T`). */
export function paramPropertyInfo(project: Project, p: ts.ParameterDeclaration): DeclInfo | null {
  if (!isParamProperty(p) || !ts.isIdentifier(p.name)) return null;
  const cls = p.parent.parent;
  const file = project.relOf(p.getSourceFile());
  if (!file || !isTopLevelClassLike(cls)) return null;
  const cn = classNameOf(cls, p.getSourceFile())!;
  const q = `${cn}.${p.name.text}`;
  return { id: nodeId('property', file, q), type: 'property', qualified: q, file, key: symbolKey(file, q), decl: p, className: cn };
}

/** Resolve a symbol's declaration to a graph value node (property / variable / parameter / function / method). */
export function nodeOfSymbolDecl(project: Project, sym: ts.Symbol, decl: ts.Node): DeclInfo | null {
  if (ts.isParameter(decl) && (sym.flags & ts.SymbolFlags.Property)) return paramPropertyInfo(project, decl);
  return declInfo(project, decl);
}

export function aliasTarget(checker: ts.TypeChecker, sym: ts.Symbol | undefined): ts.Symbol | undefined {
  if (!sym) return undefined;
  if (sym.flags & ts.SymbolFlags.Alias) {
    try { return checker.getAliasedSymbol(sym); } catch { return sym; }
  }
  return sym;
}

// ---------------------------------------------------------------- metadata helpers

function modifierNames(node: ts.Node): string[] {
  return (ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : []).map((m) => ts.tokenToString(m.kind) ?? String(m.kind));
}
export function decoratorTexts(node: ts.Node, sf: ts.SourceFile): string[] {
  return (ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : []).map((d) => shortText(d.getText(sf), 120));
}
function docOf(node: ts.Node): string | undefined {
  const jd = (node as unknown as { jsDoc?: ts.JSDoc[] }).jsDoc;
  const c = jd?.[jd.length - 1]?.comment;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text).join('') : '';
  return text ? shortText(text, 200) : undefined;
}

function signatureText(node: ts.Node, sf: ts.SourceFile, fn: ts.Node | null): string {
  const mods = ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
  const startNode: ts.Node = mods[0] ?? (ts.isVariableDeclaration(node) ? node.parent.parent : (node as ts.Node & { name?: ts.Node }).name ?? node);
  const start = startNode.getStart(sf);
  let end = node.getEnd();
  const body = fn && (fn as ts.FunctionLikeDeclaration).body;
  if (body) end = body.getStart(sf);
  else if (ts.isClassDeclaration(node)) end = node.members.pos;
  return shortText(sf.text.slice(start, Math.max(end, start)).replace(/=>\s*$/, '=>'), 300);
}

function fnNodeOf(decl: ts.Node): ts.FunctionLikeDeclaration | ts.MethodSignature | null {
  if (ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl) || ts.isConstructorDeclaration(decl) ||
      ts.isGetAccessorDeclaration(decl) || ts.isSetAccessorDeclaration(decl) || ts.isMethodSignature(decl)) return decl;
  if ((ts.isVariableDeclaration(decl) || ts.isPropertyDeclaration(decl)) && isFnInit(decl.initializer)) return decl.initializer;
  return null;
}

// ---------------------------------------------------------------- pass 1

export interface SymbolPass {
  /** Parameter declarations with their graph ids (for HAS_TYPE). */
  params: { id: string; decl: ts.ParameterDeclaration }[];
  /** Property declarations (incl. parameter properties) with ids (for HAS_TYPE). */
  props: { id: string; decl: ts.PropertyDeclaration | ts.PropertySignature | ts.ParameterDeclaration }[];
  /** Top-level statements that are not declarations, per file (walked under the <module> owner). */
  moduleCode: Map<string, ts.Node[]>;
}

export function extractSymbols(env: Env): SymbolPass {
  const { project, ctx } = env;
  const pass: SymbolPass = { params: [], props: [], moduleCode: new Map() };
  const ownersById = new Map<string, Owner>();
  const repoId = `repository:${project.repoName}`;
  ctx.node('repository', repoId, project.repoName, null, null, null, {
    tsconfig: project.tsconfig, file_count: project.files.length, ts_version: ts.version,
    dependencies: Object.keys(project.packageJson.dependencies).sort(),
  });

  const contains = (src: string, dst: string, file: string, line: number, col: number) =>
    ctx.edge({ type: 'CONTAINS', src, dst, file, line, col, extraction: 'ts-syntax', confidence: 1, verification: 'static_verified', evidence: null, key: 'contains' });

  for (const rel of project.files) {
    const sf = project.sourceFiles.get(rel);
    if (!sf) continue;
    const fileId = `file:${rel}`;
    const lineCount = sf.getLineAndCharacterOfPosition(sf.getEnd()).line + 1;
    ctx.node('file', fileId, rel.split('/').pop()!, rel, rel,
      { start_line: 1, end_line: lineCount, start_col: 1, end_col: 1 },
      { symbol_key: symbolKey(rel, '<module>'), path: rel, language: 'typescript', lines: lineCount,
        is_test: /^test\/|\.(spec|test|e2e-spec)\.ts$/.test(rel), declaration: true });
    contains(repoId, fileId, rel, 1, 1);
    const moduleCode: ts.Node[] = [];
    pass.moduleCode.set(rel, moduleCode);

    /** Create/merge the node for a declaration; returns its info (null if not a graph node). */
    const addDecl = (decl: ts.Node, parentId: string, extra: Record<string, unknown> = {}): DeclInfo | null => {
      const info = declInfo(project, decl);
      if (!info) return null;
      const d = info.decl;
      const span = spanOf(sf, ts.isVariableDeclaration(d) && ts.isVariableDeclarationList(d.parent) && d.parent.declarations.length === 1 ? d.parent.parent : d);
      const name = info.qualified.includes('.') && info.type !== 'parameter' ? info.qualified.split('.').slice(-1)[0] : info.qualified;
      const prev = ctx.nodes.get(info.id);
      const fn0 = fnNodeOf(d);
      const hasBody0 = !!(fn0 && (fn0 as ts.FunctionLikeDeclaration).body);
      const cur0 = ownersById.get(info.id);
      if (!cur0 || (hasBody0 && !(cur0.fn && (cur0.fn as ts.FunctionLikeDeclaration).body))) {
        ownersById.set(info.id, {
          id: info.id, type: info.type, qualified: info.qualified, file: rel, sf, decl: d, fn: fn0 as Owner['fn'],
          className: info.className, isConstructor: ts.isConstructorDeclaration(d), symbolKey: info.key,
        });
      }
      if (prev) { // overloads / accessor pairs: widen span, record
        prev.start_line = Math.min(prev.start_line!, span.start_line);
        prev.end_line = Math.max(prev.end_line!, span.end_line);
        prev.meta.overloads = ((prev.meta.overloads as number) ?? 1) + 1;
        if (ts.isGetAccessorDeclaration(d) || ts.isSetAccessorDeclaration(d)) {
          const k = ts.isGetAccessorDeclaration(d) ? 'get' : 'set';
          const cur = new Set(String(prev.meta.accessor ?? '').split(',').filter(Boolean)); cur.add(k);
          prev.meta.accessor = [...cur].sort().join(',');
        }
        return info;
      }
      const fn = fnNodeOf(d);
      const meta: Record<string, unknown> = {
        symbol_key: info.key, declaration: true, modifiers: modifierNames(ts.isVariableDeclaration(d) ? d.parent.parent : d),
        ...extra,
      };
      const decs = decoratorTexts(d, sf);
      if (decs.length) meta.decorators = decs;
      const doc = docOf(ts.isVariableDeclaration(d) ? d.parent.parent : d);
      if (doc) meta.doc = doc;
      meta.exported = (meta.modifiers as string[]).includes('export');
      if (fn) {
        meta.signature = signatureText(d, sf, fn);
        meta.is_async = !!modifierNames(fn).includes('async') ||!!ts.getModifiers(fn as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
        meta.param_count = fn.parameters.length;
        if (fn.type) meta.return_type = shortText(fn.type.getText(sf), 120);
        meta.has_body = !!(fn as ts.FunctionLikeDeclaration).body;
      }
      if (info.type === 'method') {
        meta.kind = ts.isConstructorDeclaration(d) ? 'constructor' : ts.isGetAccessorDeclaration(d) ? 'accessor' : ts.isSetAccessorDeclaration(d) ? 'accessor'
          : ts.isMethodSignature(d) ? 'signature' : ts.isPropertyDeclaration(d) ? 'arrow_property' : 'method';
        if (ts.isGetAccessorDeclaration(d)) meta.accessor = 'get';
        if (ts.isSetAccessorDeclaration(d)) meta.accessor = 'set';
        const abstract = (meta.modifiers as string[]).includes('abstract');
        if (abstract) meta.abstract = true;
        meta.static = (meta.modifiers as string[]).includes('static');
        meta.visibility = (meta.modifiers as string[]).find((m) => ['public', 'private', 'protected'].includes(m)) ?? 'public';
        meta.class = info.className;
      } else if (info.type === 'function') {
        meta.kind = ts.isFunctionDeclaration(d) ? 'function' : 'arrow_const';
        if (ts.isFunctionDeclaration(d) && d.asteriskToken) meta.generator = true;
      } else if (info.type === 'property') {
        const t = (ts.isPropertyDeclaration(d) || ts.isPropertySignature(d)) ? d.type : undefined;
        if (t) meta.type = shortText(t.getText(sf), 120);
        if (ts.isPropertyDeclaration(d) && d.initializer) meta.initializer = shortText(d.initializer.getText(sf), 80);
        meta.optional = !!(d as ts.PropertyDeclaration).questionToken;
        meta.static = (meta.modifiers as string[]).includes('static');
        meta.visibility = (meta.modifiers as string[]).find((m) => ['public', 'private', 'protected'].includes(m)) ?? 'public';
        meta.class = info.className;
      } else if (info.type === 'variable') {
        const vd = d as ts.VariableDeclaration;
        meta.kind = (vd.parent.flags & ts.NodeFlags.Const) ? 'const' : (vd.parent.flags & ts.NodeFlags.Let) ? 'let' : 'var';
        if (vd.type) meta.type = shortText(vd.type.getText(sf), 120);
        if (vd.initializer) meta.initializer = shortText(vd.initializer.getText(sf), 100);
      } else if (info.type === 'class') {
        const cd = d as ts.ClassDeclaration;
        meta.abstract = (meta.modifiers as string[]).includes('abstract');
        meta.signature = signatureText(cd, sf, null);
        meta.extends = (cd.heritageClauses ?? []).filter((h) => h.token === ts.SyntaxKind.ExtendsKeyword).flatMap((h) => h.types.map((t) => shortText(t.getText(sf), 100)));
        meta.implements = (cd.heritageClauses ?? []).filter((h) => h.token === ts.SyntaxKind.ImplementsKeyword).flatMap((h) => h.types.map((t) => shortText(t.getText(sf), 100)));
        meta.member_count = cd.members.length;
      } else if (info.type === 'interface') {
        const idl = d as ts.InterfaceDeclaration;
        meta.extends = (idl.heritageClauses ?? []).flatMap((h) => h.types.map((t) => shortText(t.getText(sf), 100)));
        meta.member_count = idl.members.length;
      } else if (info.type === 'type') {
        if (ts.isEnumDeclaration(d)) {
          meta.decl_kind = 'enum';
          meta.members = d.members.map((m) => memberName(m, sf)).filter(Boolean).slice(0, 40);
        } else {
          meta.decl_kind = 'type_alias';
          meta.definition = shortText((d as ts.TypeAliasDeclaration).type.getText(sf), 160);
        }
      }
      ctx.node(info.type, info.id, name, info.qualified, rel, span, meta);
      contains(parentId, info.id, rel, span.start_line, span.start_col);

      // parameters
      if (fn) {
        fn.parameters.forEach((p, idx) => {
          const pinfo = declInfo(project, p);
          if (!pinfo) return;
          const pname = ts.isIdentifier(p.name) ? p.name.text : `$${idx}`;
          const pmeta: Record<string, unknown> = {
            symbol_key: info.key, owner: info.id, owner_qualified_name: info.qualified, index: idx, declaration: false,
            optional: !!p.questionToken || !!p.initializer, rest: !!p.dotDotDotToken,
          };
          if (p.type) pmeta.type = shortText(p.type.getText(sf), 120);
          if (p.initializer) pmeta.default = shortText(p.initializer.getText(sf), 60);
          if (!ts.isIdentifier(p.name)) pmeta.binding = shortText(p.name.getText(sf), 120);
          const pd = decoratorTexts(p, sf);
          if (pd.length) pmeta.decorators = pd;
          if (isParamProperty(p)) pmeta.parameter_property = true;
          const pspan = spanOf(sf, p);
          ctx.node('parameter', pinfo.id, pname, pinfo.qualified, rel, pspan, pmeta);
          contains(info.id, pinfo.id, rel, pspan.start_line, pspan.start_col);
          pass.params.push({ id: pinfo.id, decl: p });
          const pp = paramPropertyInfo(project, p);
          if (pp) {
            const cmeta: Record<string, unknown> = {
              symbol_key: pp.key, declaration: true, parameter_property: true, class: pp.className,
              modifiers: modifierNames(p), type: p.type ? shortText(p.type.getText(sf), 120) : undefined,
              visibility: modifierNames(p).find((m) => ['public', 'private', 'protected'].includes(m)) ?? 'public',
              readonly: modifierNames(p).includes('readonly'),
            };
            if (pd.length) cmeta.decorators = pd;
            ctx.node('property', pp.id, pname, pp.qualified, rel, pspan, cmeta);
            contains(`class:${rel}#${pp.className}`, pp.id, rel, pspan.start_line, pspan.start_col);
            pass.props.push({ id: pp.id, decl: p });
          }
        });
      }
      if (info.type === 'property' && (ts.isPropertyDeclaration(d) || ts.isPropertySignature(d))) pass.props.push({ id: info.id, decl: d });
      return info;
    };

    const visitMembers = (cls: ts.ClassLikeDeclaration | ts.InterfaceDeclaration, clsId: string) => {
      for (const m of cls.members) {
        if (ts.isClassStaticBlockDeclaration(m) || ts.isSemicolonClassElement(m) || ts.isIndexSignatureDeclaration(m) ||
            ts.isCallSignatureDeclaration(m) || ts.isConstructSignatureDeclaration(m)) {
          if (ts.isClassStaticBlockDeclaration(m)) env.diag.unsupported['class_static_block'] = (env.diag.unsupported['class_static_block'] ?? 0) + 1;
          continue;
        }
        if (!addDecl(m, clsId)) env.diag.unsupported['unnamed_or_nested_member'] = (env.diag.unsupported['unnamed_or_nested_member'] ?? 0) + 1;
      }
    };

    const visitTop = (stmt: ts.Statement) => {
      if (ts.isClassDeclaration(stmt)) {
        const info = addDecl(stmt, fileId);
        if (info) visitMembers(stmt, info.id);
      } else if (ts.isInterfaceDeclaration(stmt)) {
        const info = addDecl(stmt, fileId);
        if (info) visitMembers(stmt, info.id);
      } else if (ts.isFunctionDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) || ts.isEnumDeclaration(stmt)) {
        addDecl(stmt, fileId);
      } else if (ts.isVariableStatement(stmt)) {
        let leftover = false;
        for (const d of stmt.declarationList.declarations) {
          const info = addDecl(d, fileId);
          if (!info) { leftover = true; continue; }
          if (d.initializer && ts.isClassExpression(d.initializer)) visitMembers(d.initializer, info.id);
        }
        if (leftover) moduleCode.push(stmt);
      } else if (ts.isModuleDeclaration(stmt)) {
        if (stmt.body && ts.isModuleBlock(stmt.body)) stmt.body.statements.forEach(visitTop);
      } else if (ts.isImportDeclaration(stmt) || ts.isImportEqualsDeclaration(stmt) || ts.isExportDeclaration(stmt) || ts.isEmptyStatement(stmt)) {
        // handled by the structural pass
      } else {
        moduleCode.push(stmt); // expression statements, export default <expr>, side-effect code
      }
    };
    sf.statements.forEach(visitTop);
  }

  env.owners.push(...[...ownersById.values()]);
  // Module-level owners (top-level code outside any declaration).
  for (const [rel, stmts] of pass.moduleCode) {
    if (!stmts.length) continue;
    const sf = project.sourceFiles.get(rel)!;
    env.owners.push({
      id: `file:${rel}`, type: 'file', qualified: '<module>', file: rel, sf, decl: sf, fn: null,
      className: null, isConstructor: false, symbolKey: symbolKey(rel, '<module>'),
    });
  }
  env.owners.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return pass;
}
