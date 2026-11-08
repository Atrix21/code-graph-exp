import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SymbolIndex } from '../../src/evaluation/symbol-index.js';

/** Write small TS sources into a fresh temp dir and index them. File names must be unique across tests (renderSymbolUniform caches by key only). */
export function makeIndex(sources: Record<string, string>): { index: SymbolIndex; root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgbench-eval-'));
  for (const [f, src] of Object.entries(sources)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), src);
  }
  const index = new SymbolIndex(root, Object.keys(sources));
  return { index, root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

export const lines = (...l: string[]) => l.join('\n') + '\n';
