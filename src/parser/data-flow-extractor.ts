/**
 * Data-flow edges: READS, WRITES, MUTATES, PASSES_TO, RECEIVES_FROM, RETURNS_VALUE_TO.
 * All targets are resolved with the type checker; config-key reads (ConfigService.get('a.b'),
 * process.env.X) target synthetic `variable` nodes `variable:config#<key>` (meta.synthetic = true).
 */
import ts from 'typescript';
import type { Env, WalkState } from './graph-context.js';
import { emitEffect } from './graph-context.js';
import type { CallResolution } from './call-extractor.js';
import { stripParens } from './call-extractor.js';
import { aliasTarget, declInfo, isFnInit, nodeOfSymbolDecl, normalizeDecl, type DeclInfo } from './symbol-extractor.js';
import { shortText, startOf } from './typescript-parser.js';

export type ValueKind = 'property' | 'parameter' | 'variable';

/** Resolve an identifier (property name or bare name) to a project property / parameter / module variable node. */
export function valueTarget(env: Env, id: ts.Identifier | ts.PrivateIdentifier, sym?: ts.Symbol): DeclInfo | null {
  const checker = env.project.checker;
  let s = sym;
  if (!s) { try { s = checker.getSymbolAtLocation(id); } catch { return null; } }
  s = aliasTarget(checker, s);
  if (!s) return null;
  const decl = s.valueDeclaration ?? s.declarations?.[0];
  if (!decl) return null;
  const info = nodeOfSymbolDecl(env.project, s, decl);
  if (!info || !env.ctx.hasNode(info.id)) return null;
  if (info.type === 'property' || info.type === 'parameter' || info.type === 'variable') return info;
  return null;
}

/** Project properties/parameters/variables read by an expression (for CHECKS edges). */
export function collectValueRefs(env: Env, expr: ts.Node): { info: DeclInfo; node: ts.Node }[] {
  const out: { info: DeclInfo; node: ts.Node }[] = [];
  const seen = new Set<string>();
  const add = (info: DeclInfo | null, node: ts.Node) => {
    if (!info) return;
    const k = `${info.id}@${node.pos}`;
    if (seen.has(k)) return;
    seen.add(k); out.push({ info, node });
  };
  const visit = (n: ts.Node) => {
    if (ts.isPropertyAccessExpression(n)) { add(valueTarget(env, n.name), n.name); visit(n.expression); return; }
    if (ts.isIdentifier(n)) {
      const p = n.parent;
      if (p && ((ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n) || ts.isTypeReferenceNode(p))) return;
      add(valueTarget(env, n), n);
      return;
    }
    if (ts.isFunctionLike(n)) return;
    ts.forEachChild(n, visit);
  };
  visit(expr);
  return out;
}

export function configNodeId(key: string): string { return `variable:config#${key}`; }

function ensureConfigNode(env: Env, key: string, source: string): string {
  const id = configNodeId(key);
  env.ctx.node('variable', id, key, key, null, null, { synthetic: true, config_key: key, source, kind: 'config_key' });
  return id;
}

const MUTATING_MEMBER = /^(Array|ReadonlyArray|Set|Map|WeakMap|WeakSet)\.(push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin|set|add|delete|clear)$/;
const MUTATING_STATIC = /^ObjectConstructor\.(assign|defineProperty|defineProperties|setPrototypeOf)$/;

type RootKind = 'this' | 'parameter' | 'parameter_derived' | 'module_var' | 'call_result' | 'local_created' | 'unknown';

export class DataFlow {
  constructor(private env: Env) {}

  private rootOf(expr: ts.Expression, st: WalkState): { kind: RootKind; paramId?: string; varId?: string } {
    let e: ts.Expression = expr;
    for (;;) {
      e = stripParens(e);
      if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) { e = e.expression; continue; }
      if (ts.isAwaitExpression(e)) { e = e.expression; continue; }
      break;
    }
    if (e.kind === ts.SyntaxKind.ThisKeyword) return { kind: 'this' };
    if (ts.isCallExpression(e) || ts.isNewExpression(e)) return { kind: ts.isNewExpression(e) ? 'local_created' : 'call_result' };
    if (!ts.isIdentifier(e)) return { kind: 'unknown' };
    const checker = this.env.project.checker;
    const sym = checker.getSymbolAtLocation(e);
    const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
    if (!decl) return { kind: 'unknown' };
    if (ts.isParameter(decl)) {
      const info = declInfo(this.env.project, decl);
      return info && decl.parent === st.owner.fn ? { kind: 'parameter', paramId: info.id } : { kind: 'parameter_derived' };
    }
    if (ts.isBindingElement(decl)) {
      let n: ts.Node = decl;
      while (n && !ts.isParameter(n) && !ts.isVariableDeclaration(n)) n = n.parent;
      if (n && ts.isParameter(n)) { const info = declInfo(this.env.project, n); return { kind: 'parameter_derived', paramId: info?.id }; }
      return { kind: 'call_result' };
    }
    if (ts.isVariableDeclaration(decl)) {
      const info = declInfo(this.env.project, decl);
      if (info && this.env.ctx.hasNode(info.id)) return { kind: 'module_var', varId: info.id };
      let init = decl.initializer ? stripParens(decl.initializer) : undefined;
      if (init && ts.isAwaitExpression(init)) init = stripParens(init.expression);
      if (!init || ts.isObjectLiteralExpression(init) || ts.isArrayLiteralExpression(init) || ts.isNewExpression(init) ||
          ts.isLiteralExpression(init) || ts.isTemplateExpression(init)) return { kind: 'local_created' };
      if (ts.isCallExpression(init)) return { kind: 'call_result' };
      return { kind: 'unknown' };
    }
    return { kind: 'unknown' };
  }

  /** Project property node written/mutated by an lvalue-ish expression, if any. */
  private propertyOf(expr: ts.Expression): DeclInfo | null {
    const e = stripParens(expr);
    if (ts.isPropertyAccessExpression(e)) return valueTarget(this.env, e.name);
    return null;
  }

  onAssignment(node: ts.Node, st: WalkState): void {
    const { env } = this;
    const sf = node.getSourceFile();
    let target: ts.Expression | undefined;
    let op = '=';
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      target = node.left; op = node.operatorToken.getText(sf);
    } else if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
               (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) {
      target = node.operand; op = '++/--';
    } else if (ts.isDeleteExpression(node)) { target = node.expression; op = 'delete'; }
    if (!target) return;
    const t = stripParens(target);
    if (ts.isObjectLiteralExpression(t) || ts.isArrayLiteralExpression(t)) return; // destructuring assignment (unsupported)
    const at = { file: st.owner.file, line: startOf(sf, t).line, col: startOf(sf, t).col };
    const ev = shortText(node.getText(sf), 140);
    const root = this.rootOf(t, st);
    const isProp = ts.isPropertyAccessExpression(t) || ts.isElementAccessExpression(t);

    let writeDst: DeclInfo | null = null;
    if (ts.isIdentifier(t)) { const v = valueTarget(env, t); if (v && v.type === 'variable') writeDst = v; }
    else writeDst = this.propertyOf(t);
    const pos = ts.isPropertyAccessExpression(t) ? startOf(sf, t.name) : at;
    const loc = { file: at.file, line: pos.line, col: pos.col };
    const expr = shortText(t.getText(sf), 100);
    if (writeDst && op !== 'delete') {
      emitEffect(env, st, { type: 'WRITES', dst: writeDst.id, ...loc, extraction: 'ts-checker', confidence: 1, verification: 'static_verified', evidence: ev, meta: { op, target: expr, root: root.kind } });
    }
    if (isProp && !(root.kind === 'this' && st.owner.isConstructor) && ['this', 'parameter', 'parameter_derived', 'call_result', 'module_var'].includes(root.kind)) {
      const dst = writeDst?.id ?? root.paramId ?? root.varId ?? null;
      if (dst && env.ctx.hasNode(dst)) {
        emitEffect(env, st, { type: 'MUTATES', dst, ...loc, extraction: 'ts-checker', confidence: 1, verification: 'static_verified', evidence: ev, meta: { op, target: expr, root: root.kind, target_kind: writeDst ? 'property' : 'root_object' } });
      }
    }
  }

  onPropertyRead(node: ts.PropertyAccessExpression | ts.ElementAccessExpression, st: WalkState): void {
    const { env } = this;
    const sf = node.getSourceFile();
    const p = node.parent;
    // process.env.X / process.env['X']
    const objText = stripParens(node.expression).getText(sf);
    if (objText === 'process.env') {
      const key = ts.isPropertyAccessExpression(node) ? node.name.text : ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : null;
      if (key) {
        const id = ensureConfigNode(env, `env.${key}`, 'process.env');
        const s = startOf(sf, node);
        emitEffect(env, st, { type: 'READS', dst: id, file: st.owner.file, line: s.line, col: s.col, extraction: 'process-env', confidence: 1, verification: 'static_verified', evidence: shortText(node.getText(sf), 100), meta: { config_key: `env.${key}`, source: 'process.env' } }, { branch: false });
      }
      return;
    }
    if (!ts.isPropertyAccessExpression(node)) return;
    if (p && ts.isCallExpression(p) && p.expression === node) return; // method call -> CALLS
    if (p && ts.isBinaryExpression(p) && p.left === node && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) return; // pure write
    if (p && ts.isDeleteExpression(p)) return;
    const info = valueTarget(env, node.name);
    if (!info || info.type !== 'property') return;
    // skip DI-style parameter properties typed as classes/interfaces (represented by INJECTS_DEPENDENCY + CALLS)
    if (ts.isParameter(info.decl)) {
      const ty = env.project.checker.getTypeAtLocation(node);
      if (ty.symbol && (ty.symbol.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface))) return;
    }
    const s = startOf(sf, node.name);
    emitEffect(env, st, { type: 'READS', dst: info.id, file: st.owner.file, line: s.line, col: s.col, extraction: 'ts-checker', confidence: 1, verification: 'static_verified', evidence: shortText(node.getText(sf), 100), meta: { access: shortText(node.getText(sf), 80) } }, { branch: false });
  }

  onIdentifierRead(id: ts.Identifier, sym: ts.Symbol, st: WalkState): void {
    const { env } = this;
    const p = id.parent;
    if (p && ts.isCallExpression(p) && p.expression === id) return;
    if (p && ts.isBinaryExpression(p) && p.left === id && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) return;
    const info = valueTarget(env, id, sym);
    if (!info || info.type !== 'variable' || info.decl === st.owner.decl) return;
    if (env.ctx.nodes.get(info.id)?.meta.synthetic) return;
    const s = startOf(id.getSourceFile(), id);
    emitEffect(env, st, { type: 'READS', dst: info.id, file: st.owner.file, line: s.line, col: s.col, extraction: 'ts-checker', confidence: 1, verification: 'static_verified', evidence: shortText(id.parent.getText(id.getSourceFile()), 100), meta: { variable: id.text } }, { branch: false });
  }

  onCall(res: CallResolution, st: WalkState): void {
    const { env } = this;
    const node = res.node;
    const sf = node.getSourceFile();
    const ev = res.text;
    const args = node.arguments ?? ([] as unknown as ts.NodeArray<ts.Expression>);

    // ---- config-key reads
    if (res.kind === 'call' && ts.isPropertyAccessExpression(stripParens(node.expression)) && args.length > 0 && ts.isStringLiteralLike(args[0])) {
      const method = (stripParens(node.expression) as ts.PropertyAccessExpression).name.text;
      if (method === 'get' || method === 'getOrThrow') {
        const viaPkg = res.status === 'external' && res.pkg === '@nestjs/config';
        let viaName = false;
        if (!viaPkg && res.receiver) {
          try { viaName = /^ConfigService\b/.test(env.project.checker.typeToString(env.project.checker.getTypeAtLocation(res.receiver))); } catch { /* ignore */ }
        }
        if (viaPkg || viaName) {
          const key = args[0].text;
          const id = ensureConfigNode(env, key, 'nestjs-config');
          emitEffect(env, st, {
            type: 'READS', dst: id, file: st.owner.file, line: res.line, col: res.col,
            extraction: viaPkg ? 'nestjs-config-service' : 'name-heuristic-config-service',
            confidence: viaPkg ? 0.9 : 0.6, verification: viaPkg ? 'framework_inferred' : 'semantic_inferred',
            evidence: ev, meta: { config_key: key, method, source: 'nestjs-config' },
          }, { branch: false });
        }
      }
    }

    // ---- mutating calls
    if (res.status === 'stdlib' && res.member && res.receiver && MUTATING_MEMBER.test(res.member)) {
      this.mutatingCall(res.receiver, res, st, res.member.split('.')[1]);
    } else if (res.status === 'stdlib' && res.member && MUTATING_STATIC.test(res.member) && args.length) {
      this.mutatingCall(args[0], res, st, res.member.split('.')[1]);
    }

    // ---- PASSES_TO / RECEIVES_FROM / RETURNS_VALUE_TO
    if (res.status !== 'internal') return;
    const n = res.targets.length;
    for (const t of res.targets) {
      if (!t.nodeId || !t.info || (t.info.type !== 'function' && t.info.type !== 'method')) continue;
      const nd = normalizeDecl(t.decl);
      const fn = ts.isFunctionLike(nd) ? nd : (ts.isVariableDeclaration(nd) || ts.isPropertyDeclaration(nd)) && isFnInit(nd.initializer) ? nd.initializer : null;
      const params = fn ? (fn as ts.SignatureDeclaration).parameters : undefined;
      const verification = res.ambiguous ? 'ambiguous' as const : 'static_verified' as const;
      const conf = res.ambiguous ? 1 / n : 1;
      if (params && params.length) {
        args.forEach((arg, i) => {
          const pi = i < params.length ? i : params[params.length - 1].dotDotDotToken ? params.length - 1 : -1;
          if (pi < 0) return;
          const pinfo = declInfo(env.project, params[pi]);
          if (!pinfo || !env.ctx.hasNode(pinfo.id)) return;
          const s = startOf(sf, arg);
          emitEffect(env, st, {
            type: 'PASSES_TO', dst: pinfo.id, file: st.owner.file, line: s.line, col: s.col, extraction: 'ts-checker', confidence: conf, verification,
            evidence: shortText(arg.getText(sf), 100),
            meta: { arg_index: i, arg: shortText(arg.getText(sf), 100), param: ts.isIdentifier(params[pi].name) ? (params[pi].name as ts.Identifier).text : `$${pi}`, callee: t.nodeId, spread: ts.isSpreadElement(arg) || undefined },
          }, { branch: false });
        });
      }
      // result binding
      if (res.kind === 'new' || res.kind === 'super') continue;
      let cur: ts.Node = node;
      let awaited = false;
      while (cur.parent && (ts.isParenthesizedExpression(cur.parent) || ts.isAwaitExpression(cur.parent) || ts.isAsExpression(cur.parent) || ts.isNonNullExpression(cur.parent) || ts.isTypeAssertionExpression(cur.parent))) {
        if (ts.isAwaitExpression(cur.parent)) awaited = true;
        cur = cur.parent;
      }
      const par = cur.parent;
      let variable: string | null = null;
      if (par && ts.isVariableDeclaration(par) && par.initializer === cur) variable = par.name.getText(sf);
      else if (par && ts.isBinaryExpression(par) && par.right === cur && par.operatorToken.kind === ts.SyntaxKind.EqualsToken) variable = shortText(par.left.getText(sf), 80);
      if (variable) {
        const meta = { variable: shortText(variable, 80), awaited, callee: t.nodeId, caller: st.owner.id };
        const common = { file: st.owner.file, line: res.line, col: res.col, extraction: 'ts-checker', confidence: conf, verification, evidence: ev, meta };
        emitEffect(env, st, { type: 'RECEIVES_FROM', dst: t.nodeId, ...common }, { branch: false });
        env.ctx.edge({ type: 'RETURNS_VALUE_TO', src: t.nodeId, dst: st.owner.id, ...common });
      }
    }
  }

  private mutatingCall(target: ts.Expression, res: CallResolution, st: WalkState, op: string): void {
    const { env } = this;
    const root = this.rootOf(target, st);
    if (!['this', 'parameter', 'parameter_derived', 'call_result', 'module_var'].includes(root.kind)) return;
    if (root.kind === 'this' && st.owner.isConstructor) return;
    const prop = this.propertyOf(target);
    const dst = prop?.id ?? root.paramId ?? root.varId ?? null;
    if (!dst || !env.ctx.hasNode(dst)) return;
    emitEffect(env, st, {
      type: 'MUTATES', dst, file: st.owner.file, line: res.line, col: res.col, extraction: 'ts-checker', confidence: 1, verification: 'static_verified',
      evidence: res.text, meta: { op, mutating_call: res.member, target: shortText(target.getText(target.getSourceFile()), 100), root: root.kind, target_kind: prop ? 'property' : 'root_object' },
    });
  }
}
