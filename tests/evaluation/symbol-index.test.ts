import { afterAll, describe, expect, it } from 'vitest';
import { makeIndex, lines } from './helpers.js';
import { normaliseName } from '../../src/evaluation/symbol-index.js';

const SRC = lines(
  /* 1 */ "import { X } from './x';",
  /* 2 */ '',
  /* 3 */ '@Injectable()',
  /* 4 */ 'export class Svc {',
  /* 5 */ '  prop = 1;',
  /* 6 */ '  arrow = () => {',
  /* 7 */ '    return 2;',
  /* 8 */ '  };',
  /* 9 */ '  constructor(private a: number) {}',
  /* 10 */ '  @Get()',
  /* 11 */ '  login(a: string): void {',
  /* 12 */ '    const inner = () => 1;',
  /* 13 */ '  }',
  /* 14 */ '  get val() { return 1; }',
  /* 15 */ '  set val(v: number) {}',
  /* 16 */ '  over(a: string): void;',
  /* 17 */ '  over(a: number): void;',
  /* 18 */ '  over(a: any): void {}',
  /* 19 */ '}',
  /* 20 */ '',
  /* 21 */ 'export function helper() {',
  /* 22 */ '  return 1;',
  /* 23 */ '}',
  /* 24 */ 'export const arrowFn = (x: number) => x + 1;',
  /* 25 */ 'export const plain = 5;',
  /* 26 */ 'export const a1 = 1, b1 = 2;',
  /* 27 */ 'export enum Color { Red }',
  /* 28 */ 'export type T1 = string;',
  /* 29 */ 'export interface IFoo {',
  /* 30 */ '  m(): void;',
  /* 31 */ '  p: string;',
  /* 32 */ '}',
  /* 33 */ 'export default class {}',
);

const ctx = makeIndex({ 'si1/a.ts': SRC });
afterAll(() => ctx.cleanup());
const get = (k: string) => ctx.index.byKey.get(`si1/a.ts::${k}`);

describe('symbol-index key generation', () => {
  it('emits <module> covering the whole file', () => {
    const m = get('<module>')!;
    expect(m.kind).toBe('module');
    expect(m.start_line).toBe(1);
  });
  it('uses <file>::<Class>.<member> for members and bare names for top level', () => {
    for (const k of ['Svc', 'Svc.prop', 'Svc.arrow', 'Svc.constructor', 'Svc.login', 'Svc.val', 'Svc.over', 'helper', 'arrowFn', 'plain', 'a1', 'b1', 'Color', 'T1', 'IFoo', 'IFoo.m', 'IFoo.p']) {
      expect(get(k), k).toBeDefined();
    }
  });
  it('classifies kinds', () => {
    expect(get('Svc.prop')!.kind).toBe('property');
    expect(get('Svc.arrow')!.kind).toBe('method'); // arrow-function property is a callable
    expect(get('Svc.constructor')!.kind).toBe('constructor');
    expect(get('Svc.val')!.kind).toBe('accessor');
    expect(get('arrowFn')!.kind).toBe('function');
    expect(get('plain')!.kind).toBe('variable');
    expect(get('Color')!.kind).toBe('enum');
    expect(get('IFoo.m')!.kind).toBe('method');
    expect(get('IFoo.p')!.kind).toBe('property');
  });
  it('anonymous default class is keyed "default"', () => {
    expect(get('default')?.kind).toBe('class');
  });
  it('does not index nested local functions as symbols', () => {
    expect(get('Svc.login.inner')).toBeUndefined();
    expect(get('inner')).toBeUndefined();
  });
});

describe('symbol-index line spans', () => {
  it('class span includes its decorator line', () => {
    expect(get('Svc')!.start_line).toBe(3);
    expect(get('Svc')!.end_line).toBe(19);
  });
  it('method span includes its decorator, excludes preceding blank/other lines', () => {
    expect(get('Svc.login')!.start_line).toBe(10);
    expect(get('Svc.login')!.end_line).toBe(13);
  });
  it('multi-line arrow property spans to the closing brace', () => {
    expect([get('Svc.arrow')!.start_line, get('Svc.arrow')!.end_line]).toEqual([6, 8]);
  });
  it('overloads and get/set pairs share one key with the widest span', () => {
    expect([get('Svc.over')!.start_line, get('Svc.over')!.end_line]).toEqual([16, 18]);
    expect([get('Svc.val')!.start_line, get('Svc.val')!.end_line]).toEqual([14, 15]);
  });
  it('single-declarator variable statements use the statement span; multi-declarator use the declarator', () => {
    expect([get('arrowFn')!.start_line, get('arrowFn')!.end_line]).toEqual([24, 24]);
    expect([get('a1')!.start_line, get('a1')!.end_line]).toEqual([26, 26]);
  });
});

describe('symbolAtLine / resolveName / normaliseName', () => {
  it('maps a line to the innermost non-module declaration, else <module>', () => {
    expect(ctx.index.symbolAtLine('si1/a.ts', 7)!.name).toBe('Svc.arrow');
    expect(ctx.index.symbolAtLine('si1/a.ts', 12)!.name).toBe('Svc.login');
    expect(ctx.index.symbolAtLine('si1/a.ts', 4)!.name).toBe('Svc');
    expect(ctx.index.symbolAtLine('si1/a.ts', 1)!.name).toBe('<module>');
    expect(ctx.index.symbolAtLine('si1/a.ts', 20)!.name).toBe('<module>');
    expect(ctx.index.symbolAtLine('nope.ts', 1)).toBeNull();
  });
  it('resolves qualified, unqualified-unique and call-paren/hash styles', () => {
    expect(ctx.index.resolveName('si1/a.ts', 'Svc.login', null)!.name).toBe('Svc.login');
    expect(ctx.index.resolveName('si1/a.ts', 'login', null)!.name).toBe('Svc.login');
    expect(ctx.index.resolveName('si1/a.ts', '.login()', null)!.name).toBe('Svc.login');
    expect(ctx.index.resolveName('si1/a.ts', 'Svc#login', null)!.name).toBe('Svc.login');
    expect(ctx.index.resolveName('si1/a.ts', 'si1/a.ts::Svc.login', null)!.name).toBe('Svc.login');
    expect(ctx.index.resolveName('si1/a.ts', 'doesNotExist', null)).toBeNull();
  });
  it('normaliseName strips prefixes, parens, generics', () => {
    expect(normaliseName('src/a.ts::A.b')).toBe('A.b');
    expect(normaliseName('.run()')).toBe('run');
    expect(normaliseName('Repo<T>')).toBe('Repo');
    expect(normaliseName('A#b')).toBe('A.b');
  });
});

describe('symbol-index ambiguity', () => {
  const c2 = makeIndex({
    'si2/b.ts': lines(
      /* 1 */ 'class A {',
      /* 2 */ '  run() {}',
      /* 3 */ '}',
      /* 4 */ 'class B {',
      /* 5 */ '  run() {}',
      /* 6 */ '}',
    ),
  });
  afterAll(() => c2.cleanup());
  it('unqualified name shared by two classes: unresolved without a line, line-disambiguated with one', () => {
    expect(c2.index.resolveName('si2/b.ts', 'run', null)).toBeNull();
    expect(c2.index.resolveName('si2/b.ts', 'run', 5)!.name).toBe('B.run');
    expect(c2.index.resolveName('si2/b.ts', 'run', 2)!.name).toBe('A.run');
  });
  it('DOCUMENTS: a wrong class qualifier is ignored when the last segment is unique in the file (generous)', () => {
    const c3 = makeIndex({ 'si3/c.ts': lines('class A {', '  only() {}', '}') });
    try {
      expect(c3.index.resolveName('si3/c.ts', 'Other.only', null)!.name).toBe('A.only');
    } finally { c3.cleanup(); }
  });
  it('"<module>" as a reported symbol name resolves to the module pseudo-symbol (harness fix C2)', () => {
    expect(c2.index.resolveName('si2/b.ts', '<module>', null)?.key).toBe('si2/b.ts::<module>');
  });
});
