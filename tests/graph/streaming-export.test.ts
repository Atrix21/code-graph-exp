/**
 * Experiment 3 scale fix: graphHash and exportGraphJson stream element by element (a 10k-file repository's
 * canonical JSON exceeds V8's maximum string length). They must produce exactly the bytes of the original
 * single-string implementations, so hashes recorded by experiments 1 and 2 stay valid.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GraphEdge, GraphNode } from '../../src/graph/graph-schema.js';
import { exportGraphJson, loadGraph } from '../../src/graph/graph-store.js';
import { canonicalJson, graphHash } from '../../src/graph/graph-validator.js';

const oldHash = (nodes: GraphNode[], edges: GraphEdge[]) => {
  const by = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return crypto.createHash('sha256').update(canonicalJson({ nodes: [...nodes].sort(by), edges: [...edges].sort(by) })).digest('hex');
};

const node = (id: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  id, type: 'function', name: id, qualified_name: null, file: 'a.ts', start_line: 1, end_line: 2, start_col: 0, end_col: 1, meta: { z: 1, a: [1, 'x'] }, ...extra,
});
const edge = (id: string, src: string, dst: string, extra: Partial<GraphEdge> = {}): GraphEdge => ({
  id, type: 'CALLS', src, dst, file: 'a.ts', line: 3, col: 4, extraction: 'ts-checker', confidence: 1, verification: 'static_verified', evidence: 'f()', meta: {}, ...extra,
});

describe('streaming graph hash and export', () => {
  const nodes = [node('n2', { meta: { u: undefined, k: 'v' } as Record<string, unknown> }), node('n1'), node('n3', { qualified_name: 'Q"\\x' })];
  const edges = [edge('e2', 'n1', 'n2'), edge('e1', 'n2', 'n3', { evidence: null, meta: { deep: { b: 2, a: [null, undefined] } } })];

  it('graphHash equals the single-string implementation', () => {
    expect(graphHash(nodes, edges)).toBe(oldHash(nodes, edges));
    expect(graphHash([], [])).toBe(oldHash([], []));
  });

  it('exportGraphJson writes the same bytes as JSON.stringify', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gexp-'));
    for (const meta of [{ repo: 'r', hash: 'h' }, undefined]) {
      const p = path.join(dir, `g-${meta ? 'm' : 'nometa'}.json`);
      exportGraphJson(p, { nodes, edges, meta });
      expect(fs.readFileSync(p, 'utf8')).toBe(JSON.stringify({ meta, nodes, edges }) + '\n');
    }
  });

  it('reproduces the recorded hash of the experiment-1 base graph when it is present', () => {
    const db = path.resolve('.cache/graph-base/graph.sqlite');
    const stats = path.resolve('.cache/graph-base/stats.json');
    if (!fs.existsSync(db) || !fs.existsSync(stats)) return; // cache not built in this checkout
    const g = loadGraph(db);
    expect(graphHash(g.nodes, g.edges)).toBe(JSON.parse(fs.readFileSync(stats, 'utf8')).hash);
  });
});
