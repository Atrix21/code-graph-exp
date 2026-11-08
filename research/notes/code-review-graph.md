# Code Review Graph (CRG) - investigation and adapter notes

Everything marked "ran" was executed in this session; "read" means taken from source; "unverified" is stated explicitly.

## 1. Upstream identity and pin

- Upstream: https://github.com/tirth8205/code-review-graph (MIT). PyPI `code-review-graph` project_urls (queried from pypi.org JSON): Repository = that GitHub URL, Homepage code-review-graph.com, author "Tirth". Confirmed it is the true upstream, not a fork.
- Pinned: tag **v2.3.9**, commit **343ab7cea29d47a3e805381e09f8243a43d43d88**, committed 2026-09-18T20:40:44+01:00. PyPI 2.3.9 was uploaded 2026-09-18T19:41:48Z (latest release). `pyproject.toml` version = 2.3.9. Clone at `ROOT/vendor/code-review-graph`, detached at `v2.3.9`, working tree clean. (Upstream HEAD 115dccf is ~7 weeks newer, unreleased; not used.)
- Adapter checks that the installed package is byte-identical to the vendored `code_review_graph/**/*.py` (ran: `installed_matches_vendor: true`).

## 2. Install (exact commands, ran)

```
cd ROOT/vendor
uv venv --python 3.12 .venvs/code-review-graph
uv pip install --python .venvs/code-review-graph/bin/python "./code-review-graph[embeddings,communities]"
```
- Non-editable install from the pinned clone; no source modified.
- Extras: `embeddings` (sentence-transformers + torch 2.15 + numpy), `communities` (igraph, used by Leiden community detection in postprocess; without it communities fall back/are skipped - unverified). Other extras exist: `google-embeddings`, `enrichment` (jedi, Python only), `eval`, `wiki`, `all`. Versions resolved: fastmcp 3.4.11, mcp 1.30.0, tree-sitter 0.26.0, tree-sitter-language-pack 0.13.0, igraph 1.0.0, networkx 3.7.
- Invoke adapter with the venv python: `ROOT/vendor/.venvs/code-review-graph/bin/python -I ROOT/src/competitors/py/crg_adapter.py ...`

## 3. Graph construction for TypeScript (read + ran)

- Parser: tree-sitter via `tree_sitter_language_pack.get_parser("typescript"|"tsx")` (`parser.py`, `CodeParser`). `.ts/.mts/.cts` -> `typescript`, `.tsx` -> `tsx`, `.js/.jsx` -> `javascript` (`EXTENSION_TO_LANGUAGE`, parser.py ~L963). No type-checker/LSP: purely syntactic plus heuristic resolvers. No LLM anywhere in build or search.
- Node kinds (`NodeInfo.kind`, parser.py L918): `File`, `Class`, `Function`, `Type`, `Test` (+ Java/Spring-only `Endpoint`, `Scheduler`, `ConfigProperty`). For TS the class types are `class_declaration, class, interface_declaration, type_alias_declaration, enum_declaration` (`_CLASS_TYPES`, L1158, #737) - ran: interfaces appeared as kind `Class` in the DB (article.interface.ts -> Class ArticleRO etc.), not `Type`. Function types: `function_declaration, method_definition, arrow_function` (`_FUNCTION_TYPES`, L1251); ran: constructors and inner arrow functions in methods become Function nodes (e.g. `ArticleService.el`, `.constructor`). Test nodes come from test-file/name patterns (`_TEST_PATTERNS` etc.); `*.spec.ts` produced `Test` nodes (`it:...@L23`, `beforeEach@L11`).
- Edge kinds (parser.py L943): `CALLS, IMPORTS_FROM, INHERITS, IMPLEMENTS, CONTAINS, TESTED_BY, DEPENDS_ON, REFERENCES` (+ Spring/Temporal kinds). Ran on nestjs-realworld: CALLS 335, CONTAINS 128, IMPORTS_FROM 141, REFERENCES 147, TESTED_BY 16, INHERITS 6. For TS, `extends` and `implements` both emit `INHERITS` (`_get_bases`, L17868: `class_heritage` / `extends_type_clause`); IMPLEMENTS is not used for TS (ran: `implements NestModule` -> INHERITS).
- Qualified names: `<ABSOLUTE posix file path>::Class.method` or `<abs path>::name` (`CodeParser._qualify`, L16876; `full_build` stores `str(repo_root/rel_path)`, incremental.py L1798). File node: qualified_name = name = absolute path. Line ranges are 1-based inclusive, `line_start..line_end` of the AST definition node (ran: `ArticleService` 14-204 matches the file; the decorator line above is excluded).
- Imports: `IMPORTS_FROM` edge file -> resolved absolute file path (relative imports, `tsconfig.json`/`jsconfig.json` `paths` aliases via `tsconfig_resolver.py`), or raw module string for npm packages (ran: `@nestjs/common`).
- Call resolution: parse time binds same-file names (`_resolve_call_targets` L5243) and imported symbols (`_resolve_call_target` L16674); TS constructor parameter properties (`private readonly articleService: ArticleService`) and typed params become receiver-type bindings (`_collect_ts_parameter_properties`, L5836), so `this.articleService.findAll()` in a controller resolves to `ArticleService.findAll` in another file. Ran: `ArticleController.findAll -> article.service.ts::ArticleService.findAll` (target_resolution=direct). Post-process `GraphStore.resolve_bare_call_targets` (graph.py L1804) binds remaining bare targets only with same-file or exactly-one-imported-file evidence. Everything else stays a bare name (`map`, `createQueryBuilder`, `InjectRepository`; 275 of 335 CALLS edges were `unresolved` in the test repo), flagged `target_resolution` in `edges` and `resolution_split` in tool output. Calls through ORM/query-builder chains, `this.repo.save()` on injected third-party types, decorators (`@Get()` -> bare `Get`) are not resolved to project nodes.
- Default file set: `git ls-files` (tracked files only), minus `DEFAULT_IGNORE_PATTERNS` (`/dist/**`, `node_modules`, `*.map`, `*.lock`, `package-lock.json`, ...; incremental.py L218) and `.code-review-graphignore`; every supported language is indexed (so tracked `.js` files, e.g. a root `index.js`, are included). Untracked files are invisible; modified tracked files are read from disk.
- Post-process (`tools/build.py::_run_postprocess`): bare-target resolution, signatures, FTS5 index, execution flows (21 flows on test repo), Leiden communities (seed 42), summary tables. Flows/communities are not used by our search policies.

## 4. LLM requirement

None. Build, FTS5/BM25 search, optional local embeddings (sentence-transformers), impact/graph queries are all local and deterministic. Cloud embedding providers (OpenAI-compatible, Google, Voyage, MiniMax) are opt-in via env keys only; the adapter unsets those env vars. CLI/main contain no telemetry or update-check code (grep for pypi/urlopen/telemetry/auto_update in cli.py, main.py, incremental.py, skills.py found none). `llm_tokens` is therefore `null`.

## 5. Agent-facing retrieval interfaces (30 MCP tools, `main.py`)

Retrieval-relevant (defaults from `main.py` signatures):
- `semantic_search_nodes_tool(query, kind=None, limit=20, detail_level="standard", model, provider)` -> `tools/query.py::semantic_search_nodes` -> `search.py::hybrid_search`.
  - FTS5 over `nodes_fts` columns `name, qualified_name, file_path, signature, docstring, name_tokens` with BM25 weights 10/6/1/2/1.5/4 (`_FTS_COLUMN_WEIGHTS`). **Function bodies are not indexed.** Query -> tokens, each quoted + prefix `*` (>=3 alnum chars); first tries `t1 AND t2 ...`, falls back to `OR` only if AND returns nothing; max 12 terms, keeping the longest ones (`build_fts_queries`, `_cap_terms`). Double-quoted text in a query is treated as a phrase and suppresses OR widening.
  - If the `embeddings` table is non-empty, a vector search (cosine, brute force) is also run and merged with FTS by Reciprocal Rank Fusion k=60 (`rrf_merge`); `search_mode` is `fts`, `hybrid`, `semantic`, `keyword` (LIKE fallback) or `none`. **Default = FTS only** (embeddings are an explicit opt-in step: `embed_graph_tool` / `code-review-graph embed`; builds never embed unless asked). No flag at query time; presence of vectors in the DB switches it on.
  - Native post-ranking multipliers on the fused score: kind boost (PascalCase query -> Class/Type x1.5, snake_case -> Function x1.5), identifier-in-qualified-name x2, name-coverage x(1+covered/query_words) and x2 if the symbol words equal the query words, exact-name x4, `context_files` x1.5. Results sorted by final score; `score` is returned (RRF-scale ~0.01-0.03 in hybrid/fts, because RRF is applied even with a single list). `limit*3` candidates fetched; `kind` filter applied after.
  - Result fields (standard): name, qualified_name, kind, file_path (absolute), line_start, line_end, language, params, return_type, signature, score. `minimal`: name, kind, file_path, score for the top 5 only.
- `query_graph_tool(pattern, target, detail_level="standard", max_results=100, resolution="all")` -> `query_graph`. Patterns: callers_of, callees_of, references_to, imports_of, importers_of, children_of, tests_for, inheritors_of, file_summary (+ Java/Spring ones). Target resolved as exact qualified name, else absolute path, else a name search (if several candidates -> `status: ambiguous` with candidates; so pass a qualified_name). callers_of/callees_of/references_to emit one row per call site (`call_site: {line}`), ordered so each distinct node appears once before any repeat (`_interleave_call_sites`), edge insertion order otherwise; callers_of on a bare common-builtin name (`map`, `get`, `update`...) is skipped, but qualified names bypass that. Unresolved callees come back as rows with only a bare name (no file). `minimal` caps at 5 rows.
- `get_impact_radius_tool(changed_files, max_depth=2, max_results=500, detail_level, resolution)` -> `graph.py::get_impact_radius_sql`: input is FILES (all nodes in them are seeds); BFS over incoming CALLS/INHERITS/IMPLEMENTS/REFERENCES/IMPORTS_FROM and TESTED_BY with weights and depth decay (`IMPACT_EDGE_WEIGHTS`, constants.py L232). It returns dependents (who may break), not callees. `impacted_nodes` ordered by best-path `impact_score` desc then qualified name; capped at 100 nodes/150 edges/200 files in output. Without `changed_files` it uses `git diff` (review mode).
- `traverse_graph_tool(query, mode="bfs", depth=3, token_budget=2000)`: the only tool taking free text and returning a neighbourhood: `hybrid_search(limit=1)` -> BFS from that single node over both edge directions, budget `len(str(entry))//4`. Entries have name/qualified_name/kind/file/depth (no lines).
- `get_minimal_context_tool(task, ...)`: ~100-token stats/community/flow names; not query-dependent beyond a keyword-chosen "next tools" list. `get_review_context_tool` / `detect_changes_tool` / `get_affected_flows_tool`: need changed files or a git diff (review workflow). `list_flows/get_flow/list_communities/get_community/get_architecture_overview/hub/bridge/...`: structural overviews, not query-relevance ranked. `cross_repo_search_tool`: multi-repo registry search.

### Which interface fits "NL bug report -> code"
No single NL->localisation tool exists. CRG ships its own debug workflow: `prompts.py::debug_issue_prompt` (`get_minimal_context_tool(task="debug: ...")` -> `semantic_search_nodes_tool(query=<keywords>, detail_level="minimal", limit=5)` -> `query_graph_tool(callers_of, target=<name>)` on the top 1-2 results -> optionally `get_flow_tool`) and `skills/debug-issue/SKILL.md` (search -> `callers_of` and `callees_of` -> get_flow -> detect_changes -> get_impact_radius; "about five tool calls and 800 tokens"). Our policies encode that, deterministically.

## 6. Adapter policies (compromises are explicit)

All policies: step 1 = `semantic_search_nodes` with the raw bug report as `query`, tool-default `limit=20`, `detail_level=standard`.
- `search_only`: step 1 only.
- **`search_expand` (default)**: step 1, then `query_graph` `callers_of` and `callees_of` (tool defaults, `max_results=100`) for the top 2 search hits whose kind is Function or Test, in search order (seed1 callers, seed1 callees, seed2 callers, seed2 callees); targets are the hits' qualified names. Chosen as default because it is the only multi-tool sequence CRG itself documents for bug localisation. Results = search hits in rank order, then expansion rows in CRG's order, deduped by raw_id.
- `search_impact`: step 1, then `get_impact_radius` on the files of the top-2 callable hits (review-style usage). Results = search hits then `impacted_nodes` in impact_score order (changed_nodes omitted: they are all nodes of the seed files).
- `search_traverse`: step 1, then `traverse_graph_tool(query=<same text>)`.
- `--include-minimal-context` prepends `get_minimal_context_tool` (CRG prompts say "call first"); off by default since it adds ~60 tokens and no results.
Compromises vs a real agent: (a) a real agent would extract keywords from the report (no LLM here, so the whole report is passed; CRG's own term cap keeps the 12 longest tokens); (b) a real agent chooses which hits to expand - we use "top-2 callable hits"; seeds must be callable because callers_of/callees_of on a Class hit returned nothing in tests (ran); (c) the shipped prompt uses `detail_level=minimal, limit=5`; we default to standard because results need line ranges/qualified names (flag `--detail-level minimal --limit 5` reproduces the prompt; then rows lack lines and raw_id falls back to the bare name); (d) get_flow/detect_changes/impact are skipped in the default policy (flows need a flow name an LLM would pick; detect_changes needs a diff).
Rows without a file (unresolved bare callees like `map`) stay in `context` but are excluded from `results`.

## 7. Adapter behaviour and exact commands

```
PY=ROOT/vendor/.venvs/code-review-graph/bin/python; A=ROOT/src/competitors/py/crg_adapter.py
$PY -I $A build --repo /abs/ts/repo --out /abs/out [--embeddings] [--device auto|cpu]
$PY -I $A query --graph /abs/out --repo /abs/ts/repo --queries in.jsonl --out out.jsonl \
   [--policy search_expand|search_only|search_impact|search_traverse] [--limit N] [--seeds 2] \
   [--seed-kinds Function Test] [--expand-patterns callers_of callees_of] [--expand-limit N] \
   [--detail-level standard|minimal] [--include-minimal-context]
```
- Build = `tools.build.build_or_update_graph(full_rebuild=True, postprocess="full")` (what `code-review-graph build` calls); with `--embeddings` also `tools.docs.embed_graph(provider="local")` (model all-MiniLM-L6-v2, default; device chosen by sentence-transformers: `cuda:0` on this machine; `--device cpu` hides GPUs). Prints the required JSON plus `details` (files_parsed, parse_errors, flows, communities, embeddings{model,device,counts}, `target_repo_untouched`, vendor tag, installed_matches_vendor). `build_ms` includes embedding time when embedding (graph and embed times separately in details).
- Isolation: `CRG_DATA_DIR=<out>` (graph.db lives there; documented env var, no repo copy needed; ran: `git status --porcelain --ignored` of the target identical before/after), `CRG_HOME=<out>/.crg_home` (registry/per-user state; otherwise CRG creates `~/.code-review-graph/` - my first manual `code-review-graph build` created that empty dir, removed), `HF_HUB_OFFLINE=1`, cloud-embedding env keys unset. The adapter never calls `install`, `init`, `serve`, hooks, skills or watch; nothing in `~/.claude*`, `.mcp.json`, CLAUDE.md or git hooks was touched.
- Graph is bound to the absolute repo path (qualified names contain it; `assert_graph_serves_root` refuses a foreign root); query with the same `--repo` as build. The repo must be a git checkout (`_validate_repo_root` needs `.git`; indexing uses `git ls-files`).
- Query calls the same functions as the MCP tools, not the MCP wrappers. Verified (ran): through an in-process FastMCP client the tool text equals the adapter's `context` text exactly except for the `_graph` provenance envelope (`updated_at`, `age_seconds`, shas) that `main.py::_offload/with_provenance` adds; that envelope is time-varying, so it is omitted (about 60 tokens per call not counted).
- `context` = compact JSON of each tool response (FastMCP serialisation style), joined with `\n`, in call order; per-call character ranges are in `metadata.tool_calls[*].context_char_range`. `results[].file` is repo-relative posix; `raw_id` = CRG qualified name verbatim (absolute-path based); `symbol` = part after `::`; `node_type` = CRG kind; `score` = search score (search hits), `impact_score` (impact), else null. An untimed warm-up search runs first (the first search imports torch via `embeddings._check_available`, 3-5 s one-off).

## 8. Token measurement

CRG has only chars/4 estimates (`context_savings.py::estimate_tokens`, `token_benchmark.py::estimate_tokens`; optional `--verify` with tiktoken cl100k_base) and `context_savings` metadata on impact/review responses (it compares with changed-file sizes, meaningless here). The adapter records `metadata.context_chars` and `crg_token_estimate_chars_div_4`, but benchmark token cost should be our own tokenizer over `context`. Measured on 3 queries (chars/4): search_only ~3.1-3.4k, search_expand ~4.8-5.9k, search_traverse ~5.1-5.4k, search_impact ~8.9-28k tokens. Standard-detail search rows include `params`, `signature` and a long absolute path in `qualified_name` and `file_path` (the path is repeated 2x per row), which inflates tokens relative to tools with relative paths; this is CRG-native output.

## 9. Test results (ran, nestjs-realworld-example-app @ c1c2cc4, 36 indexed files)

3 bug-report-style queries (favorite count, login 401 / password hash, duplicate follow). Build: 160 nodes, 773 edges, ~0.35 s (FTS) / ~4.4 s with embeddings (GPU, mostly model load). All four policies produced well-formed output (20-53 results; statuses ok).
- Determinism (FTS mode): two independent builds -> identical node set (160) and edge set (773) including identical edge insertion order; query outputs identical across a re-run on the same graph and across rebuilt graphs (excluding latency).
- Embeddings mode (hybrid, `cuda:0`): two GPU builds -> byte-identical vectors and identical outputs; CPU build vectors differ from GPU at max abs 1.9e-7 (not byte-identical) but query outputs (results, scores, context) were identical on these 3 queries. With larger corpora ties could flip; unverified.
- Query latency after warm-up: FTS ~3-5 ms search_only, ~10 ms search_expand; hybrid ~18-28 ms.
- Example rankings: t2 (login/password) FTS top hits included `UserService.findByEmail`, `UserEntity.hashPassword`; hybrid reordered with `LoginUserDto` first. No claim of quality beyond sanity.

## 10. Limitations / fairness caveats

1. CRG is review/diff-oriented; there is no NL->context tool. Results depend entirely on the compromise policy; the default searches identifiers only.
2. Search indexes names, paths, signatures, doc comments only; no body text. Bug reports using behavioural vocabulary not present in identifiers get poor FTS recall. Embeddings are over name/signature/docstring-derived text only (`embeddings._node_to_text`), not bodies.
3. Query handling quirks: AND-then-OR, 12-term cap preferring long tokens, prose handled as raw tokens; any double quotes in a bug report switch to phrase semantics (recorded in `metadata.query_has_double_quotes`).
4. Absolute repo path is stored in `qualified_name` and `file_path`, both FTS-indexed, so checkout directory words are present in every row (IDF ~0, mostly harmless, but query words matching path segments match everything). Using a neutral, identical checkout path across runs avoids bias. Qualified names are non-portable across machines.
5. Only tracked files in a git repo are indexed; default ignores drop `dist/`, `build/`, lock files, `*.map`; all languages indexed, tests included. Graph is a snapshot of the working tree at build time (modified tracked files included, untracked excluded).
6. Many CALLS edges stay unresolved (bare names), especially through injected third-party services/ORM chains; callers_of/impact do not see them. Impact radius returns dependents only, so it misses callees where bugs often live.
7. Tool output is full of absolute paths and metadata (token-heavy in standard detail). `_graph` envelope omitted (see 7).
8. Class hits are poor expansion seeds; our policy filters to Function/Test (an adapter-level choice).
9. Not tested here: Express/JS-style repos, tsconfig path aliases, `.tsx`, monorepos, large repos (CRG README claims ~40 s for 3,000 files, unverified). Leiden/flows quality for TS is unevaluated (README itself says JS/TS flow detection needs work).
10. Upstream is fast-moving (30 MCP tools, ~weekly releases); results are pinned to v2.3.9.
