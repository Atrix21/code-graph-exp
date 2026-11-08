/**
 * Deterministic, stratified dev/test split (stratified by lexical_overlap; 2 dev tasks per stratum).
 * Run once before any comparative evaluation; the split is then frozen in the task files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, abs } from '../src/config.js';
import { rng } from '../src/evaluation/metrics.js';

const cfg = loadConfig();
const dir = abs(cfg.dataset.tasks_dir);
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
const tasks = files.map((f) => ({ f, t: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));
const r = rng(cfg.dataset.split_seed);
const strata = new Map<string, typeof tasks>();
for (const x of tasks) {
  const k = x.t.lexical_overlap ?? 'unknown';
  if (!strata.has(k)) strata.set(k, []);
  strata.get(k)!.push(x);
}
const DEV_PER_STRATUM = 2;
for (const k of [...strata.keys()].sort()) {
  const arr = strata.get(k)!.slice().sort((a, b) => a.t.task_id.localeCompare(b.t.task_id));
  // Fisher-Yates with seeded PRNG
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  arr.forEach((x, i) => { x.t.split = i < DEV_PER_STRATUM ? 'dev' : 'test'; });
}
for (const x of tasks) {
  const { task_id, split, ...rest } = x.t;
  fs.writeFileSync(path.join(dir, x.f), JSON.stringify({ task_id, split, ...rest }, null, 2) + '\n');
}
console.log(tasks.map((x) => `${x.t.split}\t${x.t.lexical_overlap}\t${x.t.task_id}`).sort().join('\n'));
