# Methodology

Status: **frozen before comparative runs on the held-out split** (changes after that point are logged in `research/decision-log.md` with justification).

## 1. Research question

Can a structurally and behaviourally richer code graph help an AI coding agent **localise** the code relevant to a natural-language bug report more accurately, while consuming fewer tokens, than existing retrieval approaches? This benchmark measures localisation only, not bug fixing.

## 2. Codebase

| Item | Value |
|---|---|
| Repository | `brocoders/nestjs-boilerplate` (MIT), https://github.com/brocoders/nestjs-boilerplate |
| Upstream commit | `9620f159eefe38f47747d02ab162852367c5472c` (2026-08-08) |
| Language / framework | TypeScript 5.9.3, NestJS 11, TypeORM + Mongoose (dual persistence), JWT/Passport, AWS S3, nodemailer, Google/Facebook/Apple OAuth |
| Benchmark snapshot | upstream + 20 injected bug patches, only `src/`, `test/` and minimal project config kept; committed with fixed author/date so the hash is reproducible (see `targets/bench.manifest.json`) |
| Corpus | every `*.ts` (not `.d.ts`) under `src/` and `test/`: 170 files |

Why this repo: it was ranked first of 10 candidates by measured reconnaissance (see `research/decision-log.md` D-003). It has real controller → service → repository layering with NestJS DI, abstract repositories with two concrete implementations (realistic distractors), external API integrations, branching auth/session logic, state mutation, exceptions and e2e tests. It is small enough to label by hand (~8.8k TS lines).

Equal source availability: all seven methods index the **same snapshot directory** (or a byte-identical clone at a neutral path for Code Review Graph, which stores absolute paths in its full-text index). Docs, CI files, scripts and generators are removed from the snapshot so no method gets extra (or LLM-only) inputs. The target's npm dependencies are installed *outside* the snapshot (`targets/node_modules`), so they are visible to the TypeScript type checker (module resolution walks up) but are not crawled by any indexer.

## 3. Ground truth

- **Construction (Agent A, Sonnet)**: 20 realistic bugs injected as minimal mutations (1–6 lines, no hint comments, each in a distinct function, all type-check together). Each has a symptom-level bug report written from a user/QA/on-call perspective, with deliberately varied lexical overlap (high / medium / low) and call distance from the symptom's natural entry point to the root cause (15/20 have ≥ 1 hop). Labels: root-cause symbol(s), relevant symbols (route → root-cause path + directly involved callees), relevant files, expected relationships, data/control-flow facts, distractors.
- **Independence**: ground truth was produced only by reading source code (no Graphify, CRG, our graph, embeddings, or retrieval outputs). Retrieval implementers never edit labels.
- **Audit (Agent B, Sonnet)**: independent audit of every task (bug reality, root cause, relevant set completeness/minimality, report leakage, overlap label, distractors, cross-task interference) without access to retrieval results. The lead adjudicated proposals before any held-out results existed (`evaluation/dataset/ADJUDICATION.md`).
- **Freeze**: dataset version and SHA-256 of every task/patch recorded in `evaluation/dataset/FROZEN.json` before comparative runs.
- **Symbol keys**: `<file>::<QualifiedName>` from a purely syntactic declaration index (`src/evaluation/symbol-index.ts`, `ts.createSourceFile`, no type checker, no relationships), deliberately independent of our graph builder.

## 4. Splits

Seeded (20261108), stratified by lexical overlap: 2 tasks per stratum → **6 dev**, **14 test** (`scripts/assign-splits.ts`). All development, debugging and parameter tuning use dev only. The final configuration is frozen before the test split is evaluated; test is then run once per frozen configuration. Ablations are reported on test with the frozen configuration (no re-tuning).

## 5. Methods (common interface `src/types.ts`)

All methods receive only `{task_id, query}` (the bug report), the same corpus and the same budget `{maxResults: 50, maxContextTokens: 8000}`. Each returns a ranked list of locations and its *native context* (the exact text an agent would read). No method uses an LLM at index or query time.

| | Method | Implementation |
|---|---|---|
| A | ripgrep | real `rg` 15.0.0 (pinned via `@vscode/ripgrep`); stopword-filtered, stemmed keywords + identifier-like terms (boosted), hits merged into ±3-line clusters, ranked by IDF-weighted distinct-term count |
| B | BM25 | Okapi BM25 (k1 = 1.2, b = 0.75) over declaration-level chunks (functions, methods, class headers, module code); camelCase-splitting, stemming tokenizer |
| C | Embeddings | `Qwen/Qwen3-Embedding-0.6B` @ `97b0c614`, sentence-transformers 5.1.2, fp16 CUDA, last-token pooling, max 1024 tokens, fixed query instruction; same chunks as BM25 |
| D | Graphify | real Graphify v0.9.104 (`433a57a0`), `extract --code-only` (tree-sitter), `graphify query` CLI, BFS depth 2 (CLI default), `--budget 8000` (= shared budget) |
| E | Code Review Graph | real CRG v2.3.9 (`343ab7ce`), full build, `search_expand` policy = `semantic_search_nodes(report)` → `callers_of`/`callees_of` of top-2 callable hits, mirroring CRG's own `debug_issue` prompt; FTS (default, no embeddings) |
| F | custom_graph | our TS-compiler-API graph; seeds from typed graph fact documents; typed, confidence-weighted propagation |
| G | hybrid | exact symbol + BM25 + embeddings + graph facts → seeds → graph propagation; weights configurable |

Secondary competitor variants (Graphify default budget 2000, Graphify depth 3 = MCP default, CRG search-only, CRG with its optional embeddings) are reported separately and never replace the primary configuration.

## 6. Normalisation (identical for every method)

Each returned location is mapped to a canonical symbol by (1) resolving the reported symbol name inside the reported file, else (2) choosing the declaration with the highest line-range Jaccard overlap (single lines map to the innermost enclosing declaration; class-sized ranges map to the class), else (3) file-level only. Duplicates collapse to the first (best) rank. Files outside the corpus (e.g. `package.json`) are unresolved and ignored for symbol metrics.

## 7. Metrics

Symbol level (relevant set = `relevant_symbols`, root cause = `root_cause_symbols`): Recall@5/10, Precision@5/10 (denominator k), root-cause Acc@1/5/10, root-cause MRR (first root-cause rank within ≤ 50 returned symbols). File level: Recall@5/10, root-cause-file Acc@1/5, MRR. Means with seeded bootstrap 95% CIs (5000 resamples); paired bootstrap for method differences.

**Token accounting.** No Anthropic API key is available, so token counts use the `o200k_base` BPE (js-tiktoken) as a proxy tokenizer, applied identically to everything.

1. *Indexing tokens*: LLM tokens at index time (0 for every method here); embedding-model tokens at index time (embeddings and hybrid only), reported separately as a one-time cost.
2. *Retrieval-time LLM tokens*: 0 for every method (none calls an LLM). Query-embedding tokens are recorded in metadata.
3. *Native context tokens*: proxy tokens of the exact text each method returns. Graphify's `--budget` is character-based (≈ 3 chars/token) and can be exceeded by its own output; CRG has no budget parameter; both are reported as measured.
4. *Uniform-rendering tokens*: to compare ranking quality in token terms independently of output formatting, each ranked canonical symbol is rendered the same way (its source span, capped at 80 lines). From this: **tokens-to-root-cause** (tokens an agent reads in rank order until the root cause), **Recall@{1k, 2k, 4k, 8k} tokens**, and **Recall@10 per 1k tokens**.

Accuracy per 1k tokens = Recall@10 ÷ (uniform tokens of the top-10 / 1000), and native recall ÷ (native tokens / 1000). Ratios reward returning little; read them together with absolute recall.

## 8. Ablations (hybrid, frozen config, test split)

1. all components; 2. graph traversal off (wGraph = 0); 3. control-flow edges/facts off; 4. data-flow edges/facts off; 5. structural edges off; 6. semantic off (wSem = 0); 7. lexical off (BM25, exact-symbol and graph-fact lexical signals = 0); 8. confidence weighting off (all edge confidences = 1). Also application-level edges off, traversal depth 1/2/3, budget, number of seeds, number of returned snippets, and relationship-weight perturbation.

## 9. Threats to validity

- 20 tasks (14 held-out) from one repository: CIs are wide; results do not generalise across codebases or languages without replication.
- Injected bugs are realistic mutations but not historical bugs; bug reports were written by an LLM agent with knowledge of the bug (mitigated by the leakage audit and overlap stratification).
- Deterministic query handling stands in for an agent: ripgrep keywords and CRG/Graphify inputs are the raw bug report; a real LLM agent would rewrite queries. This disadvantages tools designed around agent-chosen keywords (CRG, Graphify) more than embedding/BM25 methods.
- The lead designed both our method and the harness; to limit bias the evaluation code is independent of the graph code, competitors run unmodified, the dataset and its audit were produced by separate agents, and tuning used dev only.
- Proxy tokenizer (not Claude's) — relative comparisons are meaningful, absolute numbers are approximate.
