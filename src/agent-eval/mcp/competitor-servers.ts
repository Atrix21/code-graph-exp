/**
 * Experiment 2: launch specs for the competitors' OWN native MCP servers (what a user would install).
 *
 * `competitorServerSpec(kind, ws)` builds the competitor's graph for the workspace with the experiment-1 adapter
 * `build` subcommands (same pipelines the tools' CLIs run), then returns the command line of the native stdio server.
 *
 * Flags / env used, and why (everything else is the tool's default; nothing is tuned):
 *
 *  graphify  (v0.9.104, venv vendor/.venvs/graphify)
 *    build   : adapter `build` = `python -m graphify extract <ws> --code-only --out <cache dir>`
 *              (`--code-only`: AST only, no LLM, docs/images skipped; `--out`: artefacts go outside the workspace)
 *    serve   : `graphify-mcp --graph /tmp/work/<opaque>/idx/graphify-out/graph.json`  (stdio transport is the default;
 *              `--graph` only tells it which graph file to load; the file is a verbatim copy of the one built in the cache
 *              dir, placed beside the workspace because query_graph prints the graph path to the agent)
 *    env     : GRAPHIFY_NO_AUTO_REFRESH=1 (never rewrite ~/.claude skill files), GRAPHIFY_BACKEND=none (no LLM backend),
 *              GRAPHIFY_QUERY_LOG_DISABLE=1 (no query log file), PYTHONIOENCODING=utf-8
 *
 *  crg       (code-review-graph v2.3.9, venv vendor/.venvs/code-review-graph)
 *    build   : adapter `build` = build_or_update_graph(full_rebuild=True, postprocess="full") == `code-review-graph build`.
 *              No embeddings are built (CRG default): semantic_search_nodes_tool therefore runs FTS5/BM25 only.
 *    serve   : `code-review-graph serve --repo <ws>`  (stdio default; `--repo` pins the repository instead of
 *              auto-detecting it from the cwd; NO `--tools`, so all ~30 tools are exposed, as installed by default)
 *    env     : CRG_DATA_DIR=<cache dir> (graph.db lives there, not in the workspace), CRG_HOME=<cache dir>/crg_home
 *              (repo registry), HF_HUB_OFFLINE=1, TOKENIZERS_PARALLELISM=false
 *
 *  both:  HOME and XDG_{CONFIG,CACHE,DATA}_HOME are redirected to a scratch dir inside the cache dir so that no tool
 *         can create or modify anything under the real ~/.claude*, ~/.config/claude-accounts, ~/.cache or ~/.code-review-graph.
 *         Cloud-embedding / LLM API key variables are removed from the child's environment with `env -u`, which is
 *         why `command` is /usr/bin/env and the tool's own binary is the first argument after the -u list.
 *
 * The workspace itself is never written (checked via `git status --porcelain --ignored` before/after the build).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { abs, loadConfig } from '../../config.js';
import { lastJsonLine, runPython } from '../../competitors/py-adapter.js';
import type { Workspace } from '../workspace.js';

export type CompetitorKind = 'graphify' | 'crg';
export interface ServerSpec { name: string; command: string; args: string[]; env: Record<string, string>; build_ms: number }

const GRAPHIFY_PY = 'vendor/.venvs/graphify/bin/python';
const GRAPHIFY_ADAPTER = 'src/competitors/py/graphify_adapter.py';
const GRAPHIFY_MCP = 'vendor/.venvs/graphify/bin/graphify-mcp';
const CRG_PY = 'vendor/.venvs/code-review-graph/bin/python';
const CRG_ADAPTER = 'src/competitors/py/crg_adapter.py';
const CRG_BIN = 'vendor/.venvs/code-review-graph/bin/code-review-graph';

/** Variables removed from the server's environment (cloud embedding providers and LLM backends). */
export const UNSET_ENV = [
  'CRG_OPENAI_API_KEY', 'CRG_OPENAI_BASE_URL', 'CRG_OPENAI_MODEL', 'CRG_VOYAGE_MODEL', 'VOYAGE_API_KEY', 'GOOGLE_API_KEY', 'MINIMAX_API_KEY',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GRAPHIFY_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY',
];

function gitState(dir: string): string {
  return spawnSync('git', ['-C', dir, 'status', '--porcelain', '--ignored', '--untracked-files=all'], { encoding: 'utf8' }).stdout;
}

/** Per-workspace scratch dir. Keyed by corpus hash AND workspace opaque id (CRG graphs embed the absolute repo path). */
export function competitorCacheDir(kind: CompetitorKind, ws: Workspace): string {
  const cfg = loadConfig();
  const opaque = path.basename(path.dirname(ws.dir));
  return path.join(abs(cfg.cache_dir), 'agent-ws', ws.hash.slice(0, 12), `${kind}-${opaque}`);
}

function isolationEnv(base: string): Record<string, string> {
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  return { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local', 'share') };
}

export async function competitorServerSpec(kind: CompetitorKind, ws: Workspace): Promise<ServerSpec> {
  const base = competitorCacheDir(kind, ws);
  fs.mkdirSync(base, { recursive: true });
  const iso = isolationEnv(base);
  const before = gitState(ws.dir);
  let build_ms: number;
  let name: string;
  let command: string;
  let serverArgs: string[];
  let env: Record<string, string>;

  if (kind === 'graphify') {
    name = 'graphify';
    env = { ...iso, GRAPHIFY_NO_AUTO_REFRESH: '1', GRAPHIFY_BACKEND: 'none', GRAPHIFY_QUERY_LOG_DISABLE: '1', PYTHONIOENCODING: 'utf-8' };
    const r = runPython(abs(GRAPHIFY_PY), abs(GRAPHIFY_ADAPTER), ['build', '--repo', ws.dir, '--out', base], env);
    const info = lastJsonLine(r.stdout);
    build_ms = info.build_ms;
    const builtOut = path.dirname(info.graph_json ?? path.join(base, 'graphify-out', 'graph.json'));
    if (!fs.existsSync(path.join(builtOut, 'graph.json'))) throw new Error(`graphify build produced no graph in ${builtOut}`);
    // graphify's query_graph output starts with "Graph: <absolute path of graph.json>", which the agent reads. Serve a copy
    // from a neutral path next to the workspace (outside its cwd) so the project directory name is not disclosed.
    const neutral = path.join(path.dirname(ws.dir), 'idx', 'graphify-out');
    fs.rmSync(neutral, { recursive: true, force: true });
    fs.mkdirSync(neutral, { recursive: true });
    for (const f of fs.readdirSync(builtOut)) {
      if (fs.statSync(path.join(builtOut, f)).isFile()) fs.copyFileSync(path.join(builtOut, f), path.join(neutral, f));
    }
    command = abs(GRAPHIFY_MCP);
    serverArgs = ['--graph', path.join(neutral, 'graph.json')];
  } else {
    name = 'code-review-graph';
    env = { ...iso, CRG_DATA_DIR: base, CRG_HOME: path.join(base, 'crg_home'), HF_HUB_OFFLINE: '1', TOKENIZERS_PARALLELISM: 'false' };
    const r = runPython(abs(CRG_PY), abs(CRG_ADAPTER), ['build', '--repo', ws.dir, '--out', base], env);
    const info = lastJsonLine(r.stdout);
    build_ms = info.build_ms;
    if (!fs.existsSync(path.join(base, 'graph.db'))) throw new Error(`code-review-graph build produced no graph.db in ${base}`);
    command = abs(CRG_BIN);
    serverArgs = ['serve', '--repo', ws.dir];
  }

  const after = gitState(ws.dir);
  if (before !== after) throw new Error(`${kind} build modified the workspace:\n--- before\n${before}\n--- after\n${after}`);

  return {
    name,
    command: '/usr/bin/env',
    args: [...UNSET_ENV.flatMap((v) => ['-u', v]), command, ...serverArgs],
    env,
    build_ms,
  };
}
