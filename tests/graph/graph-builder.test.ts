import { describe, expect, it } from 'vitest';
import { edges, fixtureGraph, lineOf, node, one } from './helpers.js';

const SVC = 'src/users/users.service.ts';
const svc = (q: string) => `method:${SVC}#UsersService.${q}`;
const ACTIVATE = svc('activate');
const FIND_ONE = svc('findOne');

describe('nodes and symbol keys', () => {
  const g = fixtureGraph();

  it('uses ids and qualified names that join to <file>::<Class.member> symbol keys', () => {
    const m = node(g, FIND_ONE);
    expect(m.type).toBe('method');
    expect(m.qualified_name).toBe('UsersService.findOne');
    expect(m.meta.symbol_key).toBe(`${SVC}::UsersService.findOne`);
    expect(m.start_line).toBe(lineOf(SVC, 'async findOne'));
    const ctor = node(g, svc('constructor'));
    expect(ctor.meta.kind).toBe('constructor');
    expect(node(g, `function:src/util.ts#double`).meta.kind).toBe('arrow_const');
    expect(node(g, `class:${SVC}#UsersService`).meta.role).toBe('service');
  });

  it('creates parameter, property (ctor param property) and CONTAINS edges', () => {
    const p = node(g, `parameter:${SVC}#UsersService.activate(dto)`);
    expect(p.meta.index).toBe(1);
    expect(p.meta.type).toBe('ActivateDto');
    expect(one(g, 'CONTAINS', ACTIVATE, p.id).verification).toBe('static_verified');
    expect(node(g, `property:${SVC}#UsersService.repo`).meta.parameter_property).toBe(true);
    expect(edges(g, 'CONTAINS', `class:${SVC}#UsersService`, ACTIVATE)).toHaveLength(1);
    expect(edges(g, 'CONTAINS', `file:${SVC}`, `class:${SVC}#UsersService`)).toHaveLength(1);
  });

  it('is sorted by id', () => {
    const ids = g.nodes.map((n) => n.id);
    expect(ids).toEqual([...ids].sort((a, b) => (a < b ? -1 : 1)));
    const eids = g.edges.map((e) => e.id);
    expect(eids).toEqual([...eids].sort((a, b) => (a < b ? -1 : 1)));
  });
});

describe('structural edges', () => {
  const g = fixtureGraph();

  it('IMPORTS resolves relative files and ambient packages', () => {
    const rel = one(g, 'IMPORTS', `file:${SVC}`, 'file:src/util.ts');
    expect(rel.line).toBe(lineOf(SVC, "from '../util'"));
    expect(rel.verification).toBe('static_verified');
    const pkg = one(g, 'IMPORTS', `file:${SVC}`, 'external_dependency:mini-sdk');
    expect(pkg.line).toBe(lineOf(SVC, "from 'mini-sdk'"));
    expect(pkg.verification).toBe('static_verified');
    expect(node(g, 'external_dependency:mini-sdk').type).toBe('external_dependency');
  });

  it('EXTENDS and IMPLEMENTS are checker-resolved', () => {
    const ext = one(g, 'EXTENDS', /DocumentUserRepository$/, /UserRepository$/);
    expect(ext.verification).toBe('static_verified');
    expect(ext.line).toBe(lineOf('src/repo/document.repository.ts', 'extends UserRepository'));
    const impl = one(g, 'IMPLEMENTS', /RelationalUserRepository$/, /UserRepository$/);
    expect(impl.confidence).toBe(1);
    expect(one(g, 'IMPLEMENTS', 'class:src/domain/user.ts#User', 'interface:src/domain/user.ts#Auditable')).toBeTruthy();
  });

  it('INSTANTIATES and HAS_TYPE', () => {
    const inst = one(g, 'INSTANTIATES', ACTIVATE, 'external_dependency:mini-sdk');
    expect(inst.line).toBe(lineOf(SVC, 'new StorageClient'));
    expect(inst.meta.class_name).toBe('StorageClient');
    const thr = one(g, 'INSTANTIATES', ACTIVATE, `class:src/errors.ts#ValidationException`);
    expect(thr.verification).toBe('static_verified');
    const ht = one(g, 'HAS_TYPE', `parameter:${SVC}#UsersService.activate(dto)`, `interface:${SVC}#ActivateDto`);
    expect(ht.meta.role).toBe('primary');
  });

  it('INJECTS_DEPENDENCY is framework_inferred (never verified)', () => {
    const e = one(g, 'INJECTS_DEPENDENCY', `class:${SVC}#UsersService`, 'class:src/repo/user.repository.ts#UserRepository');
    expect(e.verification).toBe('framework_inferred');
    expect(e.line).toBe(lineOf(SVC, 'private readonly repo'));
  });
});

describe('calls, dispatch and application layer', () => {
  const g = fixtureGraph();

  it('controller -> service CALLS is static_verified; CONTROLLER_CALLS is framework_inferred', () => {
    const ctl = 'method:src/users/users.controller.ts#UsersController.get';
    const c = one(g, 'CALLS', ctl, FIND_ONE);
    expect(c.verification).toBe('static_verified');
    expect(c.confidence).toBe(1);
    expect(c.line).toBe(lineOf('src/users/users.controller.ts', 'this.users.findOne(id)'));
    expect(c.evidence).toContain('this.users.findOne(id)');
    const cc = one(g, 'CONTROLLER_CALLS', ctl, FIND_ONE);
    expect(cc.verification).toBe('framework_inferred');
    expect(cc.confidence).toBeLessThan(1);
  });

  it('dispatches abstract repository calls to both bound implementations', () => {
    const line = lineOf(SVC, 'this.repo.findById(id)');
    const abs = one(g, 'CALLS', FIND_ONE, 'method:src/repo/user.repository.ts#UserRepository.findById');
    expect(abs.verification).toBe('static_verified');
    expect(abs.line).toBe(line);
    const rel = one(g, 'CALLS', FIND_ONE, 'method:src/repo/relational.repository.ts#RelationalUserRepository.findById');
    const doc = one(g, 'CALLS', FIND_ONE, 'method:src/repo/document.repository.ts#DocumentUserRepository.findById');
    for (const e of [rel, doc]) {
      expect(e.verification).toBe('framework_inferred');
      expect(e.confidence).toBe(0.8);
      expect(e.line).toBe(line);
      expect((e.meta.dispatch as { via: string }).via).toBe('method:src/repo/user.repository.ts#UserRepository.findById');
    }
    expect(one(g, 'REPOSITORY_ACCESSES', FIND_ONE, rel.dst).verification).toBe('framework_inferred');
    expect(one(g, 'SERVICE_USES', FIND_ONE, abs.dst).verification).toBe('framework_inferred');
  });

  it('route nodes route to the controller handler', () => {
    const r = g.nodes.find((n) => n.type === 'route' && n.name === 'GET /users/:id')!;
    expect(r).toBeTruthy();
    expect(r.meta.http_method).toBe('GET');
    const e = one(g, 'ROUTES_TO', r.id);
    expect(e.dst).toBe('method:src/users/users.controller.ts#UsersController.get');
    expect(e.verification).toBe('framework_inferred');
    expect(g.nodes.some((n) => n.type === 'route' && n.name === 'POST /users/activate')).toBe(true);
  });

  it('external calls point at external_dependency nodes (member recorded in meta)', () => {
    const e = one(g, 'CALLS', ACTIVATE, 'external_dependency:mini-sdk');
    expect(e.line).toBe(lineOf(SVC, 'client.putObject'));
    expect(e.meta.member).toBe('StorageClient.putObject');
    const api = one(g, 'CALLS_EXTERNAL_API', ACTIVATE, 'external_dependency:axios');
    expect(api.verification).toBe('framework_inferred');
    expect(api.line).toBe(lineOf(SVC, 'axios.post'));
  });

  it('records config reads and event publication as inferred, not verified', () => {
    const r = one(g, 'READS', ACTIVATE, 'variable:config#storage.bucket');
    expect(r.verification).toBe('semantic_inferred');
    expect(r.meta.config_key).toBe('storage.bucket');
    const ev = edges(g, 'PUBLISHES_EVENT', ACTIVATE, 'event:user.tag');
    expect(ev.length).toBeGreaterThan(0);
    expect(ev[0].verification).toBe('semantic_inferred');
  });

  it('recursion', () => {
    const e = one(g, 'RECURSES_TO', 'function:src/util.ts#factorial', 'function:src/util.ts#factorial');
    expect(e.line).toBe(lineOf('src/util.ts', 'factorial(n - 1)'));
    expect(one(g, 'CALLS', 'function:src/util.ts#factorial', 'function:src/util.ts#factorial').verification).toBe('static_verified');
  });
});

describe('control flow', () => {
  const g = fixtureGraph();
  const cond = (line: number) => g.nodes.find((n) => n.type === 'condition' && n.id.startsWith(`condition:${SVC}#UsersService.activate@L${line}:`))!;

  it('if + early return', () => {
    const line = lineOf(SVC, 'if (!id) return');
    const c = cond(line);
    expect(c.meta.kind).toBe('if');
    expect(c.meta.text).toBe('!id');
    expect(one(g, 'CHECKS', ACTIVATE, c.id).verification).toBe('static_verified');
    expect(one(g, 'CHECKS', c.id, `parameter:${SVC}#UsersService.activate(id)`).line).toBe(line);
    const b = one(g, 'BRANCHES_TO', c.id);
    expect(b.meta.polarity).toBe('true');
    const ret = g.nodes.find((n) => n.type === 'return' && n.start_line === line)!;
    expect(ret.meta.early_return).toBe(true);
    expect(ret.meta.guard).toEqual({ condition_id: c.id, polarity: 'true' });
    const rEdge = one(g, 'RETURNS', ACTIVATE, ret.id);
    expect((rEdge.meta.guard as { condition_id: string }).condition_id).toBe(c.id);
    expect(one(g, 'RETURNS', b.dst, ret.id)).toBeTruthy(); // branch-level RETURNS
    const final = g.nodes.find((n) => n.type === 'return' && n.start_line === lineOf(SVC, 'return `ok-'))!;
    expect(final.meta.early_return).toBe(false);
  });

  it('if with throw: guard metadata and branch-level THROWS', () => {
    const line = lineOf(SVC, 'if (!user)');
    const c = g.nodes.find((n) => n.type === 'condition' && n.id.startsWith(`condition:${SVC}#UsersService.findOne@L${line}:`))!;
    const b = one(g, 'BRANCHES_TO', c.id);
    const t = one(g, 'THROWS', FIND_ONE, 'class:src/errors.ts#NotFoundException');
    expect(t.line).toBe(lineOf(SVC, "throw new NotFoundException"));
    expect(t.meta.guard).toEqual({ condition_id: c.id, polarity: 'true' });
    expect(t.verification).toBe('static_verified');
    expect(one(g, 'THROWS', b.dst, 'class:src/errors.ts#NotFoundException').line).toBe(t.line);
  });

  it('ternary has true/false branches', () => {
    const line = lineOf(SVC, "dto.status === 'active' ?");
    const c = cond(line);
    expect(c.meta.kind).toBe('ternary');
    const bs = edges(g, 'BRANCHES_TO', c.id);
    expect(bs.map((b) => b.meta.polarity).sort()).toEqual(['false', 'true']);
    expect(one(g, 'CHECKS', c.id, 'property:' + SVC + '#ActivateDto.status')).toBeTruthy();
  });

  it('switch cases become conditions with case branches', () => {
    const cases = g.nodes.filter((n) => n.type === 'condition' && n.meta.kind === 'switch_case');
    expect(cases).toHaveLength(3);
    expect(cases.map((c) => c.meta.case_label)).toEqual(["'new'", "'blocked'", 'default']);
    const blocked = cases.find((c) => c.meta.case_label === "'blocked'")!;
    const br = one(g, 'BRANCHES_TO', blocked.id);
    expect(br.meta.polarity).toBe('case');
    const th = one(g, 'THROWS', br.dst, 'class:src/errors.ts#ValidationException');
    expect((th.meta.guard as { polarity: string }).polarity).toBe('case');
  });

  it('try/catch and loops', () => {
    const h = g.nodes.find((n) => n.type === 'exception_handler' && n.id.includes('UsersService.activate'))!;
    expect(h.meta.variable).toBe('e');
    expect(one(g, 'CATCHES', ACTIVATE, h.id).line).toBe(lineOf(SVC, '} catch (e)'));
    const call = one(g, 'CALLS', ACTIVATE, 'external_dependency:mini-sdk');
    expect(call.meta.caught_by).toBe(h.id);
    const loop = g.nodes.find((n) => n.type === 'loop')!;
    expect(loop.meta.kind).toBe('for_of');
    expect(one(g, 'LOOPS', ACTIVATE, loop.id).line).toBe(lineOf(SVC, 'for (const tag'));
    // call inside the loop body carries the loop-condition guard
    const emit = edges(g, 'CALLS', ACTIVATE, svcEmit()).find((e) => e.line === lineOf(SVC, 'this.events.emit'))!;
    expect((emit.meta.guard as { polarity: string }).polarity).toBe('true');
  });
});

function svcEmit() { return 'method:src/platform.ts#EventEmitter2.emit'; }

describe('data flow', () => {
  const g = fixtureGraph();

  it('WRITES and MUTATES on a parameter property', () => {
    const w = one(g, 'WRITES', ACTIVATE, `property:${SVC}#ActivateDto.status`);
    expect(w.line).toBe(lineOf(SVC, "dto.status = 'active'"));
    const m = one(g, 'MUTATES', ACTIVATE, `property:${SVC}#ActivateDto.status`);
    expect(m.meta.root).toBe('parameter');
    const push = one(g, 'MUTATES', ACTIVATE, `property:${SVC}#ActivateDto.tags`);
    expect(push.meta.mutating_call).toBe('Array.push');
    expect(push.line).toBe(lineOf(SVC, "dto.tags.push"));
  });

  it('PASSES_TO maps argument index to parameter node', () => {
    const p = one(g, 'PASSES_TO', 'method:src/users/users.controller.ts#UsersController.activate', `parameter:${SVC}#UsersService.activate(dto)`);
    expect(p.meta.arg_index).toBe(1);
    expect(p.meta.arg).toBe('dto');
  });

  it('awaited call assigned then returned: RECEIVES_FROM / RETURNS_VALUE_TO', () => {
    const r = one(g, 'RECEIVES_FROM', svc('register'), 'method:src/repo/user.repository.ts#UserRepository.save');
    expect(r.meta.variable).toBe('saved');
    expect(r.meta.awaited).toBe(true);
    expect(r.line).toBe(lineOf(SVC, 'this.repo.save(user)'));
    const back = one(g, 'RETURNS_VALUE_TO', 'method:src/repo/user.repository.ts#UserRepository.save', svc('register'));
    expect(back.meta.variable).toBe('saved');
    const ret = g.nodes.find((n) => n.type === 'return' && n.start_line === lineOf(SVC, 'return saved'))!;
    expect(ret.meta.expression).toBe('saved');
  });

  it('db_entity for @Entity classes (convention, not verified)', () => {
    const d = node(g, 'db_entity:src/domain/user.ts#User');
    expect(d.meta.table_or_collection).toBe('users');
    expect(one(g, 'DEFINES', 'class:src/domain/user.ts#User', d.id).verification).not.toBe('static_verified');
  });
});
