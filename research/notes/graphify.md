# Graphify - investigation notes and adapter

All claims below were checked against the pinned source in `vendor/graphify` or by running the adapter. Items I could not verify are listed in the last section.

## 1. Upstream identity and pin

- PyPI package `graphifyy` metadata (installed dist-info of the 0.9.63 uv-tool copy, and `pypi.org/pypi/graphifyy/json`): `Project-URL Repository = https://github.com/Graphify-Labs/graphify`.
- `https://github.com/safishamsi/graphify` returns `301 -> https://github.com/Graphify-Labs/graphify`, and `git ls-remote` on both names returns the same HEAD (`6c8002eca4ac...`). So `safishamsi/graphify` is the old name of the same repo (the author's personal account), not a fork. The README says: "Official package: PyPI `graphifyy` (double-y). Other `graphify*` packages are not affiliated" and "The official source repository is Graphify-Labs/graphify".
- Canonical URL: **https://github.com/Graphify-Labs/graphify** (Apache-2.0).
- Pinned: tag **v0.9.104**, commit **`433a57a002908e74c9f0abd2ad93af8b302b71c4`**, committed 2026-11-07 23:19 UTC (version bump commit `cb5106e8`; PyPI wheel `graphifyy-0.9.104` uploaded 2026-11-08 00:43 UTC, the latest release on PyPI at the time). Upstream HEAD is one docs-only commit later (`6c8002ec`, CHANGELOG.md only; `git diff --stat v0.9.104 HEAD` confirms). The machine's global uv tool is the older 0.9.63; we do NOT use it.
- The tag list contains a stray `v1.0.0` (commit 0a31c086, Apr 2026, an old commit); ignore it, the real release line is 0.9.x.
- Clone is in `vendor/graphify`, detached at `v0.9.104`, working tree clean (no source modifications).

## 2. Install (exact commands)

```bash
cd ROOT/vendor
git clone https://github.com/Graphify-Labs/graphify graphify
git -C graphify checkout v0.9.104            # 433a57a0
uv venv --python 3.12 .venvs/graphify
uv pip install --python .venvs/graphify/bin/python -e './graphify[mcp]'
.venvs/graphify/bin/python -c "from importlib.metadata import version; print(version('graphifyy'))"   # 0.9.104
```

- Extras: only `mcp` (to be able to inspect the MCP server). I deliberately did NOT install the `leiden` extra: the README's default install (`uv tool install graphifyy`) has none, and `graphify/cluster.py` then falls back to networkx Louvain (README: "Leiden fallback: without the leiden extra, clustering silently uses networkx Louvain"). Community ids only appear as a `community=N` field in output and do not influence seeding or ordering.
- tree-sitter pins resolved to `tree-sitter 0.25.2`, `tree-sitter-typescript 0.23.2`, networkx 3.7.

### Side effect to be aware of (my mistake, now neutralised)
The first run of the pinned venv's `graphify` CLI **auto-refreshed the Claude skill** at `~/.config/claude-accounts/ashrith/skills/graphify/` (0.9.63 -> 0.9.104): `SKILL.md` and `references/*.md` were overwritten and `.graphify_version` bumped; the previous `SKILL.md` was saved as `SKILL.md.bak` in the same dir. This is a Graphify feature (`GRAPHIFY_NO_AUTO_REFRESH=1` disables it). The adapter now always sets `GRAPHIFY_NO_AUTO_REFRESH=1`. The old `references/` content was not backed up; to roll back SKILL.md: `mv SKILL.md.bak SKILL.md` and write `0.9.63` into `.graphify_version`. `~/.copilot/skills/graphify` was not touched (only a stderr warning about its version is printed on every run; harmless).

## 3. How the graph is built for TypeScript

Pipeline (ARCHITECTURE.md): `detect -> extract -> build -> cluster -> analyze -> report -> export`.

**Parser**: tree-sitter. `.ts/.mts/.cts` use `tree_sitter_typescript.language_typescript`, `.tsx` uses `language_tsx` (`graphify/extract.py` `_TS_CONFIG` ~L1437, `_TSX_CONFIG` ~L1469, `extract_js` L2352 which dispatches by suffix; a few pre-parse source normalisations for `import type`/tag annotations at L2172-2330). The language-generic walker is `_extract_generic` in `graphify/extractors/engine.py` L6418 (driven by `LanguageConfig`). JS files use `_JS_CONFIG` through the same path. Plain-JS `import()` is rescued by regex (`_rescue_js_dynamic_imports`).

**Node kinds extracted for TS** (config at extract.py `_TS_CONFIG`):
- File node (label = file name, `source_location L1`).
- `class_declaration`, `abstract_class_declaration`, `interface_declaration`, `enum_declaration`, `type_alias_declaration` (label = bare name).
- `function_declaration`, `generator_function_declaration`, `method_definition`, `method_signature`, `abstract_method_signature` (label `name()` for functions, `.name()` for methods, e.g. `.login()`); constructors are nodes (`.constructor()`).
- Arrow-function/const bindings are tracked by the walker (function boundary types listed in config).
- Imported/external symbols become stub nodes with empty `source_file` (e.g. NestJS decorators `Get`, `Injectable`, `Column` appear as many identically-labelled nodes per file).
- Non-TS side effects in a code-only run: `package.json` dependencies become `concept` nodes (`json_config.py`), and `tsconfig.json` / `project.json` etc. are parsed structurally (relation `declares` / `extends`).
- Node id scheme: slug of path stem + enclosing names (e.g. `src_user_user_service_userservice_findbyid`). Node attributes: `label`, `norm_label`, `source_file` (repo-relative posix path), `source_location` (`"L<start>"` only), `file_type` (`code`/`concept`), `community`, `_callable`, `_callable_class`, `_ts_fields` (class field -> declared type table), `metadata.unresolved_calls`.

**Edge relation types observed on the 2 test repos (NestJS realworld, Express/Prisma realworld) and present in source**: `contains` (file->symbol), `method` (class->method), `calls`, `indirect_call`, `imports` (file->module/file), `imports_from` (file->imported symbol), `re_exports`, `references` (with `context` = decorator / generic_arg / parameter_type / field / return_type), `inherits` / `implements` (engine.py), `extends` (tsconfig), `declares` (json_config), `defines`, `case_of` (enum members), plus `listened_by`, `bound_to`, `uses_static_prop`, `references_constant` in the generic engine (engine.py ~L10922-10970). Nest result: 677 edges = references 187, imports_from 129, contains 109, imports 107, method 70, calls 33, declares 32, re_exports 10. Express: contains 245, imports 105, imports_from 70, calls 34, declares 39, extends 4, references 3, inherits 1, method 1, indirect_call 1.

**Confidence tags**: yes. Every edge has `confidence` in {EXTRACTED, INFERRED, AMBIGUOUS} plus numeric `confidence_score` (`validate.py` `VALID_CONFIDENCES`; ARCHITECTURE.md "Confidence labels"). On the test repos only EXTRACTED and INFERRED occur (Nest: 655/22; Express: 502/1). The Nest INFERRED edges are exactly the controller->service member calls (`this.articleService.create()`).

**Cross-file call resolution** (no type checker; name/import based):
1. Same-file and import-gated bare calls: the shared pass in `extract()` (extract.py ~L11800-11900) resolves `raw_calls` by callee name across the corpus; for JS/TS, a cross-file call is accepted only when the caller file imported the symbol (`#1659` gate, comment at L11823); member calls (`obj.f()`) are skipped in that pass to avoid name collisions.
2. Member calls through typed receivers: `_resolve_typescript_member_calls` (extract.py L5837). Uses constructor parameter-property types / class field types (`ts_type_table`, `_ts_fields`) to find a unique class owning the method, with an origin gate (the type must be defined in or imported by the caller). Emits EXTRACTED when the receiver is written as `Type.method()`, INFERRED when the type came from the field table.
3. File-level `imports`/`imports_from`/`re_exports`: `_resolve_cross_file_imports` (`extractors/resolution.py` L3330).
Not resolved: calls on untyped values, dynamic dispatch, route-registration style calls (Express `router.get(path, handler)` yields at most an `indirect_call`), anything needing the TS checker. Node dedup (`dedup.py`) skips AST-tier nodes (`dedup.py` L846-857 `_is_ast_tier`), so TS symbols are not fuzzy-merged.

**Clustering**: Louvain with `seed=42` (`cluster.py` L169-175) here; Leiden `seed=42` when the extra is installed. Cluster result is stable (see determinism).

## 4. Is an LLM needed for code-only?

No. Evidence: README "Code maps for free, fully local ... deterministic, no LLM" and "A code-only corpus requires no API key: `graphify extract` runs fully offline. On a mixed repo, add `--code-only`". In `cli.py` the `extract` branch parses `--code-only` (L4299) and, when set, skips doc/paper/image files before any backend is resolved (L4576-4585, and L4687 "A code-only corpus is pure local AST and must not require one"). I ran it with no API keys and `GRAPHIFY_BACKEND=none` (README: disables all LLM backends); it completed. The only LLM-using steps are semantic extraction of docs/PDFs/images, `graphify label` / `cluster-only` community naming, `--dedup-llm`, and `prs --triage`; the adapter uses none. I could not sandbox the network (`unshare -rn` is not permitted here), so "zero network traffic" is not independently verified beyond the source reading; README states no telemetry.

Headless CLI paths for a code folder:
- **`graphify extract <path> --code-only --out <dir>`** (used by the adapter): writes `<dir>/graphify-out/{graph.json, manifest.json, .graphify_analysis.json, .graphify_root, .graphify_build.json, cache/}`; nothing is written into `<path>` (checked: `git status` clean on the target repo, no `graphify-out/` there). It runs AST extraction -> build (with dedup) -> Louvain/Leiden clustering. It does not write GRAPH_REPORT.md/graph.html (that is `cluster-only`, whose community naming may call an LLM; not needed for querying).
- `graphify update <path>` ("no LLM needed"): writes `graphify-out/` INTO `<path>` (no `--out`) and also structurally extracts Markdown (README headings become nodes: 340 nodes/688 edges vs 328/677 for `extract --code-only` on the same Nest repo; diff = 12 README section nodes). I chose `extract --code-only` because it writes elsewhere and keeps docs out of a code-localisation index.
- Python API: `graphify.extract.extract(paths, root=...)` + `graphify.build.build()` + `graphify.cluster.cluster()` (ARCHITECTURE.md), not used.
- The `/graphify` Claude skill adds an LLM semantic pass for non-code files only.

Files honoured/skipped by default: `.gitignore` (and `.graphifyignore`), `node_modules`, "potentially sensitive" names (`.env` was skipped in the Nest repo), files with no supported extension. Test files (`*.spec.ts`) ARE indexed (and demoted at query time, below).

## 5. How `graphify query` works (source: `graphify/cli.py` L1984 -> `serve._query_graph_text`)

Flow (cli.py query branch, serve.py L1497 `_query_graph_text`, L1576 `_render_query`):
1. Load graph.json as an **undirected** `networkx.Graph` (CLI comment: query must explore callers and callees).
2. If the question is itself the exact name of several nodes -> refusal text (exit 3). 
3. **Seed selection is purely lexical, no embeddings, no LLM**: `_query_terms` (serve.py L318) lower-cases, tokenises `\w+`, keeps tokens longer than 2 chars, drops stopwords (`_QUERY_STOPWORDS`, includes how/what/why/does/work/get/etc. in English, German and Romance languages). `_score_query` (L618) scores every node: exact label match (x1000), prefix (x100), substring in label (x1), term in `source_file` path (x0.5), rationale/attribute hits (x0.75), full-query label match (x10000); each term weighted by IDF over the graph; exact/prefix tiers scaled by (matched terms / terms)^2; a node-level weight of 0.3 demotes tests (`*.spec.ts`, `test` paths), docs, config files and nodes without a source file (`_query_path_weight`, L582) unless the question mentions tests/docs. Ties: shorter label, then node id.
4. `_pick_seeds` (L836): walk the ranking, keep up to 3 seeds while score >= 20% of the top score and labels are distinct, then **add one guaranteed seed per distinct query term** that matches anything (best node for that term). So seed count can exceed 3 (we saw 3-6).
5. **Traversal**: BFS by default (`_bfs`, L1118), `--dfs` for DFS (`_dfs`, L1149); default **depth 2** on the CLI (`--depth 1-6`); `.graphifyrc` `query_depth`/`query_budget` can override (read from the project root recorded in `.graphify_root`, i.e. the target repo). Nodes with degree >= max(50, p99 degree) are not expanded as transit unless they are seeds. Note the MCP `query_graph` tool defaults to depth 3 (serve.py L2712), CLI to 2.
6. **Context-filter heuristic (important)**: `_resolve_context_filters` / `_infer_context_filters` (L1028-1048): if the question contains words like call(s)/invoke, import/module, field/member/property, parameter/argument, return(s), generic/template, the traversal graph is silently filtered to edges whose `context` matches (header shows `Context: return_type (heuristic)`). A bug report saying "returns 500" produced a 1-node answer on Express (`Context: return_type (heuristic)`, "1 nodes found"). The `--context` flag overrides but cannot disable the inference.
7. **Output** (`_subgraph_to_text`, L1176): header line `Graph: ... | Traversal: BFS depth=2 | Start: [seed labels] | [Context: ...] | N nodes found`, then (maybe) a `[!] TRUNCATED` / `[i] Complete answer over budget` banner, then one line per node `NODE <label> [src=<file> loc=L<n> community=<k>]`, then one line per edge `EDGE <src> --<relation> [<confidence> context=<ctx>]--> <dst> at=<file>:L<n>`.
8. **Ordering carries ranking, partially**: the `ordered` list is seeds first, then all other nodes sorted by (rank of the file by its best node score, -node score, hop distance from seeds, -degree, id) (L1230-1257). Nodes that matched the query lexically are grouped file-by-file, best file first; nodes reached only by traversal (score 0) come after every matched file, ordered by hop distance then degree. Scores are NOT printed in the text. NODE lines come before all EDGE lines, so the budget cut truncates the tail of the node list first (seeds are never cut).
9. **`--budget N`** (default 2000): a character budget of `N*3` ("approx 3 chars/token", `_subgraph_to_text` docstring and `char_budget = token_budget * 3`). The cut is made on the combined NODE+EDGE text at a line boundary; it is not a real tokenizer. If all nodes fit but edges do not, edges are kept and output exceeds the budget with an `[i] Complete answer over budget` notice (it can be 4-6x the budget, comment L1318-1330). For our metrics use our own tokenizer on `context`.
10. No LLM call anywhere on the query path. The query log is opt-in (`GRAPHIFY_QUERY_LOG*`), disabled by the adapter; the CLI also writes `graphify-out/cache/last_query_stamp` next to the graph (inside our out dir).
Exit codes: 0 answer, 3 ambiguous name, 4 no match (stdout "No matching nodes found.").

## 6. Other agent-facing interfaces

- `graphify path "A" "B"` (shortest path between two named nodes), `graphify explain "X"` (node + neighbours), `graphify affected "X"` (reverse traversal), `graphify god-nodes`, `graphify query --seed X` (start traversal at given node/file; intended for an external ranker). `path`/`explain` need node names, so they are not usable for localising from a free-text bug report.
- MCP server (`graphify-mcp`, `graphify/serve.py` `_build_server` L2630; tools L2704-2830): `query_graph` (question, mode bfs|dfs, depth default 3, token_budget default 2000, context_filter), `get_node`, `get_neighbors`, `get_community`, `god_nodes`, `graph_stats`, `shortest_path`, plus PR tools; resources report/stats/god-nodes. Not exercised by us.
- What an agent naturally uses for "localise this bug from a natural-language report": **`graphify query "<report>"`** (CLI, which is what the installed skill/CLAUDE.md hook steer toward: "preferring scoped queries like `graphify query`"), equivalently MCP `query_graph`. That is what the adapter wraps.

## 7. Adapter

File: `ROOT/src/competitors/py/graphify_adapter.py` (run with `ROOT/vendor/.venvs/graphify/bin/python`).

```bash
P=ROOT/vendor/.venvs/graphify/bin/python
A=ROOT/src/competitors/py/graphify_adapter.py
$P $A build --repo /abs/ts/repo --out /abs/out/dir
$P $A query --graph /abs/out/dir --repo /abs/ts/repo --queries in.jsonl --out out.jsonl \
            [--budget N] [--depth N] [--mode bfs|dfs] [--context C]   # defaults = Graphify CLI defaults: bfs, depth 2, budget 2000, no --context
```
- `build`: deletes `<out>/graphify-out` if present (forces a cold, non-incremental build), runs `python -m graphify extract <repo> --code-only --out <out>` with env `GRAPHIFY_NO_AUTO_REFRESH=1 GRAPHIFY_QUERY_LOG_DISABLE=1 GRAPHIFY_BACKEND=none`, saves the full log to `<out>/graphify_build.log`, prints one JSON line (`build_ms` = wall time of the subprocess, `nodes`, `edges`, `graphify_version`, `commit`, `notes`, plus `graph_json`, `node_file_types`, `edge_relations`, `edge_confidence`). Refuses `--out` inside the repo. Repo is never written (verified via `git status`).
- `query`: for every input line it (a) runs the real `graphify query` CLI as a subprocess and stores its stdout verbatim in `context` (latency_ms = that subprocess wall time, so it includes ~150 ms Python startup, as an agent's Bash call would); (b) in-process, loads the graph with the same loader as the CLI and calls Graphify's own `_query_graph_text` with a pass-through hook on `serve._subgraph_to_text` that only records the node set, seeds and score dict; no behaviour is altered. `metadata.inprocess_matches_cli` records whether both texts (minus the header that embeds the graph path) are identical (true in every run so far). `results` = the `NODE` lines of the CLI output in printed order, each mapped to its graph node via (label, src, loc); `score` = Graphify's internal lexical score for that node (0.0 for nodes reached by traversal only; never printed in the context; `null` only if no score dict exists); `start_line` = parsed from `L<n>`; **`end_line` is always null** (Graphify stores only a start line); `file` = repo-relative posix `source_file`, null for import stubs. `node_type` is adapter-derived from Graphify attributes: file / class / method / function / dependency (package.json) / external (no file) / type_or_variable (interfaces, enums, type aliases, consts are not distinguished by Graphify; `_callable_class` marks classes). `symbol` = label with leading `.` and trailing `()` stripped, null for file/external/dependency nodes.
- Metadata also carries: exit_code, mode, depth, budget, truncated, nodes_found_reported (the "N nodes found" in the header, which can exceed nodes shown when the budget truncates), nodes_shown, start_labels_header, seed_ids, context_chars, ambiguous_node_keys, inprocess_latency_ms.
- Ambiguity caveat: import-stub nodes (`Get`, `Injectable`, ... with empty src/loc) are textually identical across files, so their `raw_id` is assigned in graph order among the matching candidates and may be swapped with a sibling; they have `file=null` so this does not affect file-level scoring (`ambiguous_node_keys` counts them).
- `llm_tokens` is always null (no LLM).

## 8. Test run (scratch, `/tmp/.../scratchpad`)

Repos: `lujakob/nestjs-realworld-example-app` (HEAD c1c2cc4e, 41 code files indexed) and `gothinkster/node-express-realworld-example-app`.
- Nest: 328 nodes, 677 edges, 20 communities; cold build about 0.6 s. Express: 333 nodes, 503 edges, build about 0.6 s.
- Queries (Nest): "Login fails when the user's email has uppercase letters; password hash comparison seems wrong" -> seeds `User`(decorator const in user.decorator.ts!), `LoginUserDto`, `login-user.dto.ts`, `.login()`, `.hashPassword()`, `.findByEmail()`, 120 nodes found, 88 shown at budget 2000. "A user can favorite the same article twice ..." -> seeds `User`, `.favorite()`, `article.service.ts`. "JWT token validation in the auth middleware returns 401 ..." -> 5 nodes only. Gibberish query -> "No matching nodes found.", exit 4, empty results. Output JSON validated: exactly the 7 contract keys; no unresolved ids.
- Express: "Creating an article with duplicate title returns 500 ..." -> 1 node (heuristic `return_type` context filter); "password is stored in plain text ..." -> seed `outExtension` from `project.json` (substring "text" in "outExtension").
- DFS and `--budget 800`, `--budget 500` (truncation banner, 21 of 120 nodes), `--context call --depth 1` all ran and matched the in-process text.
- **Determinism**: two cold builds -> identical node/edge counts and a byte-identical `graph.json` (md5 equal). Three cold builds under `PYTHONHASHSEED=1,2,3` -> identical md5 (`57fd4d20...`). Same queries run twice, and under three different hash seeds -> identical `context` and `results`. Reason: seeds 42 in clustering; sorted tie-breaks in ranking and rendering. (Single machine, single platform; I did not test across machines/Python versions or with the `leiden` extra, whose partitions Graphify itself says reshuffle relative to Louvain.)

## 9. Token usage

- Graphify's own number: `--budget N` caps the node/edge text at about 3*N characters (not a tokenizer), with the exceptions in section 5.9. Useful as a cap, not as a measurement.
- Recommended for the benchmark: run our tokenizer over `context` (exactly what the agent reads, including the header and truncation banners) and record `metadata.context_chars`. Graph build costs 0 LLM tokens. Because the budget is char-based and edges may overflow it, token cost varies; budget should be reported as a configuration, not assumed as the actual cost.

## 10. Limitations and fairness caveats

1. **Lexical, label-only retrieval.** Seeds come from substring/prefix/exact matching of query tokens against node labels and file paths (plus IDF). No semantics, no embeddings, no body text: identifiers that never appear in a bug report's wording are unreachable except by graph traversal (depth 2). Bug reports in prose ("returns 500", "plain text") mostly hit generic words; examples: seed `User` decorator, `outExtension` (via "text").
2. **Heuristic edge filtering by question words** (call/import/field/parameter/return/generic...) can collapse the answer to a tiny subgraph. It is part of Graphify's default behaviour; the adapter does not disable it. Consider reporting results with and without (`--context` cannot turn it off; only an explicit other filter overrides it).
3. **Node granularity**: file, class/interface/enum/type, function/method (including `.constructor()`), import/decorator stubs, package.json deps. No statement/line-level nodes; start line only, no end line, so line-range metrics need the file's symbol extents from elsewhere. Variables/consts are folded into other nodes or dropped; interface vs class not marked.
4. **Output size and ranking**: the answer is a subgraph (often 50-150 nodes), not a ranked list. Only the order carries signal: seeds, then matched files by best score, then traversal-only nodes by hop/degree. Many returned nodes are traversal filler (all methods of a seeded class and file). Any top-k metric over `results` is therefore sensitive to the 3-chars-per-token truncation and to depth. Report `nodes_found_reported` vs `nodes_shown`.
5. **Noise nodes**: README/config-like files are not in `--code-only` but `package.json`, `tsconfig*.json`, `project.json` still are; tests are indexed (demoted x0.3 when the question does not mention tests).
6. **Cross-file calls are name/import-based**: controller->service member calls come only via constructor-injected types and are INFERRED; route wiring, dynamic dispatch and untyped receivers are missed.
7. **Settings in the target repo can change behaviour**: `.graphifyrc` in the repo (`query_budget`, `query_depth`, `language.*`) is read via `.graphify_root`; `.gitignore`/`.graphifyignore` shape the corpus; "potentially sensitive" files (`.env`) are skipped silently.
8. **Defaults differ between surfaces**: CLI depth 2, MCP `query_graph` depth 3. The adapter reproduces the CLI.
9. **Latency** in the adapter = CLI subprocess wall time (about 160-180 ms, mostly interpreter+networkx import); the in-process query time is recorded in metadata for comparison with long-lived-server style methods.
10. Graphify is under rapid change (0.9.x releases roughly daily); the pin matters. Graphify auto-refreshes installed skills unless `GRAPHIFY_NO_AUTO_REFRESH=1`.

## 11. Not verified

- The upstream test suite (`pytest tests/`) was not run.
- Network isolation during build/query (sandbox `unshare` unavailable); no API keys were set, so any LLM call would have failed, and none occurred.
- MCP server behaviour (not started); `path`, `explain`, `affected` were not run.
- Behaviour on large repos (> 5k nodes, e.g. `viz_node_limit`, hub threshold), and on real bug-report-length texts at scale; only two small repos and 6 queries were tested.
- Cross-machine determinism, and determinism with the `leiden` extra.
- Whether Express route handlers are linked at all beyond one `indirect_call` (looked at edges only, not exhaustively).
