/**
 * graph:build    build the custom graph for the pristine base snapshot and every task snapshot (cached by commit).
 * graph:validate coverage + integrity + reproducibility (build twice, compare hashes) on every snapshot.
 */
import fs from 'node:fs';
import path from 'node:path';
import { abs, type BenchmarkConfig } from '../config.js';
import { checkoutSnapshot } from '../evaluation/corpus.js';
import { buildGraph } from '../graph/graph-builder.js';
import { checkReproducibility, graphHash, validateIntegrity } from '../graph/graph-validator.js';
import { saveGraph } from '../graph/graph-store.js';

export async function graphBuildCommand(cfg: BenchmarkConfig, validate: boolean) {
  const manifest = JSON.parse(fs.readFileSync(abs('targets/bench.manifest.json'), 'utf8'));
  const snaps = ['base', ...Object.keys(manifest.tasks).sort()];
  const summary: Record<string, unknown>[] = [];
  for (const s of snaps) {
    const corpus = checkoutSnapshot(cfg, s);
    const dir = path.join(corpus.cacheDir, 'custom-graph');
    const opts = { repoRoot: corpus.repoRoot, files: corpus.files, tsconfigPath: path.join(corpus.repoRoot, 'tsconfig.json') };
    const g = buildGraph(opts);
    fs.mkdirSync(dir, { recursive: true });
    const hash = graphHash(g.nodes, g.edges);
    fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify({ nodes: g.nodes, edges: g.edges, build_ms: g.build_ms, hash }));
    fs.writeFileSync(path.join(dir, 'coverage.json'), JSON.stringify(g.coverage, null, 2));
    fs.writeFileSync(path.join(dir, 'stats.json'), JSON.stringify(g.stats, null, 2));
    if (s === 'base') saveGraph(path.join(dir, 'graph.sqlite'), g as never);
    const row: Record<string, unknown> = { snapshot: s, commit: corpus.commit, nodes: g.nodes.length, edges: g.edges.length, build_ms: Math.round(g.build_ms), hash };
    if (validate) {
      const integrity = validateIntegrity(g);
      const repro = checkReproducibility(opts);
      const c = g.coverage;
      Object.assign(row, {
        integrity_issues: integrity.length, reproducible: repro.identical && repro.hash_a === hash,
        files: `${c.parsed_files}/${c.eligible_files}`, functions: `${c.extracted_functions}/${c.declared_functions}`,
        calls_internal: c.resolved_calls_internal, calls_external: c.resolved_calls_external, calls_unresolved: c.unresolved_calls,
        imports: `${c.resolved_imports}/${c.detected_imports}`, parse_failures: c.parse_failures.length,
      });
    }
    summary.push(row);
    console.error(JSON.stringify(row));
  }
  checkoutSnapshot(cfg, 'base');
  const out = abs(path.join(cfg.results_dir, validate ? 'graph-validation.json' : 'graph-build.json'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ snapshots: summary }, null, 2) + '\n');
  console.log(`wrote ${out}`);
}
