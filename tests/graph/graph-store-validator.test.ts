import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildGraph } from '../../src/graph/graph-builder.js';
import { checkReproducibility, graphHash, validateIntegrity } from '../../src/graph/graph-validator.js';
import { exportGraphJson, loadGraph, saveGraph } from '../../src/graph/graph-store.js';
import { fixtureGraph, fixtureOpts } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-test-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('validator', () => {
  const g = fixtureGraph();

  it('coverage on the fixture is complete and consistent', () => {
    const c = g.coverage;
    expect(c.parse_failures).toEqual([]);
    expect(c.parsed_files).toBe(c.eligible_files);
    expect(c.declared_functions).toBeGreaterThan(15);
    expect(c.extracted_functions).toBe(c.declared_functions);
    expect(c.detected_calls).toBe(c.resolved_calls_internal + c.resolved_calls_external + c.unresolved_calls);
    expect(c.unresolved_calls).toBe(0);
    expect(c.detected_imports).toBe(c.resolved_imports);
    expect(c.unresolved_imports).toEqual([]);
    expect(c.notes.filter((n) => n.startsWith('INTEGRITY'))).toEqual([]);
  });

  it('integrity: no dangling edges or duplicate ids', () => {
    expect(validateIntegrity(g)).toEqual([]);
  });

  it('never marks inferred edges as verified', () => {
    for (const e of g.edges) {
      if (['CONTROLLER_CALLS', 'SERVICE_USES', 'REPOSITORY_ACCESSES', 'ROUTES_TO', 'INJECTS_DEPENDENCY', 'QUERIES_DATABASE', 'CALLS_EXTERNAL_API', 'PUBLISHES_EVENT'].includes(e.type)) {
        expect(e.verification, e.id).not.toBe('static_verified');
      }
      if (e.verification === 'ambiguous') expect(e.confidence).toBeLessThan(1);
    }
  });

  it('reproducible: two builds hash identically; no absolute paths leak', () => {
    const r = checkReproducibility(fixtureOpts());
    expect(r.identical).toBe(true);
    expect(r.hash_a).toBe(graphHash(g.nodes, g.edges));
    const json = JSON.stringify([g.nodes, g.edges]);
    expect(json).not.toContain(process.cwd());
    expect(json).not.toContain(os.homedir());
  });
});

describe('store', () => {
  it('sqlite round-trips nodes, edges and indexes', () => {
    const g = buildGraph(fixtureOpts());
    const db = path.join(tmp, 'graph.sqlite');
    saveGraph(db, { nodes: g.nodes, edges: g.edges, coverage: g.coverage, stats: g.stats });
    const back = loadGraph(db);
    expect(graphHash(back.nodes, back.edges)).toBe(graphHash(g.nodes, g.edges));
    expect(back.coverage?.detected_calls).toBe(g.coverage.detected_calls);
    expect(back.stats).toEqual(g.stats);
    const json = path.join(tmp, 'graph.json');
    exportGraphJson(json, { nodes: g.nodes, edges: g.edges });
    expect(JSON.parse(fs.readFileSync(json, 'utf8')).edges).toHaveLength(g.edges.length);
  });
});
