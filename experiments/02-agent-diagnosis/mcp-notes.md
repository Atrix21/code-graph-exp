# Experiment 2: MCP tool layer notes

Code: `src/agent-eval/mcp/{retrieval-server,competitor-servers,inspect-servers}.ts`, `scripts/embeddings/embed_server.py`,
tests `tests/agent-eval/mcp.test.ts`. Raw measurements: `experiments/02-agent-diagnosis/results/mcp-inspection.json`
(regenerate: `npx tsx src/agent-eval/mcp/inspect-servers.ts`). No LLM and no `claude` process was involved in any of this; all
validation used the official MCP client SDK (`@modelcontextprotocol/sdk` 1.32.2, pinned exactly; it is the newest release
and worked without problems).

## 1. Our server: `search_code`

```bash
cd ROOT
npx tsx src/agent-eval/mcp/retrieval-server.ts --method <hybrid|custom_graph|embeddings|bm25|ripgrep> \
    --workspace /tmp/work/<opaque>/app --budget <tokens> [--max-results 20] --log /abs/path/calls.jsonl
```

- Exactly one tool for every method, byte-identical name, description and schema (low-level `Server`, raw JSON schema, so no
  `$schema`/`additionalProperties` boilerplate is added by a schema library):
  `search_code({query: string})`, description "Search this codebase for the code most relevant to a natural-language
  description, error message or identifier. Returns ranked code snippets with file paths and line numbers."
- Result text = the method's native `context` for budget `{maxResults, maxContextTokens: --budget}`; "No results." if empty.
  The server does not truncate: the methods' own budget handling is what is measured (all five stayed within budget in tests).
- The method comes from `REGISTRY[method]()`, i.e. the frozen experiment-1 configuration (`evaluation/configs/*.json`).
  The corpus is rebuilt from `--workspace` with `listCorpusFiles(dir, include_dirs)`; the cacheDir is
  `ROOT/.cache/agent-ws/<sha256(corpus)[:12]>` (same dir `buildWorkspace` creates). The custom graph is cached there
  (`custom-graph/graph.json`). Race: two servers that start at the same moment on a workspace whose graph is not cached yet both
  build and write that file. Run `inspect-servers.ts` (or start one server) once per snapshot before launching parallel runs.
- Log: one JSON line per successful call `{ts, query, latency_ms, result_tokens (o200k_base proxy), n_results, top_results[<=10]:{file,symbol,start_line}}`;
  failed calls log `{ts, query, latency_ms, error}`; invalid arguments are rejected before retrieval and not logged.
- stdout is MCP-only (`console.*` is redirected to stderr). stderr: `[listening]`, then `[ready] ... prepare_ms=N`.
- Start-up order: the transport is connected first, so `initialize` is answered immediately (about 0.7-0.9 s tsx start-up);
  index preparation starts right after, and `tools/call` waits for it. `startup_ms` below is spawn to `[ready]`.
  Claude Code's MCP connect timeout (`MCP_TIMEOUT`) therefore does not depend on index preparation.
- The server exits when stdin closes (the SDK's stdio server transport does not do that itself) and on SIGTERM; it kills its
  embedding child.

### Embeddings at query time (hybrid, embeddings)

- `scripts/embeddings/embed_server.py`: same model, pinned revision, fp16 on CUDA, pooling assertion, `max_seq`, query
  instruction and 6-decimal rounding as `embed.py`; model loaded once, JSON lines over stdin/stdout, `{"ready":true}` first.
- Experiment-1 code change (additive, defaults reproduce the old behaviour): `QueryEmbedder` interface,
  `EmbeddingRetriever.defaultQueryEmbedder` / `.embeddingCacheDir` (static, default `null`), `EmbeddingRetriever.prewarmQuery()`,
  `HybridRetriever.prewarmQuery()`. With an embedder configured, `scoreAll` throws if a query was not prewarmed instead of
  silently spawning Python. The server sets the statics before calling the factory, so `REGISTRY.hybrid/embeddings` are untouched.
- Document vectors: `embeddingCacheDir` = `ROOT/.cache/embeddings` (the experiment-1 content-hash cache, not
  `.cache/agent-ws/embeddings`, which `EmbeddingRetriever` would otherwise derive from the cacheDir). All chunks of both
  inspected snapshots were cache hits (`index_ms` about 165 ms, no Python document pass). A snapshot with uncached chunks would
  trigger the old `embed.py` path at start-up and append to that cache.
- Consistency check (6 queries incl. identifier-only and stack-trace style): embed.py one-batch path (experiment-1
  `Embedder`) vs embed_server.py one query at a time: **min cosine 0.999996** (all six in 0.999996-0.999997), identical token
  counts. The experiment-1 cached query vectors themselves were not used because their query texts are task descriptions (ground
  truth directory, off limits here); the reference is the same code path that produced them.
- GPU: each embedding server holds a Qwen3-0.6B fp16 copy (about 1.3 GB). On this 6 GB GPU at most about 3 concurrent
  hybrid/embeddings runs fit (I hit a CUDA OOM while another job held 3.8 GB). bm25, ripgrep, custom_graph need no GPU.

## 2. Competitor native servers: `competitorServerSpec(kind, ws)`

Both build with the experiment-1 adapters' `build` subcommand (pinned venvs, versions graphify 0.9.104, CRG 2.3.9), assert the
workspace's `git status --porcelain --ignored` is unchanged, and return the native stdio server. `command` is `/usr/bin/env`
(see "env -u" below), the tool binary follows the `-u` list.

| | Graphify | Code Review Graph |
|---|---|---|
| build | `python -m graphify extract <ws> --code-only --out <cache>` (cold) | `build_or_update_graph(full_rebuild=True, postprocess="full")` |
| server | `graphify-mcp --graph /tmp/work/<opaque>/idx/graphify-out/graph.json` | `code-review-graph serve --repo <ws>` |
| env | `GRAPHIFY_NO_AUTO_REFRESH=1 GRAPHIFY_BACKEND=none GRAPHIFY_QUERY_LOG_DISABLE=1 PYTHONIOENCODING=utf-8` | `CRG_DATA_DIR=<cache> CRG_HOME=<cache>/crg_home HF_HUB_OFFLINE=1 TOKENIZERS_PARALLELISM=false` |
| cache dir | `ROOT/.cache/agent-ws/<hash12>/graphify-<opaque>/` | `ROOT/.cache/agent-ws/<hash12>/crg-<opaque>/` (graph.db) |
| build time | about 1.5-1.8 s | about 0.65 s |

Every flag, with the reason:
- `--code-only` (Graphify build): AST only, no LLM; the only headless path that writes outside the repo (`--out`).
- `--graph` (graphify-mcp): selects the graph file; stdio is the default transport. `--repo` (CRG serve): pins the repository
  instead of auto-detecting from cwd; stdio default. No `--tools`, `--auto-watch`, or `--http`.
- Cache dirs are keyed by corpus hash AND workspace opaque id, because CRG qualified names embed the absolute repo path
  (a graph is only valid for the path it was built at).
- All of both tools' tuning defaults are untouched: Graphify `query_graph` MCP defaults (bfs, depth 3, token_budget 2000, i.e.
  deeper than the CLI's depth 2 used in experiment 1); CRG `semantic_search_nodes_tool` defaults (limit 20, standard detail, FTS
  only because no embeddings are built, which is CRG's default).
- **`env -u`**: an MCP `env` map can add variables but not remove them; the child would inherit the harness' environment. The
  wrapper removes `CRG_OPENAI_API_KEY, CRG_OPENAI_BASE_URL, CRG_OPENAI_MODEL, CRG_VOYAGE_MODEL, VOYAGE_API_KEY, GOOGLE_API_KEY,
  MINIMAX_API_KEY, OPENAI_API_KEY, OPENAI_BASE_URL, ANTHROPIC_API_KEY, GEMINI_API_KEY, GRAPHIFY_API_KEY, MOONSHOT_API_KEY,
  DEEPSEEK_API_KEY`. (Neither server uses a key in this configuration; this is belt and braces.)
- **HOME isolation** (deviation from "just run it"): `HOME` and `XDG_{CONFIG,CACHE,DATA}_HOME` point to `<cache dir>/home`, so
  nothing can touch `~/.claude*`, `~/.config/claude-accounts`, `~/.cache`, or create `~/.code-review-graph`.
  Verified: `~/.code-review-graph` does not exist after all runs; both servers work with the scratch HOME.
- **Graphify graph copied to a neutral path** (deviation): `query_graph` prints `Graph: <absolute path of graph.json>`; with the
  graph in the cache that disclosed `/home/.../code-graphs/.cache/agent-ws/...` to the agent. The built `graphify-out/` files
  (no `cache/`) are copied verbatim to `/tmp/work/<opaque>/idx/graphify-out/` (beside the workspace `app/`, outside the agent's
  cwd). Content is identical. `inspect-servers` and the tests scan sample results for `code-graphs|experiments|adityareddy|.cache|evaluation/|/home/`
  and find nothing for any server. A broader scan over 8 CRG tools and 5 Graphify tools also found no leaks (only the
  Graphify header above, now fixed). CRG outputs contain the workspace path `/tmp/work/<opaque>/app/...` (same as the cwd).
  Note `buildWorkspace` deletes `/tmp/work/<opaque>/`, so call `competitorServerSpec` after it (it does the copy itself).

## 3. Measurements (task `auth_jwt_secret_01`; `base` is within noise)

Sample query: "Users get 401 Unauthorized on every request after logging in; the JWT token verification seems to reject valid
tokens". Our servers: budget 4000, max_results 20. Tokens are o200k_base proxy tokens.

| server | tools | tools/list tokens | startup (spawn to ready) | initialize | 1st call | 2nd call | result tokens |
|---|---|---|---|---|---|---|---|
| search_code: hybrid | 1 | 62 | 7.0 s | 0.8 s | 503 ms | 33 ms | 3739 |
| search_code: custom_graph | 1 | 62 | 1.0 s | 0.8 s | 504 ms | 23 ms | 3573 |
| search_code: embeddings | 1 | 62 | 5.8 s | 0.7 s | 525 ms | 10 ms | 1978 |
| search_code: bm25 | 1 | 62 | 1.0 s | 0.8 s | 429 ms | 13 ms | 3937 |
| search_code: ripgrep | 1 | 62 | 0.76 s | 0.7 s | 439 ms | 21 ms | 1374 |
| Graphify native | 10 | 1350 | 0.65 s | 0.65 s | 64 ms | 34 ms | 1589 |
| CRG native | 30 | 8242 | 0.9 s | 0.9 s | 5.9 s | 10 ms | 2506 |

(The ripgrep row was measured once with a scratch probe on `auth_jwt_secret_01` and is not in the inspection JSON, which covers the four methods in the brief; ripgrep is covered by the tests.)
`tools/list tokens` = o200k_base tokens of `[{name, description, input_schema}]` for all tools; this is re-sent to the model
every turn (prompt caching reduces its price but not its context share). Per-tool sizes are in the JSON (`tool_tokens`).
First-call latency of our servers includes lazy first-use work (about 0.4-0.5 s even for BM25); CRG's first search imports
torch (`embeddings._check_available`, about 6 s, then 7-10 ms). Hybrid/embeddings startup is dominated by the embedding model
load (about 5-7 s here, GPU busy with another job); document vectors are cached.

Tools exposed:
- Graphify (10): `query_graph, get_node, get_neighbors, get_community, god_nodes, graph_stats, shortest_path, list_prs, get_pr_impact, triage_prs`
- CRG (30): `build_or_update_graph_tool, run_postprocess_tool, get_minimal_context_tool, get_impact_radius_tool, query_graph_tool, get_review_context_tool, semantic_search_nodes_tool, embed_graph_tool, list_graph_stats_tool, get_docs_section_tool, find_large_functions_tool, list_flows_tool, get_flow_tool, get_affected_flows_tool, list_communities_tool, get_community_tool, get_architecture_overview_tool, detect_changes_tool, refactor_tool, apply_refactor_tool, generate_wiki_tool, get_wiki_page_tool, get_hub_nodes_tool, get_bridge_nodes_tool, get_knowledge_gaps_tool, get_surprising_connections_tool, get_suggested_questions_tool, traverse_graph_tool, list_repos_tool, cross_repo_search_tool`

Sample call used for the native servers: Graphify `query_graph{question}`, CRG `semantic_search_nodes_tool{query}`.

## 4. For the fairness auditor

1. **Tool-count / schema-cost asymmetry.** Ours: 1 tool, 62 tokens of schema per turn. Graphify: 10 tools, 1350 tokens. CRG:
   30 tools, 8242 tokens. This is the tools' real shipped surface (defaults, no `--tools` filter) and a legitimate cost of
   those conditions, but it also changes agent behaviour (more choices, more context per turn). Per-condition token cost
   should be analysed with and without the tool-schema share. An allow-list (`serve --tools`, or Claude Code
   `--allowedTools`) would be an additional tuned variant, not the default.
2. **Write-capable and non-retrieval tools.** The brief says the agent has read-only file tools. CRG exposes
   `apply_refactor_tool` (edits source files in the repo), `generate_wiki_tool` (writes `.code-review-graph/wiki/` into the
   repo), `build_or_update_graph_tool`/`embed_graph_tool`/`run_postprocess_tool` (mutate the graph, may build embeddings with
   a local model), plus `cross_repo_search_tool`/`list_repos_tool`. Graphify's `list_prs/get_pr_impact/triage_prs` shell out to
   `gh` (fail here: "gh CLI not found or not authenticated"; with a logged-in `gh` and a remote they could use the network).
   The harness should deny the write/mutation tools (Claude Code `--disallowedTools mcp__<server>__apply_refactor_tool ...`) and
   log if the agent attempts them; this is outside what this layer enforces. Because workspace isolation can only check
   writes after the fact, `checkWorkspaceIsolation`-style git status checks after each run are advisable.
3. **Output size is not equalised.** Our servers cap output at `--budget`. Graphify's `token_budget` default is 2000 (a 3
   chars/token estimate; real output can exceed it, here 1589 proxy tokens). CRG has no budget parameter (2.5k tokens for one
   standard search, with long absolute paths repeated per row, as in experiment 1). We did not tune either.
4. **Search quality caveats carried over from experiment 1**: Graphify seeds lexically (label/path match) and its MCP depth
   default is 3 (CLI 2); CRG without embeddings indexes names/signatures/docstrings only (FTS5), no bodies. Graphify's
   `query_graph` can silently collapse to a tiny subgraph when the question contains words like "call/return/import".
5. **Our servers reuse the benchmark's retrieval code** (that is the point), but the frozen configs were tuned for a bug
   report as query. An agent will issue shorter, identifier-style or multi-step queries; nothing is tuned for that.
6. **Embeddings fp16 batch effect**: server (batch 1) vs experiment-1 (batch 16, length-sorted) query vectors differ at the
   1e-6 cosine level; ranking differences are possible only for near-ties. Document vectors are the experiment-1 ones.
7. **Latency numbers are not comparable across servers** (tsx cold start, first-call lazy work, GPU contention from another
   job at measurement time).
8. **Paths**: our context is repo-relative; CRG shows absolute `/tmp/work/<opaque>/app/...` (as the agent's cwd). No server
   output contained project/host path fragments in the sample calls (scan described in section 2).
9. Process hygiene for the harness: servers exit on stdin close, but a harness that kills `claude` hard should also kill the
   process group, otherwise an orphaned `embed_server.py` keeps about 1.3 GB of GPU memory.
