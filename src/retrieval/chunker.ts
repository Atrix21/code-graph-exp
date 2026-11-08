/**
 * Declaration-level chunking shared by BM25 and embedding baselines (standard
 * function-level chunking for code retrieval). Uses the purely syntactic
 * declaration index; no graph information.
 */
import { SymbolIndex } from '../evaluation/symbol-index.js';

export interface Chunk {
  id: string; // symbol key, or "<file>::<module>" / class header key
  file: string;
  symbol: string; // qualified name
  kind: string;
  start_line: number;
  end_line: number;
  lineNumbers: number[]; // the actual lines included (class headers / module chunks are non-contiguous)
  code: string;
  text: string; // what is indexed: header + code
}

const MAX_CHUNK_LINES = 150;

export function buildChunks(index: SymbolIndex): Chunk[] {
  const chunks: Chunk[] = [];
  for (const file of index.allFiles().sort()) {
    const lines = index.fileLines.get(file)!;
    const syms = index.byFile.get(file)!.filter((s) => s.kind !== 'module');
    const covered = new Set<number>();
    const memberCovered = new Map<string, Set<number>>(); // class key -> lines covered by own chunks of members
    for (const s of syms) {
      if (s.kind === 'class' || s.kind === 'property') continue;
      if (s.parent) {
        let set = memberCovered.get(s.parent);
        if (!set) memberCovered.set(s.parent, (set = new Set()));
        for (let l = s.start_line; l <= s.end_line; l++) set.add(l);
      }
      if (s.parent && index.byKey.get(s.parent)?.kind === 'interface') continue; // interface members live in the interface chunk
      const ln = range(s.start_line, Math.min(s.end_line, s.start_line + MAX_CHUNK_LINES - 1));
      chunks.push(mk(file, s.key, s.name, s.kind, ln, lines));
    }
    for (const s of syms) {
      for (let l = s.start_line; l <= s.end_line; l++) if (!s.parent) covered.add(l);
      if (s.kind !== 'class') continue;
      const own = memberCovered.get(s.key) ?? new Set<number>();
      const ln = range(s.start_line, s.end_line).filter((l) => !own.has(l)).slice(0, MAX_CHUNK_LINES);
      if (ln.some((l) => lines[l - 1]?.trim())) chunks.push(mk(file, s.key, s.name, 'class', ln, lines));
    }
    const modLines = range(1, lines.length).filter((l) => !covered.has(l) && lines[l - 1].trim()).slice(0, MAX_CHUNK_LINES);
    if (modLines.length) chunks.push(mk(file, `${file}::<module>`, '<module>', 'module', modLines, lines));
  }
  return chunks;
}

function range(a: number, b: number): number[] {
  const r: number[] = [];
  for (let i = a; i <= b; i++) r.push(i);
  return r;
}

function mk(file: string, id: string, symbol: string, kind: string, ln: number[], lines: string[]): Chunk {
  const code = ln.map((l) => lines[l - 1]).join('\n');
  return {
    id, file, symbol, kind,
    start_line: ln[0], end_line: ln[ln.length - 1], lineNumbers: ln,
    code, text: `// ${file} ${symbol}\n${code}`,
  };
}

/** Render a chunk for native context output (same format for BM25 and embeddings). */
export function renderChunk(c: Chunk, maxLines = 80): string {
  const ln = c.lineNumbers.slice(0, maxLines);
  const code = c.code.split('\n').slice(0, maxLines).join('\n');
  return `// ${c.file}:${ln[0]}-${ln[ln.length - 1]} ${c.symbol}\n${code}\n`;
}
