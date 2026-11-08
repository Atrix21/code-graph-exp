#!/usr/bin/env tsx
/**
 * npx tsx src/graph/build-cli.ts --repo <dir> --out <dir> [--include src,test] [--tsconfig path] [--check-repro]
 * Writes graph.sqlite, graph.json, coverage.json, stats.json and prints a summary.
 */
import fs from 'node:fs';
import path from 'node:path';
import { abs, listCorpusFiles, loadConfig } from '../config.js';
import { buildGraph } from './graph-builder.js';
import { checkReproducibility, graphHash } from './graph-validator.js';
import { exportGraphJson, saveGraph } from './graph-store.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (n: string) => process.argv.includes(`--${n}`);
const pct = (a: number, b: number) => (b === 0 ? 'n/a' : `${((100 * a) / b).toFixed(2)}%`);

function main() {
  const repoArg = arg('repo');
  const outArg = arg('out');
  if (!repoArg || !outArg) { console.error('usage: build-cli.ts --repo <dir> --out <dir> [--include src,test] [--tsconfig f] [--check-repro]'); process.exit(2); }
  const cwdRepo = path.resolve(repoArg);
  const repoRoot = fs.existsSync(cwdRepo) ? cwdRepo : abs(repoArg);
  const outDir = path.isAbsolute(outArg) ? outArg : path.resolve(outArg);
  const include = arg('include')?.split(',') ?? loadConfig().target.include_dirs;
  const files = listCorpusFiles(repoRoot, include);
  const opts = { repoRoot, files, tsconfigPath: arg('tsconfig') };

  const g = buildGraph(opts);
  const hash = graphHash(g.nodes, g.edges);
  fs.mkdirSync(outDir, { recursive: true });
  const meta = { repo: path.basename(repoRoot), files: files.length, hash, build_ms: g.build_ms, node_count: g.nodes.length, edge_count: g.edges.length };
  saveGraph(path.join(outDir, 'graph.sqlite'), { nodes: g.nodes, edges: g.edges, coverage: g.coverage, stats: g.stats, meta });
  exportGraphJson(path.join(outDir, 'graph.json'), { nodes: g.nodes, edges: g.edges, meta });
  fs.writeFileSync(path.join(outDir, 'coverage.json'), JSON.stringify(g.coverage, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'stats.json'), JSON.stringify({ ...g.stats, hash, build_ms: g.build_ms, node_count: g.nodes.length, edge_count: g.edges.length }, null, 2) + '\n');

  const c = g.coverage;
  const line = (rec: Record<string, number>) => Object.entries(rec).map(([k, v]) => `  ${k.padEnd(22)} ${v}`).join('\n');
  console.log(`graph: ${repoRoot}\n  nodes=${g.nodes.length} edges=${g.edges.length} build=${g.build_ms}ms hash=${hash}`);
  console.log(`\nnodes by type:\n${line(g.stats.nodes_by_type)}`);
  console.log(`\nedges by type:\n${line(g.stats.edges_by_type)}`);
  console.log(`\nedges by verification:\n${line(g.stats.edges_by_verification)}`);
  console.log(`\ncoverage:
  files parsed          ${c.parsed_files}/${c.eligible_files} (${pct(c.parsed_files, c.eligible_files)})
  declared functions    ${c.extracted_functions}/${c.declared_functions} (${pct(c.extracted_functions, c.declared_functions)})
  call sites            ${c.detected_calls}: internal ${c.resolved_calls_internal} (${pct(c.resolved_calls_internal, c.detected_calls)}), external ${c.resolved_calls_external} (${pct(c.resolved_calls_external, c.detected_calls)}), unresolved ${c.unresolved_calls} (${pct(c.unresolved_calls, c.detected_calls)})
  imports               ${c.resolved_imports}/${c.detected_imports} resolved (${pct(c.resolved_imports, c.detected_imports)})
  unresolved references ${c.unresolved_references}
  unsupported syntax    ${JSON.stringify(c.unsupported_syntax)}`);
  if (c.parse_failures.length) console.log(`  parse failures: ${JSON.stringify(c.parse_failures)}`);
  if (c.unresolved_imports.length) console.log(`  unresolved imports: ${c.unresolved_imports.join(', ')}`);
  console.log(`\nnotes:\n${c.notes.map((n) => '  - ' + n).join('\n')}`);
  if (flag('check-repro')) {
    const r = checkReproducibility(opts);
    console.log(`\nreproducibility: ${r.identical ? 'IDENTICAL' : 'DIFFERENT'} (${r.hash_a} vs ${r.hash_b}) builds ${r.build_ms.join('ms, ')}ms`);
    if (!r.identical) process.exitCode = 1;
  }
  console.log(`\nwrote ${outDir}/{graph.sqlite,graph.json,coverage.json,stats.json}`);
}
main();
