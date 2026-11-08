import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGraph, type BuiltGraph } from '../../src/graph/graph-builder.js';
import { listCorpusFiles } from '../../src/config.js';
import type { EdgeType, GraphEdge, GraphNode } from '../../src/graph/graph-schema.js';

export const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/mini-app');
export const fixtureOpts = () => ({ repoRoot: FIXTURE, files: listCorpusFiles(FIXTURE, ['src']) });

let cached: BuiltGraph | null = null;
export function fixtureGraph(): BuiltGraph {
  return (cached ??= buildGraph(fixtureOpts()));
}

/** 1-based line of the first line of `file` containing `snippet` (nth occurrence, default first). */
export function lineOf(file: string, snippet: string, nth = 1): number {
  const lines = fs.readFileSync(path.join(FIXTURE, file), 'utf8').split('\n');
  let seen = 0;
  for (let i = 0; i < lines.length; i++) if (lines[i].includes(snippet) && ++seen === nth) return i + 1;
  throw new Error(`snippet not found in ${file}: ${snippet}`);
}

export function edges(g: BuiltGraph, type: EdgeType, src?: string | RegExp, dst?: string | RegExp): GraphEdge[] {
  const m = (v: string, p?: string | RegExp) => p === undefined || (typeof p === 'string' ? v === p : p.test(v));
  return g.edges.filter((e) => e.type === type && m(e.src, src) && m(e.dst, dst));
}
export function one(g: BuiltGraph, type: EdgeType, src?: string | RegExp, dst?: string | RegExp): GraphEdge {
  const r = edges(g, type, src, dst);
  if (r.length !== 1) throw new Error(`expected exactly 1 ${type} edge ${String(src)} -> ${String(dst)}, found ${r.length}`);
  return r[0];
}
export function node(g: BuiltGraph, id: string): GraphNode {
  const n = g.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`node not found: ${id}`);
  return n;
}
