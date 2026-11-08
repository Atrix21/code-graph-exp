/**
 * CALLS / INSTANTIATES / RECURSES_TO extraction.
 *
 * Resolution order: checker.getResolvedSignature(call).declaration, then the callee symbol
 * (aliases followed). Declarations are classified as project (graph node / local closure),
 * external package, TypeScript stdlib, or unresolved. Calls through an abstract/interface member are
 * additionally dispatched to the concrete implementations (DI binding => framework_inferred, else ambiguous).
 */
import ts from 'typescript';
import type { Env, WalkState, CallSiteRecord } from './graph-context.js';
import { emitEffect, STDLIB_ID, UNRESOLVED_ID } from './graph-context.js';
import { aliasTarget, declInfo, isFnInit, normalizeDecl, type DeclInfo } from './symbol-extractor.js';
import { shortText, startOf } from './typescript-parser.js';

export interface CallTarget { nodeId: string | null; decl: ts.Node; info: DeclInfo | null }

export interface CallResolution {
  node: ts.CallExpression | ts.NewExpression;
  kind: 'call' | 'new' | 'decorator' | 'super';
  line: number;
  col: number;
  text: string;
  status: 'internal' | 'external' | 'stdlib' | 'unresolved';
  category: string;
  targets: CallTarget[];
  ambiguous: boolean;
  /** External package (status external) and the called member, e.g. `ConfigService.get`. */
  pkg?: string;
  member?: string;
  /** For `new X` of a project class. */
  classNodeId?: string;
  /** For `new X` of an external class. */
  className?: string;
  receiver?: ts.Expression;
  calleeName: string;
  sigDecl?: ts.Node;
  /** Internal CALLS edges emitted for this site (primary + dispatch), used by application-layer edges. */
  emitted: { dst: string; verification: 'static_verified' | 'framework_inferred' | 'ambiguous'; confidence: number; dispatch: boolean }[];
}

export function stripParens(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
  return e;
}

/** Node whose start is used as the evidence position of a call site (callee name token). */
export function calleeNameNode(node: ts.CallExpression | ts.NewExpression): ts.Node {
  const e = stripParens(node.expression);
  if (ts.isPropertyAccessExpression(e)) return e.name;
  if (ts.isElementAccessExpression(e)) return e.argumentExpression;
  return e;
}

export function externalPackageOf(decl: ts.Node): string {
  for (let n: ts.Node | undefined = decl.parent; n; n = n.parent) {
    if (ts.isModuleDeclaration(n) && ts.isStringLiteral(n.name)) return n.name.text.replace(/^node:/, '');
  }
  const f = decl.getSourceFile().fileName;
  const idx = f.lastIndexOf('/node_modules/');
  if (idx >= 0) {
    const parts = f.slice(idx + '/node_modules/'.length).split('/');
    let pkg = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
    if (pkg.startsWith('@types/')) {
      const n = pkg.slice(7);
      pkg = n.includes('__') ? `@${n.replace('__', '/')}` : n;
    }
    return pkg;
  }
  return 'unknown';
}

/** npm package name for a module specifier (`@nestjs/common/utils/x` -> `@nestjs/common`). */
export function packageOfSpecifier(spec: string): string {
  const s = spec.replace(/^node:/, '');
  const parts = s.split('/');
  return s.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

export function memberLabel(decl: ts.Node): string {
  const d = normalizeDecl(decl);
  const nm = (d as ts.Node & { name?: ts.Node }).name;
  const own = nm && (ts.isIdentifier(nm) || ts.isStringLiteral(nm) || ts.isPrivateIdentifier(nm)) ? nm.text : ts.isConstructorDeclaration(d) ? 'constructor' : ts.isConstructSignatureDeclaration(d) ? 'new' : '';
  const p = d.parent;
  const owner = p && (ts.isClassDeclaration(p) || ts.isInterfaceDeclaration(p)) && p.name ? p.name.text : null;
  if (ts.isClassDeclaration(d) || ts.isInterfaceDeclaration(d)) return d.name?.text ?? 'default';
  return owner ? `${owner}.${own}` : own || '<anonymous>';
}

function calleeSymbol(env: Env, expr: ts.Expression): ts.Symbol | undefined {
  const e = stripParens(expr);
  const c = env.project.checker;
  try {
    if (ts.isIdentifier(e)) return aliasTarget(c, c.getSymbolAtLocation(e));
    if (ts.isPropertyAccessExpression(e)) return aliasTarget(c, c.getSymbolAtLocation(e.name));
    if (ts.isElementAccessExpression(e)) return aliasTarget(c, c.getSymbolAtLocation(e.argumentExpression));
  } catch { /* fall through */ }
  return undefined;
}

function isAbstractMember(decl: ts.Node): boolean {
  const d = normalizeDecl(decl);
  if (ts.isMethodSignature(d) || ts.isPropertySignature(d)) return true;
  if ((ts.isMethodDeclaration(d) || ts.isGetAccessorDeclaration(d) || ts.isSetAccessorDeclaration(d)) && !d.body) {
    return !!ts.getModifiers(d)?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword);
  }
  return false;
}

function classify(env: Env, decl: ts.Node): { status: CallResolution['status']; pkg?: string } {
  const sf = decl.getSourceFile();
  if (env.project.relOf(sf)) return { status: 'internal' };
  if (env.project.isLib(sf) || /\/typescript\/lib\/lib\.[^/]*\.d\.ts$/.test(sf.fileName)) return { status: 'stdlib' };
  return { status: 'external', pkg: externalPackageOf(decl) };
}

export function resolveCall(env: Env, node: ts.CallExpression | ts.NewExpression): CallResolution {
  const { project } = env;
  const checker = project.checker;
  const sf = node.getSourceFile();
  const pos = startOf(sf, calleeNameNode(node));
  const isNew = ts.isNewExpression(node);
  const isSuper = !isNew && node.expression.kind === ts.SyntaxKind.SuperKeyword;
  const kind: CallResolution['kind'] = isNew ? 'new' : isSuper ? 'super' : ts.isDecorator(node.parent) ? 'decorator' : 'call';
  const callee = stripParens(node.expression);
  const res: CallResolution = {
    node, kind, line: pos.line, col: pos.col, text: shortText(node.getText(sf), 140),
    status: 'unresolved', category: 'unresolved', targets: [], ambiguous: false,
    calleeName: shortText(callee.getText(sf), 80), emitted: [],
    receiver: ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee) ? callee.expression : undefined,
  };

  let sig: ts.Signature | undefined;
  try { sig = checker.getResolvedSignature(node); } catch { sig = undefined; }
  const sigDecl = sig?.declaration && !ts.isJSDocSignature(sig.declaration) ? sig.declaration : undefined;
  res.sigDecl = sigDecl;
  const sym = calleeSymbol(env, node.expression);

  // ---- `new X(...)`: prefer the class the symbol names, then the constructor signature
  if (isNew) {
    const classDecl = sym?.declarations?.find((d) => ts.isClassDeclaration(d)) as ts.ClassDeclaration | undefined;
    if (classDecl) {
      const c = classify(env, classDecl);
      res.status = c.status; res.className = classDecl.name?.text;
      if (c.status === 'internal') {
        const ci = declInfo(project, classDecl);
        if (ci) res.classNodeId = ci.id;
        const ctor = sigDecl && ts.isConstructorDeclaration(sigDecl) && sigDecl.parent === classDecl ? sigDecl : undefined;
        const cinfo = ctor ? declInfo(project, ctor) : null;
        if (ctor) res.targets.push({ nodeId: cinfo && env.ctx.hasNode(cinfo.id) ? cinfo.id : null, decl: ctor, info: cinfo });
        res.category = ci ? 'edge' : 'no_node';
      } else { res.pkg = c.pkg; res.member = `${res.className}.constructor`; res.category = c.status; }
      return finishFetch(res, callee);
    }
    if (sigDecl) {
      const c = classify(env, sigDecl);
      res.status = c.status; res.pkg = c.pkg; res.member = memberLabel(sigDecl);
      res.className = memberLabel(sigDecl).split('.')[0];
      res.category = c.status === 'internal' ? 'no_node' : c.status;
      return finishFetch(res, callee);
    }
    res.category = 'unresolved';
    return res;
  }

  // ---- ordinary calls
  const decls: ts.Node[] = [];
  if (sigDecl) decls.push(sigDecl);
  else if (sym?.declarations?.length) {
    for (const d of sym.declarations) {
      if (ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d) || ts.isMethodSignature(d) || ts.isConstructorDeclaration(d) ||
          ts.isPropertySignature(d) || ts.isPropertyDeclaration(d) || ts.isVariableDeclaration(d) || ts.isGetAccessorDeclaration(d) ||
          ts.isFunctionTypeNode(d) || ts.isParameter(d) || ts.isClassDeclaration(d)) decls.push(d);
    }
  }
  if (!decls.length) { return finishFetch(res, callee); }

  const seen = new Set<string>();
  for (const d of decls) {
    const nd = normalizeDecl(d);
    const c = classify(env, nd);
    if (c.status === 'internal') {
      const info = declInfo(project, nd);
      const ok = info && (info.type === 'function' || info.type === 'method' || info.type === 'property') && env.ctx.hasNode(info.id);
      const key = ok ? info!.id : `decl:${nd.pos}`;
      if (seen.has(key)) continue;
      seen.add(key);
      res.targets.push({ nodeId: ok ? info!.id : null, decl: nd, info: ok ? info : null });
    } else if (!res.targets.length || res.status === 'unresolved') {
      res.status = c.status; res.pkg = c.pkg; res.member = memberLabel(nd); res.category = c.status;
      if (c.status === 'external' || c.status === 'stdlib') break;
    }
  }
  if (res.targets.length) {
    res.status = 'internal';
    const withNode = res.targets.filter((t) => t.nodeId);
    if (withNode.length) { res.category = 'edge'; res.ambiguous = withNode.length > 1; res.targets = withNode; }
    else {
      const t = res.targets[0].decl;
      const local = !!declInfoOwnerRange(t);
      res.category = local ? 'local_closure' : 'no_node';
    }
  }
  return finishFetch(res, callee);
}

function declInfoOwnerRange(d: ts.Node): boolean {
  // a declaration nested inside a function-like body (closure) rather than a top-level/member declaration
  for (let n: ts.Node | undefined = d.parent; n; n = n.parent) {
    if (ts.isFunctionLike(n) || ts.isClassStaticBlockDeclaration(n)) return true;
  }
  return false;
}

/** Global `fetch(...)` resolves into lib.dom / @types/node: report it as an explicit external API. */
function finishFetch(res: CallResolution, callee: ts.Expression): CallResolution {
  if (res.member === '<anonymous>' || res.member === '') res.member = res.calleeName;
  if (ts.isIdentifier(callee) && callee.text === 'fetch' && (res.status === 'stdlib' || (res.status === 'external' && ['node', 'undici-types', 'unknown'].includes(res.pkg ?? '')))) {
    res.status = 'external'; res.pkg = 'fetch'; res.member = 'fetch'; res.category = 'external';
  }
  return res;
}

/** Find the concrete member `name` on class `classId`, walking up base classes. */
function findMemberNode(env: Env, classId: string, name: string, stopAt: Set<string>): string | null {
  const seen = new Set<string>();
  let cur: string | undefined = classId;
  while (cur && !seen.has(cur) && !stopAt.has(cur)) {
    seen.add(cur);
    const n = env.ctx.nodes.get(cur);
    if (!n) return null;
    const mid = `method:${n.file}#${n.qualified_name}.${name}`;
    const nd = env.ctx.nodes.get(mid);
    if (nd && nd.meta.has_body !== false && !nd.meta.abstract) return mid;
    cur = env.heritage.get(cur)?.extends[0];
  }
  return null;
}

/** Process one call/new site: edges + diagnostics. Returns the resolution for downstream extractors. */
export function handleCall(env: Env, st: WalkState, node: ts.CallExpression | ts.NewExpression): CallResolution {
  const { ctx } = env;
  const owner = st.owner;
  const res = resolveCall(env, node);
  const ev = res.text;
  const at = { file: owner.file, line: res.line, col: res.col };
  const metaBase: Record<string, unknown> = { callee: res.calleeName, call_kind: res.kind };
  if (res.kind === 'decorator') metaBase.decorator = true;
  let edge = false;

  if (res.status === 'internal') {
    if (res.kind === 'new' && res.classNodeId) {
      emitEffect(env, st, { type: 'INSTANTIATES', dst: res.classNodeId, ...at, extraction: 'ts-checker', confidence: 1, verification: 'static_verified', evidence: ev, meta: { ...metaBase } });
      edge = true;
    }
    const n = res.targets.length;
    for (const t of res.targets) {
      if (!t.nodeId) continue;
      const verification = res.ambiguous ? 'ambiguous' as const : 'static_verified' as const;
      const conf = res.ambiguous ? 1 / n : 1;
      emitEffect(env, st, { type: 'CALLS', dst: t.nodeId, ...at, extraction: res.ambiguous ? 'ts-checker-multi-decl' : 'ts-checker', confidence: conf, verification, evidence: ev, meta: { ...metaBase } });
      edge = true;
      res.emitted.push({ dst: t.nodeId, verification, confidence: conf, dispatch: false });
      if (t.nodeId === owner.id) {
        emitEffect(env, st, { type: 'RECURSES_TO', dst: owner.id, ...at, extraction: 'ts-checker', confidence: 1, verification: 'static_verified', evidence: ev, meta: { ...metaBase } });
      }
      // ---- dispatch through abstract / interface members
      if (isAbstractMember(t.decl) && t.info) {
        const cls = t.info.qualified.split('.')[0];
        const candidates = [`class:${t.info.file}#${cls}`, `interface:${t.info.file}#${cls}`];
        const typeId = candidates.find((c) => ctx.hasNode(c));
        const member = t.info.qualified.split('.').slice(1).join('.');
        if (typeId) {
          const bound = env.fw.bindings.get(typeId);
          const impls = env.fw.implementers.get(typeId) ?? new Set<string>();
          const useBound = !!bound && bound.length > 0;
          const classes = useBound ? [...new Set(bound!.map((b) => b.impl))].sort() : [...impls].sort();
          const stop = new Set([typeId]);
          const targets: { id: string; implClass: string }[] = [];
          for (const c of classes) {
            const m = findMemberNode(env, c, member, stop);
            if (m && m !== t.nodeId) targets.push({ id: m, implClass: c });
          }
          for (const tg of targets) {
            res.emitted.push({ dst: tg.id, verification: useBound ? 'framework_inferred' : 'ambiguous', confidence: useBound ? 0.8 : 1 / targets.length, dispatch: true });
            const b = useBound ? bound!.find((x) => x.impl === tg.implClass) : undefined;
            emitEffect(env, st, {
              type: 'CALLS', dst: tg.id, ...at,
              extraction: useBound ? 'nestjs-di-binding-dispatch' : 'implements-dispatch',
              confidence: useBound ? 0.8 : 1 / targets.length,
              verification: useBound ? 'framework_inferred' : 'ambiguous',
              evidence: ev,
              meta: { ...metaBase, dispatch: { via: t.nodeId, via_type: typeId, impl_class: tg.implClass, mechanism: useBound ? 'provide/useClass' : 'implements/extends', binding: b ? `${b.file}:${b.line}` : undefined, candidates: targets.length } },
            });
          }
        }
      }
    }
  } else if (res.status === 'external') {
    const dst = ctx.ensureExternal(res.pkg ?? 'unknown', externalMeta(env, res.pkg ?? 'unknown'));
    const m: Record<string, unknown> = { ...metaBase, external: true, package: res.pkg, member: res.member };
    if (res.kind === 'new') {
      emitEffect(env, st, { type: 'INSTANTIATES', dst, ...at, extraction: 'ts-checker', confidence: 1, verification: 'static_verified', evidence: ev, meta: { ...m, class_name: res.className } });
    } else {
      emitEffect(env, st, { type: 'CALLS', dst, ...at, extraction: 'ts-checker', confidence: 1, verification: 'static_verified', evidence: ev, meta: m });
    }
    edge = true;
  } else if (res.status === 'unresolved') {
    emitEffect(env, st, { type: 'CALLS', dst: ctx.ensureSpecial(UNRESOLVED_ID, '<unresolved>', 'unresolved_placeholder'), ...at, extraction: 'ts-checker', confidence: 0, verification: 'unknown', evidence: ev, meta: { ...metaBase, unresolved: true } });
    edge = true;
  } // stdlib: counted, no edge (documented)

  const rec: CallSiteRecord = { file: owner.file, line: res.line, col: res.col, kind: res.kind, status: res.status, category: res.category, edge };
  env.diag.callSites.push(rec);
  return res;
}

export function externalMeta(env: Env, pkg: string): Record<string, unknown> {
  const { dependencies, devDependencies } = env.project.packageJson;
  const m: Record<string, unknown> = {};
  if (dependencies[pkg]) m.declared_version = dependencies[pkg];
  else if (devDependencies[pkg]) { m.declared_version = devDependencies[pkg]; m.dev_dependency = true; }
  if (['node', 'crypto', 'fs', 'path', 'os', 'http', 'https', 'url', 'stream', 'util', 'events', 'child_process', 'buffer', 'zlib'].includes(pkg) || pkg.startsWith('fs/')) m.builtin = true;
  return m;
}

export { STDLIB_ID, isFnInit };
