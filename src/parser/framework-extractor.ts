/**
 * Framework-level extraction (NestJS / TypeORM / Mongoose / external APIs / events).
 *
 * Verification policy (see research/notes/graph-design.md):
 *   - decorator/DI/naming-convention derived edges are `framework_inferred` (never `static_verified`);
 *   - pure name heuristics are `semantic_inferred`;
 *   - the underlying call/type resolution is already represented by static_verified CALLS/HAS_TYPE edges.
 */
import ts from 'typescript';
import type { Env, FrameworkIndex, WalkState } from './graph-context.js';
import { emitEffect } from './graph-context.js';
import { externalMeta, externalPackageOf, stripParens, type CallResolution } from './call-extractor.js';
import { aliasTarget, declInfo, decoratorTexts, symbolKey, type SymbolPass } from './symbol-extractor.js';
import { shortText, spanOf, startOf } from './typescript-parser.js';

/** Explicit list of packages whose calls are reported as CALLS_EXTERNAL_API. */
export const EXTERNAL_API_PACKAGES = [
  '@aws-sdk/*', 'aws-sdk', 'nodemailer', 'google-auth-library', 'apple-signin-auth',
  'axios', '@nestjs/axios', 'node-fetch', 'got', 'undici', 'fetch',
];
const isApiPackage = (pkg: string) => EXTERNAL_API_PACKAGES.some((p) => (p.endsWith('/*') ? pkg.startsWith(p.slice(0, -1)) : pkg === p));

const DB_PACKAGES = new Set(['typeorm', 'mongoose', '@nestjs/typeorm', '@nestjs/mongoose']);
const DB_MODIFIERS = new Set(['sort', 'skip', 'limit', 'populate', 'select', 'lean', 'exec', 'where', 'orderBy', 'take', 'join', 'leftJoinAndSelect', 'cursor', 'session', 'hint', 'collation', 'then', 'catch', 'finally', 'andWhere', 'orWhere', 'innerJoin', 'leftJoin']);
export function dbOp(name: string): string {
  if (/delete|remove/i.test(name)) return 'delete';
  if (/update|upsert|replace|increment|decrement/i.test(name)) return 'update';
  if (/^(save|insert|create|bulkWrite)|insertMany/i.test(name)) return 'save';
  if (/count|exists/i.test(name)) return 'count';
  if (/^(find|get|aggregate|distinct|query)/i.test(name)) return 'find';
  return name;
}

interface Deco { name: string; args: readonly ts.Expression[]; node: ts.Decorator; pkg: string | null }

export class FrameworkExtractor {
  readonly index: FrameworkIndex = { roles: new Map(), bindings: new Map(), entities: new Map(), implementers: new Map() };
  private dbWithoutEntity = 0;

  constructor(private env: Env) { env.fw = this.index; }

  // ------------------------------------------------------------ helpers
  private decos(node: ts.Node): Deco[] {
    if (!ts.canHaveDecorators(node)) return [];
    const out: Deco[] = [];
    for (const d of ts.getDecorators(node) ?? []) {
      const e = d.expression;
      const callee = ts.isCallExpression(e) ? stripParens(e.expression) : e;
      const nameNode = ts.isIdentifier(callee) ? callee : ts.isPropertyAccessExpression(callee) ? callee.name : null;
      if (!nameNode) continue;
      let pkg: string | null = null;
      try {
        const sym = aliasTarget(this.env.project.checker, this.env.project.checker.getSymbolAtLocation(nameNode));
        const decl = sym?.declarations?.[0];
        if (decl && !this.env.project.relOf(decl.getSourceFile())) pkg = externalPackageOf(decl);
      } catch { /* unresolved */ }
      out.push({ name: nameNode.text, args: ts.isCallExpression(e) ? e.arguments : [], node: d, pkg });
    }
    return out;
  }

  private lit(e: ts.Expression | undefined): string | null {
    if (!e) return null;
    const x = stripParens(e);
    if (ts.isStringLiteralLike(x) || ts.isNumericLiteral(x)) return x.text;
    if (ts.isArrayLiteralExpression(x) && x.elements.length) return this.lit(x.elements[0] as ts.Expression);
    return null;
  }
  private objProp(e: ts.Expression | undefined, name: string): ts.Expression | undefined {
    if (!e || !ts.isObjectLiteralExpression(e)) return undefined;
    for (const p of e.properties) if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name) return p.initializer;
    return undefined;
  }
  private classIdOfExpr(expr: ts.Expression): string | null {
    const x = stripParens(expr);
    const id = ts.isIdentifier(x) ? x : ts.isPropertyAccessExpression(x) ? x.name : null;
    if (!id) return null;
    const sym = aliasTarget(this.env.project.checker, this.env.project.checker.getSymbolAtLocation(id));
    const decl = sym?.declarations?.find((d) => ts.isClassDeclaration(d) || ts.isInterfaceDeclaration(d));
    const info = decl ? declInfo(this.env.project, decl) : null;
    return info && this.env.ctx.hasNode(info.id) ? info.id : null;
  }
  private classOwners() {
    return this.env.owners.filter((o) => o.type === 'class' && ts.isClassDeclaration(o.decl));
  }

  // ------------------------------------------------------------ pre-pass
  prepare(pass: SymbolPass): void {
    void pass;
    this.computeRoles();
    this.computeImplementers();
    this.scanBindings();
    this.dbEntities();
    this.routes();
    this.injections();
    this.eventConsumers();
  }

  private computeRoles() {
    const { env } = this;
    const names = new Map<string, string>();
    for (const o of this.classOwners()) names.set(o.id, o.qualified);
    const ancestors = (id: string, seen = new Set<string>()): Set<string> => {
      const h = env.heritage.get(id);
      if (h) for (const a of [...h.extends, ...h.implements]) if (!seen.has(a)) { seen.add(a); ancestors(a, seen); }
      return seen;
    };
    for (const o of this.classOwners()) {
      const d = this.decos(o.decl);
      const dn = new Set(d.map((x) => x.name));
      const name = o.qualified;
      let role = 'class'; let source = 'default';
      if (dn.has('Controller')) { role = 'controller'; source = 'decorator'; }
      else if (dn.has('Entity') || dn.has('Schema')) { role = 'entity'; source = 'decorator'; }
      else if (/Repository$/.test(name)) { role = 'repository'; source = 'name'; }
      else if ([...ancestors(o.id)].some((a) => /Repository$/.test(env.ctx.nodes.get(a)?.qualified_name ?? ''))) { role = 'repository'; source = 'extends'; }
      else if (dn.has('Module')) { role = 'module'; source = 'decorator'; }
      else if (/Mapper$/.test(name)) { role = 'mapper'; source = 'name'; }
      else if (dn.has('Injectable')) {
        source = 'decorator';
        role = /Service$/.test(name) ? 'service' : /Guard$/.test(name) ? 'guard' : /Strategy$/.test(name) ? 'strategy' : /Interceptor$/.test(name) ? 'interceptor' : /Pipe$/.test(name) ? 'pipe' : 'provider';
      } else if (/Service$/.test(name)) { role = 'service'; source = 'name'; }
      else if (/Dto$/.test(name)) { role = 'dto'; source = 'name'; }
      this.index.roles.set(o.id, role);
      const n = env.ctx.nodes.get(o.id)!;
      n.meta.role = role; n.meta.role_source = source;
    }
    void names;
  }

  private computeImplementers() {
    const { env } = this;
    const anc = (id: string, seen: Set<string>) => {
      const h = env.heritage.get(id);
      if (!h) return;
      for (const a of [...h.extends, ...h.implements]) if (!seen.has(a)) { seen.add(a); anc(a, seen); }
    };
    for (const [id] of [...env.heritage].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const n = env.ctx.nodes.get(id);
      if (!n || n.type !== 'class' || n.meta.abstract) continue;
      const seen = new Set<string>();
      anc(id, seen);
      for (const a of seen) {
        let s = this.index.implementers.get(a);
        if (!s) this.index.implementers.set(a, (s = new Set()));
        s.add(id);
      }
    }
  }

  private scanBindings() {
    const { env } = this;
    for (const rel of env.project.files) {
      const sf = env.project.sourceFiles.get(rel);
      if (!sf) continue;
      const visit = (n: ts.Node) => {
        if (ts.isObjectLiteralExpression(n)) {
          const provide = this.objProp(n, 'provide');
          const useClass = this.objProp(n, 'useClass');
          if (provide && useClass) {
            const tok = this.classIdOfExpr(provide);
            const impl = this.classIdOfExpr(useClass);
            if (tok && impl) {
              const arr = this.index.bindings.get(tok) ?? [];
              arr.push({ impl, file: rel, line: startOf(sf, n).line });
              this.index.bindings.set(tok, arr);
            }
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    for (const arr of this.index.bindings.values()) arr.sort((a, b) => (a.impl + a.file + a.line < b.impl + b.file + b.line ? -1 : 1));
  }

  private dbEntities() {
    const { env } = this;
    const { ctx } = env;
    for (const o of this.classOwners()) {
      const cls = o.decl as ts.ClassDeclaration;
      const ds = this.decos(cls);
      const ent = ds.find((d) => d.name === 'Entity' || d.name === 'Schema');
      if (!ent) continue;
      const orm = ent.name === 'Entity' ? 'typeorm' : 'mongoose';
      const verified = ent.pkg === 'typeorm' || ent.pkg === '@nestjs/mongoose';
      const arg0 = ent.args[0];
      const table = ent.name === 'Entity' ? (this.lit(arg0) ?? this.lit(this.objProp(arg0, 'name'))) : this.lit(this.objProp(arg0, 'collection'));
      const columns: Record<string, unknown>[] = [];
      for (const m of cls.members) {
        if (!ts.isPropertyDeclaration(m) || !ts.isIdentifier(m.name)) continue;
        const cd = this.decos(m).find((d) => /^(Column|PrimaryGeneratedColumn|PrimaryColumn|CreateDateColumn|UpdateDateColumn|DeleteDateColumn|Prop|OneToMany|ManyToOne|OneToOne|ManyToMany|Index)$/.test(d.name));
        if (cd) columns.push({ name: m.name.text, decorator: cd.name, relation: /ToOne|ToMany/.test(cd.name) || undefined });
      }
      const id = `db_entity:${o.file}#${o.qualified}`;
      const sp = spanOf(o.sf, cls);
      ctx.node('db_entity', id, table ?? o.qualified, o.qualified, o.file, sp, {
        symbol_key: o.symbolKey, orm, class: o.id, table_or_collection: table, decorator: shortText(ent.node.getText(o.sf), 160),
        columns: columns.slice(0, 60), column_count: columns.length, framework_verified: verified,
      });
      this.index.entities.set(o.id, id);
      const p = startOf(o.sf, ent.node);
      ctx.edge({ type: 'DEFINES', src: o.id, dst: id, file: o.file, line: p.line, col: p.col, extraction: `${orm}-decorator`, confidence: verified ? 0.95 : 0.6, verification: verified ? 'framework_inferred' : 'semantic_inferred', evidence: shortText(ent.node.getText(o.sf), 100), meta: { orm } });
    }
  }

  private routes() {
    const { env } = this;
    const { ctx } = env;
    // app-level setup (global prefix / versioning) found anywhere in the corpus
    const setup: { prefix?: string; versioning?: string } = {};
    for (const rel of env.project.files) {
      const sf = env.project.sourceFiles.get(rel);
      if (!sf) continue;
      const visit = (n: ts.Node) => {
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
          if (n.expression.name.text === 'setGlobalPrefix' && n.arguments[0]) setup.prefix = shortText(n.arguments[0].getText(sf), 120);
          if (n.expression.name.text === 'enableVersioning' && n.arguments[0]) setup.versioning = shortText(n.arguments[0].getText(sf), 120);
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    const methods = ['Get', 'Post', 'Put', 'Patch', 'Delete', 'Options', 'Head', 'All'];
    const join = (...parts: (string | null | undefined)[]) => '/' + parts.filter((x): x is string => !!x).map((x) => x.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
    for (const o of this.classOwners()) {
      const cls = o.decl as ts.ClassDeclaration;
      const cds = this.decos(cls);
      const ctrl = cds.find((d) => d.name === 'Controller');
      if (!ctrl) continue;
      const a0 = ctrl.args[0];
      const prefix = a0 && ts.isObjectLiteralExpression(a0) ? this.lit(this.objProp(a0, 'path')) : this.lit(a0);
      const version = a0 && ts.isObjectLiteralExpression(a0) ? this.lit(this.objProp(a0, 'version')) : null;
      const classGuards = cds.filter((d) => d.name === 'UseGuards').map((d) => shortText(d.node.getText(o.sf), 100));
      for (const m of cls.members) {
        if (!ts.isMethodDeclaration(m)) continue;
        const ds = this.decos(m);
        const md = ds.find((d) => methods.includes(d.name));
        if (!md) continue;
        const minfo = declInfo(env.project, m);
        if (!minfo || !ctx.hasNode(minfo.id)) continue;
        const mpath = this.lit(md.args[0]);
        const full = join(prefix, mpath);
        const verb = md.name.toUpperCase();
        const rid = `route:${verb} ${full}#${o.file}::${minfo.qualified}`;
        const verified = md.pkg === '@nestjs/common' && ctrl.pkg === '@nestjs/common';
        const sp = spanOf(o.sf, m);
        ctx.node('route', rid, `${verb} ${full}`, `${verb} ${full}`, o.file, sp, {
          symbol_key: minfo.key, framework: 'nestjs', http_method: verb, path: full, controller_prefix: prefix ?? '', method_path: mpath ?? '',
          version: version ?? undefined, controller: o.id, handler: minfo.id,
          guards: [...classGuards, ...ds.filter((d) => d.name === 'UseGuards').map((d) => shortText(d.node.getText(o.sf), 100))],
          decorators: decoratorTexts(m, o.sf), global_prefix_expr: setup.prefix, versioning_expr: setup.versioning,
          roles: ds.filter((d) => d.name === 'Roles').map((d) => shortText(d.node.getText(o.sf), 100)),
        });
        const p = startOf(o.sf, md.node);
        const conf = verified ? 0.95 : 0.7;
        ctx.edge({ type: 'ROUTES_TO', src: rid, dst: minfo.id, file: o.file, line: p.line, col: p.col, extraction: 'nestjs-decorator', confidence: conf, verification: 'framework_inferred', evidence: shortText(`${md.node.getText(o.sf)} ${cds[0] ? '' : ''}`, 100), meta: { controller_decorator: shortText(ctrl.node.getText(o.sf), 100) } });
        ctx.edge({ type: 'DEFINES', src: o.id, dst: rid, file: o.file, line: p.line, col: p.col, extraction: 'nestjs-decorator', confidence: conf, verification: 'framework_inferred', evidence: shortText(md.node.getText(o.sf), 100), meta: {} });
      }
    }
  }

  private injections() {
    const { env } = this;
    const { ctx, project } = env;
    for (const o of this.classOwners()) {
      const cls = o.decl as ts.ClassDeclaration;
      const ctor = cls.members.find((m): m is ts.ConstructorDeclaration => ts.isConstructorDeclaration(m) && !!m.body) ?? cls.members.find((m): m is ts.ConstructorDeclaration => ts.isConstructorDeclaration(m));
      if (!ctor) continue;
      for (const p of ctor.parameters) {
        const ds = this.decos(p);
        const ps = startOf(o.sf, p);
        const pname = p.name.getText(o.sf);
        const base = { type: 'INJECTS_DEPENDENCY' as const, src: o.id, file: o.file, line: ps.line, col: ps.col };
        let decoratorEdge = false;
        for (const d of ds) {
          if (d.name !== 'InjectRepository' && d.name !== 'InjectModel') continue;
          let a0: ts.Expression | undefined = d.args[0] ? stripParens(d.args[0]) : undefined;
          if (a0 && ts.isPropertyAccessExpression(a0) && a0.name.text === 'name') a0 = a0.expression; // @InjectModel(X.name)
          const target = a0 ? this.classIdOfExpr(a0) : null;
          if (target) {
            decoratorEdge = true;
            const verified = d.pkg === '@nestjs/typeorm' || d.pkg === '@nestjs/mongoose';
            ctx.edge({ ...base, dst: target, extraction: `nestjs-${d.name}`, confidence: verified ? 0.9 : 0.6, verification: verified ? 'framework_inferred' : 'semantic_inferred', evidence: shortText(p.getText(o.sf), 140), meta: { param: pname, via: d.name, injected_type: p.type ? shortText(p.type.getText(o.sf), 80) : undefined, db_entity: this.index.entities.get(target) } });
          }
        }
        if (decoratorEdge || !p.type || !ts.isTypeReferenceNode(p.type)) continue;
        const sym = aliasTarget(project.checker, project.checker.getSymbolAtLocation(p.type.typeName));
        const decl = sym?.declarations?.find((d) => ts.isClassDeclaration(d) || ts.isInterfaceDeclaration(d));
        if (!decl) continue;
        if (project.relOf(decl.getSourceFile())) {
          const di = declInfo(project, decl);
          if (di && ctx.hasNode(di.id)) ctx.edge({ ...base, dst: di.id, extraction: 'nestjs-constructor-di', confidence: 0.95, verification: 'framework_inferred', evidence: shortText(p.getText(o.sf), 140), meta: { param: pname, via: 'constructor_type', decorators: ds.map((d) => d.name) } });
        } else if (!project.isLib(decl.getSourceFile())) {
          const pkg = externalPackageOf(decl);
          ctx.edge({ ...base, dst: ctx.ensureExternal(pkg, externalMeta(env, pkg)), extraction: 'nestjs-constructor-di', confidence: 0.9, verification: 'framework_inferred', evidence: shortText(p.getText(o.sf), 140), meta: { param: pname, via: 'constructor_type', injected_class: sym!.name, external: true } });
        }
      }
    }
  }

  private eventNode(name: string): string {
    const id = `event:${name}`;
    this.env.ctx.node('event', id, name, name, null, null, { synthetic: true, event_name: name });
    return id;
  }

  private eventConsumers() {
    const { env } = this;
    for (const o of env.owners) {
      if (o.type !== 'method' || !ts.isMethodDeclaration(o.decl)) continue;
      const d = this.decos(o.decl).find((x) => x.name === 'OnEvent');
      if (!d) continue;
      const name = this.lit(d.args[0]);
      if (!name) continue;
      const p = startOf(o.sf, d.node);
      const verified = d.pkg === '@nestjs/event-emitter';
      env.ctx.edge({ type: 'CONSUMES_EVENT', src: o.id, dst: this.eventNode(name), file: o.file, line: p.line, col: p.col, extraction: 'nestjs-onevent-decorator', confidence: verified ? 0.95 : 0.6, verification: verified ? 'framework_inferred' : 'semantic_inferred', evidence: shortText(d.node.getText(o.sf), 100), meta: { event: name } });
    }
  }

  // ------------------------------------------------------------ per-call hooks
  private classIdOfMethod(id: string): string | null {
    const n = this.env.ctx.nodes.get(id);
    if (!n) return null;
    if (n.type === 'method' && n.qualified_name) return `class:${n.file}#${n.qualified_name.split('.')[0]}`;
    return null;
  }

  private findEntity(type: ts.Type, depth = 0, seen = new Set<ts.Type>()): string | null {
    if (depth > 4 || seen.has(type)) return null;
    seen.add(type);
    const checker = this.env.project.checker;
    const decl = type.symbol?.declarations?.find((d) => ts.isClassDeclaration(d));
    if (decl) {
      const info = declInfo(this.env.project, decl);
      if (info && this.index.entities.has(info.id)) return info.id;
    }
    const kids: ts.Type[] = [];
    if (type.isUnionOrIntersection()) kids.push(...type.types);
    if ((type as ts.TypeReference).target) { try { kids.push(...checker.getTypeArguments(type as ts.TypeReference)); } catch { /* ignore */ } }
    if (type.aliasTypeArguments) kids.push(...type.aliasTypeArguments);
    for (const k of kids) { const r = this.findEntity(k, depth + 1, seen); if (r) return r; }
    return null;
  }

  onCall(res: CallResolution, st: WalkState): void {
    const { env } = this;
    const { ctx, project } = env;
    const owner = st.owner;
    const ev = res.text;
    const at = { file: owner.file, line: res.line, col: res.col };
    const ownerClass = owner.className ? `class:${owner.file}#${owner.className}` : null;
    const ownerRole = ownerClass ? this.index.roles.get(ownerClass) : undefined;

    // ---- application edges derived from internal calls
    if (res.status === 'internal') {
      for (const em of res.emitted) {
        const calleeClass = this.classIdOfMethod(em.dst);
        const calleeNode = ctx.nodes.get(em.dst);
        if (!calleeNode) continue;
        const calleeRole = calleeClass ? this.index.roles.get(calleeClass) ?? 'class' : calleeNode.type === 'function' ? 'helper' : 'class';
        if (calleeClass && calleeClass === ownerClass) continue;
        const verification = em.verification === 'static_verified' ? 'framework_inferred' as const : em.verification;
        const conf = em.verification === 'static_verified' ? 0.9 : em.confidence;
        const mk = (type: 'CONTROLLER_CALLS' | 'SERVICE_USES' | 'REPOSITORY_ACCESSES', why: string) =>
          emitEffect(env, st, { type, dst: em.dst, ...at, extraction: 'nestjs-role-convention', confidence: conf, verification, evidence: ev, meta: { caller_role: ownerRole, callee_role: calleeRole, rule: why, dispatch: em.dispatch || undefined } }, { branch: false });
        if (ownerRole === 'controller' && calleeRole === 'service') mk('CONTROLLER_CALLS', 'controller->service');
        if (ownerRole === 'service' && ['service', 'repository', 'helper', 'mapper'].includes(calleeRole)) mk('SERVICE_USES', `service->${calleeRole}`);
        if (calleeRole === 'repository') mk('REPOSITORY_ACCESSES', 'callee class is a repository');
      }
    }

    // ---- DB queries (TypeORM Repository<E> / Mongoose Model<E>)
    if (res.status === 'external' && res.pkg && DB_PACKAGES.has(res.pkg) && res.kind !== 'decorator' && (res.kind === 'new' || res.receiver)) {
      const member = res.member ?? '';
      const name = res.kind === 'new' ? 'new' : member.split('.').pop() ?? '';
      if (res.kind === 'new' || !DB_MODIFIERS.has(name)) {
        let ty: ts.Type | undefined;
        try { ty = project.checker.getTypeAtLocation(res.kind === 'new' ? res.node.expression : res.receiver ?? res.node.expression); } catch { ty = undefined; }
        const entityClass = ty ? this.findEntity(ty) : null;
        const dbId = entityClass ? this.index.entities.get(entityClass) : null;
        if (dbId) {
          const orm = ctx.nodes.get(dbId)!.meta.orm;
          emitEffect(env, st, { type: 'QUERIES_DATABASE', dst: dbId, ...at, extraction: `${orm}-receiver-type`, confidence: 0.9, verification: 'framework_inferred', evidence: ev, meta: { op: res.kind === 'new' ? 'save' : dbOp(name), member: name, orm, entity: entityClass, repository_role: ownerRole === 'repository' } });
        } else this.dbWithoutEntity++;
      }
    }

    // ---- external API calls (explicit package list), by callee package or receiver-type package
    if (res.kind !== 'new') {
      let apiPkg: string | null = res.status === 'external' && res.pkg && isApiPackage(res.pkg) ? res.pkg : null;
      if (!apiPkg && res.receiver) {
        try {
          const rs = project.checker.getTypeAtLocation(res.receiver).symbol;
          const d = rs?.declarations?.[0];
          if (d && !project.relOf(d.getSourceFile()) && !project.isLib(d.getSourceFile())) {
            const pk = externalPackageOf(d);
            if (isApiPackage(pk)) apiPkg = pk;
          }
        } catch { /* ignore */ }
      }
      if (apiPkg) {
        const dst = ctx.ensureExternal(apiPkg, externalMeta(env, apiPkg));
        emitEffect(env, st, { type: 'CALLS_EXTERNAL_API', dst, ...at, extraction: 'external-api-package-list', confidence: 0.9, verification: 'framework_inferred', evidence: ev, meta: { package: apiPkg, member: res.member, callee: res.calleeName } });
      }
    }

    // ---- events
    if (res.kind === 'call' && res.receiver && ts.isPropertyAccessExpression(stripParens(res.node.expression))) {
      const m = (stripParens(res.node.expression) as ts.PropertyAccessExpression).name.text;
      const args = res.node.arguments ?? ([] as unknown as ts.NodeArray<ts.Expression>);
      if ((m === 'emit' || m === 'emitAsync') && args.length && ts.isStringLiteralLike(args[0])) {
        const viaPkg = res.status === 'external' && ['@nestjs/event-emitter', 'eventemitter2', 'events'].includes(res.pkg ?? '');
        let viaName = false;
        if (!viaPkg) { try { viaName = /EventEmitter/.test(project.checker.typeToString(project.checker.getTypeAtLocation(res.receiver))); } catch { /* ignore */ } }
        if (viaPkg || viaName) {
          emitEffect(env, st, { type: 'PUBLISHES_EVENT', dst: this.eventNode(args[0].text), ...at, extraction: viaPkg ? 'event-emitter-package' : 'name-heuristic-event-emitter', confidence: viaPkg ? 0.9 : 0.6, verification: viaPkg ? 'framework_inferred' : 'semantic_inferred', evidence: ev, meta: { event: args[0].text, method: m } });
        }
      }
    }
  }

  finish(): void {
    if (this.dbWithoutEntity) this.env.diag.notes.push(`${this.dbWithoutEntity} calls into typeorm/mongoose without a resolvable entity receiver (module setup, migrations queryRunner.query, query modifiers, find operators In/Not): no QUERIES_DATABASE edge`);
  }
}

export { symbolKey };
