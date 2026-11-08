/** Freeze the dataset: hash every task + patch + the snapshot manifest into evaluation/dataset/FROZEN.json. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { abs, loadConfig } from '../src/config.js';
const cfg = loadConfig();
const h = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const tdir = abs(cfg.dataset.tasks_dir), bdir = abs(cfg.dataset.bugs_dir);
const tasks = fs.readdirSync(tdir).filter((f) => f.endsWith('.json')).sort();
const dist: Record<string, Record<string, number>> = { split: {}, lexical_overlap: {}, difficulty: {} };
for (const f of tasks) {
  const t = JSON.parse(fs.readFileSync(path.join(tdir, f), 'utf8'));
  for (const k of Object.keys(dist)) dist[k][t[k]] = (dist[k][t[k]] ?? 0) + 1;
}
const version = process.argv[2] ?? 'v1.0';
const frozen = {
  version, frozen_at: new Date().toISOString(),
  note: 'Frozen after audit adjudication and before any comparative evaluation on benchmark tasks.',
  tasks: Object.fromEntries(tasks.map((f) => [f, h(path.join(tdir, f))])),
  patches: Object.fromEntries(fs.readdirSync(bdir).sort().map((f) => [f, h(path.join(bdir, f))])),
  snapshot_manifest_sha256: h(abs('targets/bench.manifest.json')),
  distribution: dist,
};
fs.writeFileSync(abs('evaluation/dataset/FROZEN.json'), JSON.stringify(frozen, null, 2) + '\n');
const c = JSON.parse(fs.readFileSync(abs('benchmark.config.json'), 'utf8'));
c.dataset.version = version;
fs.writeFileSync(abs('benchmark.config.json'), JSON.stringify(c, null, 2) + '\n');
console.log(JSON.stringify({ version, distribution: dist }, null, 2));
