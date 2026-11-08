/**
 * Canonical symbol index used ONLY by the evaluation harness to map any method's
 * results (file + lines and/or symbol name) onto canonical symbol keys.
 *
 * Deliberately independent of src/parser and src/graph: it is a purely syntactic
 * declaration-span index (ts.createSourceFile, no type checker, no relationships),
 * so it cannot favour our graph. Ground-truth keys use the same format.
 *
 * Key format: "<file>::<QualifiedName>", e.g.
 *   src/auth/auth.service.ts::AuthService.refreshToken
 *   src/utils/hash.ts::hashPassword
 *   src/auth/auth.service.ts::<module>      (top-level code outside any declaration)
 */
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';

export interface CanonicalSymbol {
  key: string;
  file: string;
  name: string; // qualified name within file, e.g. AuthService.refreshToken
  kind: 'function' | 'method' | 'constructor' | 'accessor' | 'property' | 'class' | 'interface' | 'type' | 'enum' | 'variable' | 'module';
  start_line: number; // 1-based, includes decorators
  end_line: number;
  parent: string | null; // key of enclosing class symbol, if any
}

export class SymbolIndex {
  readonly byKey = new Map<string, CanonicalSymbol>();
  readonly byFile = new Map<string, CanonicalSymbol[]>();
  readonly fileLines = new Map<string, string[]>();

  constructor(readonly repoRoot: string, files: string[]) {
    for (const f of files) this.indexFile(f);
  }

  private add(s: CanonicalSymbol) {
    if (this.byKey.has(s.key)) {
      // Overloads / duplicate names: keep the widest span under one key.
      const prev = this.byKey.get(s.key)!;
      prev.start_line = Math.min(prev.start_line, s.start_line);
      prev.end_line = Math.max(prev.end_line, s.end_line);
      return;
    }
    this.byKey.set(s.key, s);
    let arr = this.byFile.get(s.file);
    if (!arr) this.byFile.set(s.file, (arr = []));
    arr.push(s);
  }

  private indexFile(file: string) {
    const abs = path.join(this.repoRoot, file);
    const text = fs.readFileSync(abs, 'utf8');
    this.fileLines.set(file, text.split('\n'));
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
    const span = (n: ts.Node) => ({ start_line: lineOf(n.getStart(sf, false)), end_line: lineOf(n.getEnd()) });
    const totalLines = text.split('\n').length;
    this.add({ key: `${file}::<module>`, file, name: '<module>', kind: 'module', start_line: 1, end_line: totalLines, parent: null });

    const nameOf = (n: ts.Node & { name?: ts.Node }): string | null => {
      const nm = n.name;
      if (!nm) return null;
      if (ts.isIdentifier(nm) || ts.isPrivateIdentifier(nm) || ts.isStringLiteral(nm) || ts.isNumericLiteral(nm)) return nm.text;
      if (ts.isComputedPropertyName(nm)) return `[${nm.expression.getText(sf)}]`;
      return nm.getText(sf);
    };

    const visitClassMembers = (cls: ts.ClassLikeDeclaration | ts.InterfaceDeclaration, clsName: string, clsKey: string) => {
      for (const m of cls.members) {
        let kind: CanonicalSymbol['kind'] | null = null;
        let name: string | null = null;
        if (ts.isMethodDeclaration(m) || ts.isMethodSignature(m)) { kind = 'method'; name = nameOf(m); }
        else if (ts.isConstructorDeclaration(m)) { kind = 'constructor'; name = 'constructor'; }
        else if (ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)) { kind = 'accessor'; name = nameOf(m); }
        else if (ts.isPropertyDeclaration(m) || ts.isPropertySignature(m)) {
          name = nameOf(m);
          const init = ts.isPropertyDeclaration(m) ? m.initializer : undefined;
          kind = init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? 'method' : 'property';
        }
        if (kind && name) {
          this.add({ key: `${file}::${clsName}.${name}`, file, name: `${clsName}.${name}`, kind, ...span(m), parent: clsKey });
        }
      }
    };

    const visitTop = (node: ts.Node) => {
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        const name = nameOf(node) ?? 'default';
        const key = `${file}::${name}`;
        this.add({ key, file, name, kind: 'class', ...span(node), parent: null });
        visitClassMembers(node, name, key);
      } else if (ts.isInterfaceDeclaration(node)) {
        const name = nameOf(node)!;
        const key = `${file}::${name}`;
        this.add({ key, file, name, kind: 'interface', ...span(node), parent: null });
        visitClassMembers(node, name, key);
      } else if (ts.isFunctionDeclaration(node)) {
        const name = nameOf(node) ?? 'default';
        this.add({ key: `${file}::${name}`, file, name, kind: 'function', ...span(node), parent: null });
      } else if (ts.isTypeAliasDeclaration(node)) {
        const name = nameOf(node)!;
        this.add({ key: `${file}::${name}`, file, name, kind: 'type', ...span(node), parent: null });
      } else if (ts.isEnumDeclaration(node)) {
        const name = nameOf(node)!;
        this.add({ key: `${file}::${name}`, file, name, kind: 'enum', ...span(node), parent: null });
      } else if (ts.isVariableStatement(node)) {
        for (const d of node.declarationList.declarations) {
          if (!ts.isIdentifier(d.name)) continue;
          const name = d.name.text;
          const init = d.initializer;
          const isFn = !!init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
          const sp = node.declarationList.declarations.length === 1 ? span(node) : span(d);
          this.add({ key: `${file}::${name}`, file, name, kind: isFn ? 'function' : 'variable', ...sp, parent: null });
          if (init && ts.isClassExpression(init)) visitClassMembers(init, name, `${file}::${name}`);
        }
      } else if (ts.isModuleDeclaration(node) && node.body && ts.isModuleBlock(node.body)) {
        node.body.statements.forEach(visitTop);
      } else if (ts.isExportAssignment(node)) {
        // export default <expr>; treated as module-level code
      }
    };
    sf.statements.forEach(visitTop);
  }

  /** Innermost non-module symbol containing the line; falls back to <module>. */
  symbolAtLine(file: string, line: number): CanonicalSymbol | null {
    const syms = this.byFile.get(file);
    if (!syms) return null;
    let best: CanonicalSymbol | null = null;
    for (const s of syms) {
      if (s.kind === 'module') continue;
      if (line >= s.start_line && line <= s.end_line) {
        if (!best || s.end_line - s.start_line < best.end_line - best.start_line) best = s;
      }
    }
    return best ?? this.byKey.get(`${file}::<module>`) ?? null;
  }

  /** Resolve a (possibly partial) symbol name inside a file, using lines to disambiguate. */
  resolveName(file: string, rawName: string, line: number | null): CanonicalSymbol | null {
    const syms = this.byFile.get(file);
    if (!syms) return null;
    if (rawName.trim() === '<module>') return this.byKey.get(`${file}::<module>`) ?? null;
    const name = normaliseName(rawName);
    if (!name) return null;
    const exact = syms.filter((s) => s.name === name);
    if (exact.length === 1) return exact[0];
    const last = name.split('.').pop()!;
    const suffix = syms.filter((s) => s.kind !== 'module' && (s.name === last || s.name.endsWith('.' + last)));
    if (suffix.length === 1) return suffix[0];
    const pool = exact.length ? exact : suffix;
    if (pool.length > 1 && line != null) {
      const containing = pool.filter((s) => line >= s.start_line && line <= s.end_line);
      if (containing.length) return containing.sort((a, b) => (a.end_line - a.start_line) - (b.end_line - b.start_line))[0];
    }
    return null;
  }

  allFiles(): string[] { return [...this.byFile.keys()]; }
}

/** Strip call parens, file prefixes, '#'/'::' separators, generic args etc. */
export function normaliseName(raw: string): string {
  let s = raw.trim();
  const dc = s.lastIndexOf('::');
  if (dc >= 0) s = s.slice(dc + 2);
  s = s.replace(/\(.*\)$/, '').replace(/<.*>$/, '').replace(/#/g, '.').replace(/^\.+/, '');
  return s;
}
