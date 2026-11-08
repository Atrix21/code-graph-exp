/**
 * Control-flow nodes and edges, per function-like owner:
 *   condition (if / ternary / switch case / &&,||,?? guard statements / loop conditions),
 *   branch (true/false/case), loop, return, exception_handler,
 *   CHECKS, BRANCHES_TO, RETURNS, THROWS, CATCHES, LOOPS.
 * Branch regions are registered on child nodes; the body walker pushes them while descending so that
 * effects inside a branch carry `meta.guard` and are mirrored as branch-level edges.
 */
import ts from 'typescript';
import type { BranchRef, Env, WalkState } from './graph-context.js';
import { currentGuard, emitEffect, STDLIB_ID, UNRESOLVED_ID } from './graph-context.js';
import { externalMeta, externalPackageOf, stripParens } from './call-extractor.js';
import { collectValueRefs } from './data-flow-extractor.js';
import { declInfo } from './symbol-extractor.js';
import { shortText, spanOf, startOf } from './typescript-parser.js';

function isTailReturn(ret: ts.Node, body: ts.Node): boolean {
  let cur: ts.Node = ret;
  while (cur !== body) {
    const p: ts.Node | undefined = cur.parent;
    if (!p) return false;
    if (ts.isBlock(p)) {
      if (p.statements[p.statements.length - 1] !== cur) return false;
      if (p === body) return true;
      cur = p;
    } else if (ts.isIfStatement(p)) cur = p;
    else if (ts.isCaseClause(p) || ts.isDefaultClause(p)) {
      if (p.statements[p.statements.length - 1] !== cur) return false;
      cur = p.parent.parent;
    } else if (ts.isTryStatement(p)) {
      if (p.finallyBlock && cur !== p.finallyBlock) return false;
      cur = p;
    } else if (ts.isCatchClause(p)) cur = p.parent;
    else return false;
  }
  return true;
}

export class ControlFlow {
  readonly regionOf = new Map<ts.Node, BranchRef>();
  readonly handlerRegion = new Map<ts.Node, string>(); // catch block -> handler id
  readonly tryRegion = new Map<ts.Node, string>(); // try block -> handler id

  constructor(private env: Env) {}

  private posId(type: string, st: WalkState, node: ts.Node, kind?: string): string {
    const p = startOf(st.owner.sf, node);
    const base = `${type}:${st.owner.file}#${st.owner.qualified}@L${p.line}:C${p.col}`;
    return kind ? this.env.ctx.uniqueId(base, kind) : base;
  }

  private contains(st: WalkState, dst: string, node: ts.Node) {
    const p = startOf(st.owner.sf, node);
    this.env.ctx.edge({ type: 'CONTAINS', src: st.owner.id, dst, file: st.owner.file, line: p.line, col: p.col, extraction: 'ts-syntax', confidence: 1, verification: 'static_verified', key: 'contains' });
  }

  private makeCondition(st: WalkState, node: ts.Node, kind: string, text: string, checked: ts.Node[], meta: Record<string, unknown> = {}): string {
    const { ctx } = this.env;
    const o = st.owner;
    const id = this.posId('condition', st, node, kind);
    const guard = currentGuard(st);
    ctx.node('condition', id, shortText(text, 80), `${o.qualified}@${id.split('@')[1]}`, o.file, spanOf(o.sf, node), {
      symbol_key: o.symbolKey, kind, text: shortText(text, 300), owner: o.id, depth: st.branchStack.length,
      parent_branch: guard?.branchId, ...meta,
    });
    this.contains(st, id, node);
    const p = startOf(o.sf, node);
    emitEffect(this.env, st, { type: 'CHECKS', dst: id, file: o.file, line: p.line, col: p.col, extraction: 'ts-syntax', confidence: 1, verification: 'static_verified', evidence: shortText(text, 140), meta: { condition_kind: kind } }, { branch: false });
    const seen = new Set<string>();
    for (const c of checked) {
      for (const r of collectValueRefs(this.env, c)) {
        const s = startOf(o.sf, r.node);
        const k = `${r.info.id}@${s.line}:${s.col}`;
        if (seen.has(k)) continue;
        seen.add(k);
        ctx.edge({ type: 'CHECKS', src: id, dst: r.info.id, file: o.file, line: s.line, col: s.col, extraction: 'ts-checker', confidence: 1, verification: 'static_verified', evidence: shortText(r.node.parent?.getText(o.sf) ?? r.node.getText(o.sf), 100), meta: { target_kind: r.info.type } });
      }
    }
    return id;
  }

  private makeBranch(st: WalkState, condId: string, node: ts.Node, polarity: string, extra: Record<string, unknown> = {}): BranchRef {
    const { ctx } = this.env;
    const o = st.owner;
    const id = this.posId('branch', st, node);
    const sp = spanOf(o.sf, node);
    ctx.node('branch', id, `${polarity} branch`, `${o.qualified}@${id.split('@')[1]}`, o.file, sp, {
      symbol_key: o.symbolKey, polarity, condition_id: condId, owner: o.id, text: shortText(node.getText(o.sf), 120),
      start_line: sp.start_line, end_line: sp.end_line, ...extra,
    });
    this.contains(st, id, node);
    ctx.edge({ type: 'BRANCHES_TO', src: condId, dst: id, file: o.file, line: sp.start_line, col: sp.start_col, extraction: 'ts-syntax', confidence: 1, verification: 'static_verified', evidence: shortText(node.getText(o.sf), 100), meta: { polarity, start_line: sp.start_line, end_line: sp.end_line, ...extra } });
    const ref: BranchRef = { conditionId: condId, branchId: id, polarity };
    this.regionOf.set(node, ref);
    return ref;
  }

  /** Called when the walker enters `node`. */
  enter(node: ts.Node, st: WalkState): void {
    const o = st.owner;
    const sf = o.sf;
    if (ts.isIfStatement(node)) {
      const text = node.expression.getText(sf);
      const c = this.makeCondition(st, node, 'if', text, [node.expression], { has_else: !!node.elseStatement });
      this.makeBranch(st, c, node.thenStatement, 'true');
      if (node.elseStatement) this.makeBranch(st, c, node.elseStatement, 'false', ts.isIfStatement(node.elseStatement) ? { else_if: true } : {});
    } else if (ts.isConditionalExpression(node)) {
      const c = this.makeCondition(st, node, 'ternary', node.condition.getText(sf), [node.condition]);
      this.makeBranch(st, c, node.whenTrue, 'true');
      this.makeBranch(st, c, node.whenFalse, 'false');
    } else if (ts.isExpressionStatement(node)) {
      const e = stripParens(node.expression);
      if (ts.isBinaryExpression(e) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(e.operatorToken.kind)) {
        const op = e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ? '&&' : e.operatorToken.kind === ts.SyntaxKind.BarBarToken ? '||' : '??';
        const c = this.makeCondition(st, node, 'guard', e.left.getText(sf), [e.left], { operator: op });
        this.makeBranch(st, c, e.right, op === '&&' ? 'true' : 'false', { operator: op });
      }
    } else if (ts.isSwitchStatement(node)) {
      const swText = node.expression.getText(sf);
      for (const clause of node.caseBlock.clauses) {
        const isDefault = ts.isDefaultClause(clause);
        const label = isDefault ? 'default' : (clause as ts.CaseClause).expression.getText(sf);
        const checked = isDefault ? [node.expression] : [node.expression, (clause as ts.CaseClause).expression];
        const c = this.makeCondition(st, clause, 'switch_case', isDefault ? `switch (${swText}) default` : `switch (${swText}) case ${label}`, checked, { case_label: shortText(label, 80), is_default: isDefault });
        const ref = this.makeBranch(st, c, clause, 'case', { case_label: shortText(label, 80), is_default: isDefault, fallthrough: clause.statements.length === 0 });
        for (const s of clause.statements) this.regionOf.set(s, ref);
        this.regionOf.delete(clause); // region is applied to the clause's statements only
      }
    } else if (ts.isForStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)) {
      const kind = ts.isForStatement(node) ? 'for' : ts.isWhileStatement(node) ? 'while' : ts.isDoStatement(node) ? 'do_while' : ts.isForOfStatement(node) ? 'for_of' : 'for_in';
      const loopId = this.posId('loop', st, node);
      const p = startOf(sf, node);
      let text: string; let checked: ts.Node[];
      if (ts.isForStatement(node)) { text = node.condition?.getText(sf) ?? '<no condition>'; checked = node.condition ? [node.condition] : []; }
      else if (ts.isWhileStatement(node) || ts.isDoStatement(node)) { text = node.expression.getText(sf); checked = [node.expression]; }
      else { text = `${node.initializer.getText(sf)} ${kind === 'for_of' ? 'of' : 'in'} ${node.expression.getText(sf)}`; checked = [node.expression]; }
      const sp = spanOf(sf, node);
      this.env.ctx.node('loop', loopId, `${kind} loop`, `${o.qualified}@${loopId.split('@')[1]}`, o.file, sp, {
        symbol_key: o.symbolKey, kind, text: shortText(text, 200), owner: o.id, depth: st.branchStack.length,
        async_iteration: ts.isForOfStatement(node) && !!node.awaitModifier || undefined,
      });
      this.contains(st, loopId, node);
      emitEffect(this.env, st, { type: 'LOOPS', dst: loopId, file: o.file, line: p.line, col: p.col, extraction: 'ts-syntax', confidence: 1, verification: 'static_verified', evidence: shortText(text, 120), meta: { loop_kind: kind } });
      const c = this.makeCondition(st, node, `loop_${kind}`, text, checked, { loop_id: loopId });
      this.env.ctx.nodes.get(loopId)!.meta.condition_id = c;
      this.makeBranch(st, c, node.statement, 'true', { loop_id: loopId });
    } else if (ts.isTryStatement(node)) {
      const cc = node.catchClause;
      if (!cc) return;
      const id = this.posId('exception_handler', st, cc);
      const p = startOf(sf, cc);
      const sp = spanOf(sf, cc);
      const tsp = spanOf(sf, node.tryBlock);
      const v = cc.variableDeclaration;
      this.env.ctx.node('exception_handler', id, 'catch', `${o.qualified}@${id.split('@')[1]}`, o.file, sp, {
        symbol_key: o.symbolKey, kind: 'catch', owner: o.id, variable: v?.name.getText(sf),
        caught_type: v?.type?.getText(sf), try_start_line: tsp.start_line, try_end_line: tsp.end_line,
        has_finally: !!node.finallyBlock, text: shortText(`catch (${v?.getText(sf) ?? ''})`, 80),
      });
      this.contains(st, id, cc);
      emitEffect(this.env, st, { type: 'CATCHES', dst: id, file: o.file, line: p.line, col: p.col, extraction: 'ts-syntax', confidence: 1, verification: 'static_verified', evidence: shortText(`catch (${v?.getText(sf) ?? ''})`, 80), meta: { try_start_line: tsp.start_line, try_end_line: tsp.end_line } });
      this.tryRegion.set(node.tryBlock, id);
      this.handlerRegion.set(cc.block, id);
    } else if (ts.isReturnStatement(node)) {
      if (st.callbackDepth === 0) this.returnNode(st, node, node.expression, false);
    } else if (ts.isThrowStatement(node)) {
      this.throwEdge(st, node);
    }
  }

  /** Expression-bodied arrow owner: implicit return. */
  implicitReturn(st: WalkState, expr: ts.Expression): void {
    this.returnNode(st, expr, expr, true);
  }

  private returnNode(st: WalkState, at: ts.Node, expr: ts.Expression | undefined, implicit: boolean): void {
    const o = st.owner;
    const fnBody = o.fn && (o.fn as ts.FunctionLikeDeclaration).body;
    const id = this.posId('return', st, at);
    const early = implicit || !fnBody ? false : !isTailReturn(at, fnBody);
    const guard = currentGuard(st);
    const sp = spanOf(o.sf, at);
    const text = expr ? expr.getText(o.sf) : '';
    this.env.ctx.node('return', id, implicit ? 'implicit return' : 'return', `${o.qualified}@${id.split('@')[1]}`, o.file, sp, {
      symbol_key: o.symbolKey, expression: shortText(text, 200), early_return: early, implicit, has_value: !!expr, owner: o.id,
      in_branch: !!guard, guard: guard ? { condition_id: guard.conditionId, polarity: guard.polarity } : undefined,
      returns_awaited_call: expr ? ts.isAwaitExpression(stripParens(expr)) && ts.isCallExpression(stripParens((stripParens(expr) as ts.AwaitExpression).expression)) || undefined : undefined,
    });
    this.contains(st, id, at);
    emitEffect(this.env, st, { type: 'RETURNS', dst: id, file: o.file, line: sp.start_line, col: sp.start_col, extraction: 'ts-syntax', confidence: 1, verification: 'static_verified', evidence: shortText(implicit ? text : `return ${text}`, 140), meta: { expression: shortText(text, 120), early_return: early } });
  }

  private throwEdge(st: WalkState, node: ts.ThrowStatement): void {
    const { env } = this;
    const { ctx, project } = env;
    const o = st.owner;
    const expr = stripParens(node.expression);
    const p = startOf(o.sf, node);
    let dst = ctx.ensureSpecial(UNRESOLVED_ID, '<unresolved>', 'unresolved_placeholder');
    let verification: 'static_verified' | 'unknown' = 'unknown';
    let conf = 0;
    let cls: string | undefined;
    let resolvedVia = 'unresolved';
    try {
      const ty = project.checker.getTypeAtLocation(expr);
      const sym = ty.getSymbol() ?? ty.aliasSymbol;
      const decl = sym?.declarations?.find((d) => ts.isClassDeclaration(d) || ts.isInterfaceDeclaration(d));
      if (sym && decl && !(ty.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) {
        cls = sym.name;
        const rel = project.relOf(decl.getSourceFile());
        if (rel) {
          const info = declInfo(project, decl);
          if (info && ctx.hasNode(info.id)) { dst = info.id; verification = 'static_verified'; conf = 1; resolvedVia = 'project_class'; }
        } else if (project.isLib(decl.getSourceFile())) {
          dst = ctx.ensureSpecial(STDLIB_ID, '<stdlib>', 'language_builtin'); verification = 'static_verified'; conf = 1; resolvedVia = 'stdlib_class';
        } else {
          const pkg = externalPackageOf(decl);
          dst = ctx.ensureExternal(pkg, externalMeta(env, pkg)); verification = 'static_verified'; conf = 1; resolvedVia = 'external_class';
        }
      }
    } catch { /* unresolved */ }
    const caught = ts.isIdentifier(expr) ? (() => {
      const d = project.checker.getSymbolAtLocation(expr)?.valueDeclaration;
      return !!d && ts.isVariableDeclaration(d) && ts.isCatchClause(d.parent);
    })() : false;
    emitEffect(env, st, {
      type: 'THROWS', dst, file: o.file, line: p.line, col: p.col, extraction: 'ts-checker', confidence: conf, verification,
      evidence: shortText(node.getText(o.sf), 140),
      meta: { exception_class: cls, expression: shortText(expr.getText(o.sf), 100), resolved_via: resolvedVia, rethrow: caught || undefined, thrown_by: ts.isNewExpression(expr) ? 'new' : ts.isCallExpression(expr) ? 'call_result' : 'value' },
    });
  }

  /** Pushes any regions registered on `node`; returns a pop function (or null). */
  pushRegions(node: ts.Node, st: WalkState): (() => void) | null {
    const pops: (() => void)[] = [];
    const b = this.regionOf.get(node);
    if (b) { st.branchStack.push(b); pops.push(() => st.branchStack.pop()); }
    const t = this.tryRegion.get(node);
    if (t) { st.tryStack.push(t); pops.push(() => st.tryStack.pop()); }
    const h = this.handlerRegion.get(node);
    if (h) { st.handlerStack.push(h); pops.push(() => st.handlerStack.pop()); }
    return pops.length ? () => pops.reverse().forEach((f) => f()) : null;
  }
}
