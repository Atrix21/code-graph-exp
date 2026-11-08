/** SQLite persistence (built-in node:sqlite, no native deps) and JSON export for the code graph. */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { CoverageReport, GraphEdge, GraphNode, GraphStats } from './graph-schema.js';

export interface StoredGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  coverage?: CoverageReport;
  stats?: GraphStats;
  meta?: Record<string, unknown>;
}

const SCHEMA = `
CREATE TABLE nodes (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, qualified_name TEXT, file TEXT,
  start_line INTEGER, end_line INTEGER, start_col INTEGER, end_col INTEGER, meta TEXT NOT NULL
);
CREATE TABLE edges (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, src TEXT NOT NULL, dst TEXT NOT NULL, file TEXT, line INTEGER, col INTEGER,
  extraction TEXT NOT NULL, confidence REAL NOT NULL, verification TEXT NOT NULL, evidence TEXT, meta TEXT NOT NULL
);
CREATE TABLE graph_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE INDEX idx_edges_src ON edges(src);
CREATE INDEX idx_edges_dst ON edges(dst);
CREATE INDEX idx_edges_type ON edges(type);
CREATE INDEX idx_nodes_name ON nodes(name);
CREATE INDEX idx_nodes_type ON nodes(type);
CREATE INDEX idx_nodes_file ON nodes(file);
`;

export function saveGraph(dbPath: string, graph: StoredGraph): void {
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  for (const suffix of ['', '-journal', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;');
    db.exec(SCHEMA);
    db.exec('BEGIN');
    const ins = db.prepare('INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?,?,?)');
    for (const n of graph.nodes) ins.run(n.id, n.type, n.name, n.qualified_name, n.file, n.start_line, n.end_line, n.start_col, n.end_col, JSON.stringify(n.meta));
    const ine = db.prepare('INSERT INTO edges VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const e of graph.edges) ine.run(e.id, e.type, e.src, e.dst, e.file, e.line, e.col, e.extraction, e.confidence, e.verification, e.evidence, JSON.stringify(e.meta));
    const im = db.prepare('INSERT INTO graph_meta VALUES (?,?)');
    if (graph.coverage) im.run('coverage', JSON.stringify(graph.coverage));
    if (graph.stats) im.run('stats', JSON.stringify(graph.stats));
    if (graph.meta) im.run('meta', JSON.stringify(graph.meta));
    db.exec('COMMIT');
  } finally { db.close(); }
}

export function loadGraph(dbPath: string): StoredGraph {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const nodes = (db.prepare('SELECT * FROM nodes ORDER BY id').all() as Record<string, unknown>[]).map((r) => ({
      id: r.id as string, type: r.type as GraphNode['type'], name: r.name as string, qualified_name: r.qualified_name as string | null,
      file: r.file as string | null, start_line: r.start_line as number | null, end_line: r.end_line as number | null,
      start_col: r.start_col as number | null, end_col: r.end_col as number | null, meta: JSON.parse(r.meta as string),
    }));
    const edges = (db.prepare('SELECT * FROM edges ORDER BY id').all() as Record<string, unknown>[]).map((r) => ({
      id: r.id as string, type: r.type as GraphEdge['type'], src: r.src as string, dst: r.dst as string,
      file: r.file as string | null, line: r.line as number | null, col: r.col as number | null,
      extraction: r.extraction as string, confidence: r.confidence as number, verification: r.verification as GraphEdge['verification'],
      evidence: r.evidence as string | null, meta: JSON.parse(r.meta as string),
    }));
    const out: StoredGraph = { nodes, edges };
    for (const r of db.prepare('SELECT key, value FROM graph_meta').all() as { key: string; value: string }[]) {
      if (r.key === 'coverage') out.coverage = JSON.parse(r.value);
      else if (r.key === 'stats') out.stats = JSON.parse(r.value);
      else if (r.key === 'meta') out.meta = JSON.parse(r.value);
    }
    return out;
  } finally { db.close(); }
}

export function exportGraphJson(jsonPath: string, graph: StoredGraph): void {
  fs.mkdirSync(path.dirname(path.resolve(jsonPath)), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify({ meta: graph.meta, nodes: graph.nodes, edges: graph.edges }) + '\n');
}
