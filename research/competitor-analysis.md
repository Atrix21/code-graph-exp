# Competitor analysis: Graphify and Code Review Graph

Both tools were cloned into `vendor/`, pinned, installed into isolated venvs and run **unmodified** through thin adapters (`src/competitors/py/*.py`). The adapters only shell out, normalise paths and line numbers, and preserve each tool's native ordering. Full investigation notes, with source citations: `research/notes/graphify.md` and `research/notes/code-review-graph.md`. The lead spot-checked the key claims against the pinned source (see the end of this document).

## Identity and pins

| | Graphify | Code Review Graph (CRG) |
|---|---|---|
| Upstream | https://github.com/Graphify-Labs/graphify (`safishamsi/graphify` 301-redirects here; PyPI `graphifyy` points here) | https://github.com/tirth8205/code-review-graph (PyPI `code-review-graph`) |
| Pinned | tag v0.9.104, `433a57a002908e74c9f0abd2ad93af8b302b71c4` (2026-11-07, latest PyPI) | tag v2.3.9, `343ab7cea29d47a3e805381e09f8243a43d43d88` (2026-09-18, latest PyPI) |
| Licence | Apache-2.0 | MIT |
| Install | `uv venv vendor/.venvs/graphify && uv pip install -e vendor/graphify[mcp]` | `uv venv vendor/.venvs/code-review-graph && uv pip install vendor/code-review-graph[embeddings,communities]` |
| Needs an LLM? | No, for code (`extract --code-only`: tree-sitter only). Docs/papers/images go through Claude subagents in the skill; not used here | No. Build, FTS5 search, optional local embeddings and graph queries are all local |

## What each tool does

**Graphify** turns any folder into a knowledge graph (code via tree-sitter; docs, papers and media via an LLM) with community detection, an audit trail (EXTRACTED/INFERRED/AMBIGUOUS), an interactive HTML view and a `GRAPH_REPORT.md`. Agents query it through the `graphify query` CLI or an MCP `query_graph` tool.

**CRG** is a local-first structural graph for *code review*. It is built with tree-sitter into SQLite, updated incrementally from git diffs, and serves compact context (impact radius, review context, callers/callees, flows, communities) to AI coding tools over 30 MCP tools.

## Graph construction (TypeScript)

| | Graphify | CRG |
|---|---|---|
| Parser | tree-sitter-typescript 0.23.2, generic walker (`extractors/engine.py`) | tree-sitter via `tree_sitter_language_pack` (`parser.py`) |
| Nodes | file, class/interface/enum/type alias (not distinguished), function/method/constructor, import stubs, `package.json` deps | File, Class (also interfaces, type aliases, enums), Function (incl. inner arrow functions), Test |
| Edges | contains, method, calls, indirect_call, imports, imports_from, re_exports, references (decorator/field/param/generic/return), inherits/implements | CALLS, IMPORTS_FROM, INHERITS (extends and implements), CONTAINS, REFERENCES, TESTED_BY |
| Call resolution | name- and import-gated; member calls via constructor-injected field types (INFERRED); no type checker | same-file and imported names; TS parameter properties give receiver types; post-pass binds bare names with single-import evidence; ~82% of CALLS stay bare names on a test repo |
| Line info | start line only (`L<n>`), **no end line** | start and end lines |
| Missing (both) | control flow, data flow, DI provider bindings → concrete implementations, framework routes, DB entities, config keys | same |

## Retrieval mechanism and how an agent queries it

**Graphify**: `graphify query "<question>"` lexically scores every node label/path against the question terms (exact ×1000 / prefix ×100 / substring ×1, IDF-weighted, tests ×0.3). It picks ≤ 3 seeds within 20% of the top score, plus one per matched query term, then BFS at depth 2 (CLI default; MCP default 3). Output is a text subgraph (`NODE …` then `EDGE …` lines), truncated at `--budget × 3` characters, ordered by seeds, then matched files by score, then traversal-only nodes. Question words such as "returns", "call" and "field" silently activate edge-context filters.

**CRG**: there is no single "natural-language report → code" tool. Its own `debug_issue` prompt (verified in `prompts.py`) is `semantic_search_nodes(keywords)`, then `query_graph(callers_of)` on the top 1–2 hits. Search is FTS5/BM25 over **names, qualified names, paths, signatures and docstrings, not bodies**; it tries all terms ANDed and falls back to OR. Optional local embeddings (all-MiniLM-L6-v2) switch it to hybrid RRF.

## How we integrated them

| | Primary configuration | Secondary variants (reported separately) |
|---|---|---|
| Graphify | `extract --code-only` + `graphify query <bug report> --budget 8000` (= shared budget), BFS depth 2 (CLI default) | default budget 2000; depth 3 (MCP default) |
| CRG | full build (`build_or_update_graph(full_rebuild=True)`), policy `search_expand` = `semantic_search_nodes(report, limit=20)` → `callers_of` + `callees_of` on the top-2 callable hits | `search_only`; with CRG's optional embeddings |

Both receive exactly the bug report text and the same snapshot as every other method. CRG is run on a byte-identical clone at a neutral path (`/tmp/cgbench/w`), because it full-text-indexes absolute paths. Graphify's budget is character-based, and its own output can exceed it. CRG has no budget parameter, so native tokens are reported as measured.

## Limitations and compromises (affecting fairness)

1. **No agent in the loop.** Both tools are designed for an LLM agent that chooses keywords and follow-up calls. We pass the raw bug report, because none of the seven methods uses an LLM. This is the biggest compromise, and it disadvantages both tools more than embeddings/BM25 (CRG's AND-of-12-longest-terms query and Graphify's label matching expect identifiers). A downstream agent experiment would be needed to measure them as intended.
2. **Granularity.** Neither tool can return class properties (one held-out root cause is a decorated property, `FileType.path`). Graphify has no end lines, so its node→symbol mapping relies on names.
3. **Noise.** Both index `package.json`/`tsconfig.json`; those hits occupy rank slots under our harness (as they would for an agent).
4. **Ordering.** Graphify returns a subgraph, not a ranked list; we use its printed order, which is meaningful only for seeds and lexically matched files.
5. **Rapid churn.** Both projects release weekly or daily; results hold only for the pinned versions.

## Side effects encountered (and fixed)

- The first run of the pinned Graphify CLI auto-refreshed the user's global Claude skill (`~/.claude/skills/graphify`, 0.9.63 → 0.9.104). It was restored byte-for-byte from the installed 0.9.63 package. Adapters now set `GRAPHIFY_NO_AUTO_REFRESH=1`.
- CRG creates `~/.code-review-graph/` on first use. The adapter redirects `CRG_HOME`/`CRG_DATA_DIR` into the output dir; the empty directory created during investigation was removed.

## Lead verification of key claims

- Graphify's adapter runs `python -m graphify query <q> --graph … --budget N` as a subprocess (adapter L258), and Graphify computes `char_budget = token_budget * 3` (`serve.py` L1185, L1400). Seed selection is `_pick_seeds` (`serve.py` L836).
- CRG's `debug_issue_prompt` (`prompts.py` L92–113) prescribes search → `callers_of` on the top 1–2 results. The adapter calls the same `code_review_graph.tools.query` functions the MCP tools wrap.
- Both vendor working trees are clean at the pinned commits (`git status` empty; `rev-parse` matches the manifest).
