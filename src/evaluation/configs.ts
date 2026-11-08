/**
 * Tunable configurations for custom_graph and hybrid live in evaluation/configs/*.json and are merged
 * over code defaults. Tuning (dev split only) edits these files; they are hashed into FROZEN.json
 * before the held-out run.
 */
import fs from 'node:fs';
import { abs } from '../config.js';
import { DEFAULT_GRAPH_CONFIG, type GraphConfig } from '../retrieval/graph-engine.js';
import { DEFAULT_CUSTOM, DEFAULT_SNIPPETS, type CustomGraphConfig } from '../retrieval/graph-retrieval.js';
import { DEFAULT_HYBRID, type HybridConfig } from '../retrieval/hybrid-retrieval.js';

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends (infer U)[] ? U[] : T[K] extends object ? DeepPartial<T[K]> : T[K] };

function merge<T>(base: T, over: any): T {
  if (over == null) return base;
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over as T;
  const out: any = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in out && typeof out[k] === 'object' && !Array.isArray(out[k]) && out[k] !== null ? merge(out[k], v) : v;
  return out;
}

function readJson(p: string): any {
  const f = abs(p);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

export function customGraphConfig(over?: DeepPartial<CustomGraphConfig>): CustomGraphConfig {
  const base = merge<CustomGraphConfig>({ ...DEFAULT_CUSTOM, graph: { ...DEFAULT_GRAPH_CONFIG }, snippets: { ...DEFAULT_SNIPPETS } }, readJson('evaluation/configs/custom_graph.json'));
  return merge(base, over);
}

export function hybridConfig(over?: DeepPartial<HybridConfig>): HybridConfig {
  const base = merge<HybridConfig>({ ...DEFAULT_HYBRID, graph: { ...DEFAULT_GRAPH_CONFIG }, snippets: { ...DEFAULT_SNIPPETS } }, readJson('evaluation/configs/hybrid.json'));
  return merge(base, over);
}

export type GraphOverride = DeepPartial<GraphConfig>;
