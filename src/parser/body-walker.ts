/**
 * Pass 3: walk every owner's code (function bodies, initializers, decorators) once, dispatching each AST
 * node to the control-flow, call, data-flow, framework and reference collectors.
 */
import ts from 'typescript';
import type { Env, Owner, WalkState } from './graph-context.js';
import { handleCall } from './call-extractor.js';
import { ControlFlow } from './control-flow-extractor.js';
import { DataFlow } from './data-flow-extractor.js';
import { FrameworkExtractor } from './framework-extractor.js';
import { ReferenceCollector } from './structural-extractor.js';
import { declInfo, type SymbolPass } from './symbol-extractor.js';

const DECL_KINDS = (n: ts.Node) =>
  ts.isClassDeclaration(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n) || ts.isEnumDeclaration(n) ||
  ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessorDeclaration(n) ||
  ts.isSetAccessorDeclaration(n) || ts.isPropertyDeclaration(n) || ts.isMethodSignature(n) || ts.isPropertySignature(n) ||
  ts.isVariableDeclaration(n);

export function walkOwners(env: Env, pass: SymbolPass, fw: FrameworkExtractor): void {
  const { project } = env;
  const cf = new ControlFlow(env);
  const df = new DataFlow(env);
  const refs = new ReferenceCollector(env);

  for (const owner of env.owners) {
    if (owner.type === 'interface' || owner.type === 'type') continue;
    const st: WalkState = { owner, branchStack: [], tryStack: [], handlerStack: [], callbackDepth: 0 };
    refs.reset();
    cf.regionOf.clear(); cf.tryRegion.clear(); cf.handlerRegion.clear();
    const root = owner.decl;

    const isBoundary = (n: ts.Node): boolean => {
      if (n === root || !DECL_KINDS(n)) return false;
      const info = declInfo(project, n);
      return !!info && info.id !== owner.id && env.ctx.hasNode(info.id);
    };

    const walk = (node: ts.Node): void => {
      if (isBoundary(node)) return;
      const pop = cf.pushRegions(node, st);
      cf.enter(node, st);

      let cb = false;
      if (ts.isFunctionLike(node) && node !== owner.fn && !ts.isMethodSignature(node)) cb = true;
      if (cb) st.callbackDepth++;

      if ((ts.isCallExpression(node) && node.expression.kind !== ts.SyntaxKind.ImportKeyword) || ts.isNewExpression(node)) {
        const res = handleCall(env, st, node);
        if (res.classNodeId) refs.instantiated.add(res.classNodeId);
        df.onCall(res, st);
        fw.onCall(res, st);
      } else if (ts.isBinaryExpression(node) || ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node) || ts.isDeleteExpression(node)) {
        df.onAssignment(node, st);
      } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        df.onPropertyRead(node, st);
      } else if (ts.isIdentifier(node)) {
        const sym = refs.onIdentifier(node, st);
        if (sym) df.onIdentifierRead(node, sym, st);
      }
      ts.forEachChild(node, walk);
      if (cb) st.callbackDepth--;
      pop?.();
    };

    if (owner.type === 'file') {
      for (const s of pass.moduleCode.get(owner.file) ?? []) walk(s);
    } else if (owner.type === 'class') {
      const cls = owner.decl as ts.ClassDeclaration;
      for (const d of (ts.canHaveDecorators(cls) ? ts.getDecorators(cls) ?? [] : [])) walk(d);
      for (const h of cls.heritageClauses ?? []) for (const t of h.types) {
        walk(t.expression);
        if (t.typeArguments) t.typeArguments.forEach(walk);
      }
    } else {
      const fnBody = owner.fn && (owner.fn as ts.FunctionLikeDeclaration).body;
      if (fnBody && !ts.isBlock(fnBody) && owner.fn && ts.isArrowFunction(owner.fn)) cf.implicitReturn(st, fnBody as ts.Expression);
      ts.forEachChild(root, walk);
    }
    refs.flush(st);
  }
}

export type { Owner };
