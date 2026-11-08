# Evaluation harness review (Agent C)

Scope: `src/evaluation/*`, `src/types.ts`, baselines (`ripgrep, bm25, embeddings, chunker, text`), competitor wrappers (TS + py adapters for output fields). No `src` file was modified.

Verification legend: **[run]** = executed code (unit test in `tests/evaluation/` or a scratch probe over the real snapshot `targets/bench`, 170 files); **[read]** = code reading only; **[smoke]** = inspected `evaluation/results/smoke/` raw output.

Disclosure: while looking for the JSON schema I printed the head of `evaluation/dataset/AUTHORING.md`, which contains the per-task root-cause table. I did not open any `tasks/*.json`. One finding (M1) uses the fact, visible there, that one root cause is a class property; the property statistics themselves come from the snapshot, not the dataset.

Test results: `npx vitest run tests/evaluation` gives 58 passed, 0 failed. Three of them are `it.fails` (genuine bugs C2, M2, M3 below); several `DOCUMENTS:` tests pin current behaviour that I consider questionable.

---

## Critical

### C1. Result lists are not capped at `maxResults`; ranking metrics and token-per-result metrics see different list lengths per method
`src/competitors/graphify-adapter.ts:35-39`, `src/competitors/code-review-graph-adapter.ts:49-53`, `src/evaluation/metrics.ts:364-383`, `src/evaluation/report-generator.ts:104-118`.
Baselines (rg/BM25/embeddings) truncate their `results` to what fits in 8000 tokens and 50 items. Graphify and CRG return every node they print. [smoke] Graphify task smoke_02: 189 results, native context 26,240 tokens (budget 8000), root cause at rank 18; CRG returns 20 search hits plus unbounded callers/callees. Methodology §7 says "first root-cause rank within <= 50 returned symbols", but nothing enforces it [run: `it.fails` "BUG: methodology §7 ..."; a root cause at rank 55 gives rank=55, MRR=1/55].
Effect on conclusions: `rc_found_rate`, `ttr_median_found` (conditional on found), `ttr_mean_capped`, `sym_recall_all`, `native_recall_per_1k_native`, and Recall@{2k,4k,8k} credit Graphify/CRG for hits at rank 50-200 that baselines and (if it truncates) our method cannot get. Acc@k and Recall@k (k<=10) are unaffected, so the headline is safe, but every "found anywhere"/token-curve metric is biased towards competitors with large outputs.
Fix: after `normaliseOutput`, truncate `rankedSymbols` to `budget.maxResults` (or to the prefix whose native text fits `maxContextTokens`) before computing any metric; report "over-budget" separately for Graphify (it is a documented exception, so give it a second, truncated row).

### C2. BM25/embedding `<module>` chunks are credited to unrelated declarations
`src/retrieval/bm25.ts:203-205` + `src/evaluation/normalise.ts:215-231` + `src/retrieval/chunker.ts:274-275`.
A module chunk consists of the non-contiguous uncovered lines (imports ... stray top-level statements) and `chunkToItem` reports `symbol: null, start_line: first, end_line: last`. Jaccard then maps `1..N` to whatever declaration overlaps most. [run, snapshot probe] 26 of 145 module chunks mis-map, e.g. `src/config/app.config.ts` 1-82 -> `EnvironmentVariablesValidator`, `src/app.module.ts` 1-43 -> `infrastructureDatabaseModule`, `run-seed.ts` 1-15 -> `runSeed` [run: `it.fails` "BUG: a BM25/embedding <module> chunk ..."].
Direction: a hit on an import-block chunk is turned into a (possibly relevant) declaration (false credit) or, more often, into a wrong declaration that pushes down real hits (false penalty), i.e. noise in both directions, only for BM25 and embeddings.
Fix: for chunks with `kind === 'module'` emit `symbol: '<module>'` and make `resolveName` accept `<module>` (today `normaliseName` turns `<module>` into `''`, [run]); or give items a `symbol_key` hint.

---

## Major

### M1. Chunk baselines cannot return property-level (or interface-member) symbols; GT keys include them
`src/retrieval/chunker.ts:257, 263` (skips `property`, interface members), `src/evaluation/symbol-index.ts:76-80`.
[run, snapshot] 272 of the corpus' symbols are `property`; none has its own chunk (a chunk's `symbol` is the class). Hence BM25/embeddings can never score a root-cause or relevant symbol that is a property, while rg (line -> innermost symbol), Graphify (name) and CRG can. Per AUTHORING.md at least one root cause (`FileType.path`, a decorated property) is of this kind, so BM25/embeddings have a hard ceiling of 19/20 root-cause hits on the dataset regardless of retrieval quality. The same applies to relevant sets containing DTO properties. Also depresses Recall@k for those methods.
Fix (either): emit one chunk per property (cheap), or credit a class-header chunk hit to member properties whose lines are inside the chunk's `lineNumbers`, or list property symbols in GT only as their enclosing class. At minimum, report per-method "max achievable recall" given chunk granularity.

### M2. File-level nodes are credited to a declaration instead of file-only
`src/evaluation/normalise.ts:241-246` vs rule 4.
CRG `File` nodes carry `line_start=1,line_end=N` [smoke: `{'node_type':'File','start_line':1,'end_line':64}`] and map to the biggest class in the file (Jaccard .8); Graphify file nodes (`L1`, no end) map to whichever declaration starts on line 1, else `<module>` [run: `it.fails` "BUG: a whole-file range..." and the DOCUMENTS test; snapshot probe: `files.controller.ts` -> `FilesLocalController` (CRG-style) vs `<module>` (Graphify-style); `file-config.type.ts` -> `FileConfig` vs `FileDriver`]. So the same semantic hit (a file node) yields different symbol keys per method, consumes a top-k slot as a symbol, and is charged 80 lines in uniform rendering. Direction: usually penalises CRG/Graphify slightly (slot wasted) but can award a class credit when the class is in the relevant set.
Fix: use `node_type`/`raw_id` to decide, or treat any range covering >= ~90% of a file, or `start_line==1` with no symbol and node_type `file|File`, as file-only.

### M3 (borderline major). Unresolved items are silently removed before ranking, and `.filter(r => r.file)` drops more earlier
`src/evaluation/normalise.ts:257-258`, `src/competitors/py-adapter.ts:519`.
Graphify and CRG index `package.json`, `tsconfig.json`, and external stubs (not corpus files); [smoke] Graphify smoke_02 had 26 of 189 results unresolved, smoke_01 had `tsconfig.json::outDir` in a 9-item list. Those never take a rank slot, so competitors get free "noise removal" that a baseline (which only searches corpus files) never needed [run: DOCUMENTS test, 3rd native result becomes rank 1]. External/no-file nodes (decorators, `AfterLoad`) are dropped even earlier and not counted in `n_unresolved`.
Fix: count unresolved items as rank-consuming misses (they are output the agent has to read), and count dropped no-file items in `n_unresolved`. Also note the corpus asymmetry itself (Graphify/CRG index extra non-corpus files kept in the snapshot: package.json, tsconfig*, nest-cli.json); either index only `corpus.files` or accept and penalise as above.

### M4. "Native" token metrics are not comparable across methods (different information content)
`src/evaluation/runner.ts:46`, `report-generator.ts:119-123`.
Graphify context is `NODE label [src= loc=]` lines plus edges, CRG context is JSON metadata (names, line ranges, signatures), rg shows only matched lines, BM25/embeddings show up to 80 lines of source per chunk [smoke: Graphify 271 tokens for 9 hits; BM25 7,379 for 29]. `native_recall_per_1k_native` is therefore ~10-30x higher for location-only tools simply because the agent would still have to open the code. Native tokens ignore that follow-up read. The uniform-rendering metrics (tokens-to-root-cause, Recall@budget) are the fair ones; make them the headline and label native numbers "as-emitted, not information-equivalent". Also `native_recall_per_1k_native` uses `sym_recall_all` (see C1), so it multiplies the uncapped-list bias by the information-content bias.

### M5. `ttr_median_found` and the ratio metrics are conditional/ratio-of-means
`report-generator.ts:104,118,122`.
Median over found-only rewards methods that find only easy tasks (low n, low cost). `r10_per_1k_uniform = mean(R@10) / mean(uniform top-10 tokens)`: a method returning < 10 symbols (or many cheap `<module>` hits, ~7 lines each) has a smaller denominator. Report the capped mean (already there) as primary, show n found next to the median, and give per-task ratio CIs.

---

## Minor

- m1. Paired test is one-sided and anchored to "our" method: `pairedBootstrap` returns P(diff <= 0) with ties counted as <= 0 (identical samples give P=1 [run]); `report.ts:195` picks the reference as `hybrid_all|hybrid|custom_graph`. Report two-sided CI/p and apply a multiplicity correction (7 methods x 14+ metrics, n = 14 tasks; percentile bootstrap on 14 binary outcomes is anti-conservative; consider exact sign/Wilcoxon or permutation test). CI (`seed`) and P (`seed+1`) use different resample streams (`metrics.ts:454-456`); harmless but unusual. `pairedTable` aligns by task_id but `byTask.get(...)!` gives `undefined -> NaN` silently if a method lacks a task (`report-generator.ts:157`).
- m2. Bootstrap CI percentile indices (`floor(.025*5000)=125`, `floor(.975*5000)-1=4874`) are correct and CIs behave as expected (width ~0.098 for n=400, p=.5; constant sample degenerate; seed-deterministic) [run]. mulberry32 is correct and in [0,1) [run].
- m3. Name resolution ignores the class qualifier when the last segment is unique in the file (`symbol-index.ts:148-150`): `Other.only` resolves to `A.only` [run, DOCUMENTS test]. Generous to any method that reports a wrong qualifier; unlikely with these tools but easy to tighten (require qualifier match when the reported name is qualified).
- m4. Jaccard prefers the smaller symbol: an rg cluster covering the closing line of a large method and the start of a small neighbour is credited to the neighbour only (`normalise.ts:225`) [run]. Multi-hit clusters credit one symbol only; rg is slightly under-credited relative to a "credit all overlapped symbols" rule. Consider mapping each hit line (the cluster stores them) separately, which is also how an agent would read them.
- m5. `renderCache` in `metrics.ts:315` is keyed by symbol key only and is global; stale across different `SymbolIndex` instances (tests, or a second snapshot in one process). Key it by index identity/commit.
- m6. Uniform rendering caps at 80 lines: a root cause located beyond line 80 of a long symbol counts as "reached"; a class-header chunk hit (header only for BM25) is charged for the first 80 lines of the whole class. Both small and uniform across methods.
- m7. `precision@k` divides by k even when fewer than k results exist or when |relevant| < k (max P@10 is |rel|/10). Identical across methods; just state it in the report. BM25/embedding lists can be shorter than 10 when chunks are large because results are cut to what fits in 8000 tokens (smoke: 29 results for BM25), unlike Graphify/CRG.
- m8. File-key edge cases in `symbol-index.ts`: get/set pairs and overloads merge to the widest span (can swallow members between them); `file.endsWith('x')` for TSX detection; top-level code inside `describe(...)` in e2e tests collapses everything into `<module>`, so all CRG `Test` nodes (they were 4 of CRG's top 10 in smoke_02, symbol names like `it:should ...@L239`) collapse to `<module>` keys [smoke].
- m9. Latency is not comparable: Graphify's figure includes a Python process start per query (`graphify_adapter.py:267-269`), CRG excludes model/import warm-up (`crg_adapter.py:427-431`), embeddings exclude/amortise query embedding, ours is in-process. Do not publish latency as a ranking dimension.
- m10. Index vs query cost separation is correct in structure (`IndexStats` vs per-query `native_context_tokens`; `index_llm_tokens` 0 everywhere). Caveats: embeddings `index_ms` is ~0 on cache hits (`embeddings.ts:104`), `embedding_tokens` is null for `code_review_graph_emb` (`code-review-graph-adapter.ts:420`), and query-embedding tokens are only in metadata.
- m11. CRG `search_expand` appends caller/callee expansions after 20 search hits, so Acc@10/Recall@10 can never reflect the expansion step (it only appears in uncapped metrics, see C1). Fine as "CRG as shipped", but the expansion's value is invisible at k<=10.
- m12. Token proxy: o200k_base for all (consistent). `countTokens` is applied to the exact `context` string for every method; no hidden truncation difference except rg lines truncated to 200 chars and BM25/embedding chunk rendering at 80 lines (both inside the measured text).

## Fairness of baselines and wrappers (read; limited run)

- BM25: standard Okapi (k1 1.2, b .75), identifier splitting, stemming, compound tokens, path+symbol header indexed, class-header chunk with member code removed. Reasonable, not a strawman. Caveat: query term frequency multiplies (`qf * idf`), normal for BM25 on long queries.
- Embeddings: Qwen3-Embedding-0.6B, correct instruction on queries only, last-token pooling asserted, normalised vectors, 1024 max tokens (chunks up to 150 lines may be truncated by the model, as they would for anyone). Same chunks as BM25 so M1/C2 hit them equally.
- ripgrep: stem substring patterns (>= 4 chars) match very broadly (`user`, `token` match most files in this repo), so ranking depends on the IDF-weighted distinct term score; a human/agent would grep specific identifiers. Documented, deterministic, fine as a "keyword agent" proxy, but expect low precision; do not describe it as "how agents use rg". Only 16 terms; first identifier-like terms are kept, then words in report order (truncation by position).
- Same query (`description`), corpus (`corpus.files` for baselines, whole snapshot dir for Graphify/CRG, see M3), and 8000/50 budget object are passed to everyone; Graphify receives `--budget 8000` (character-based in Graphify, so output exceeds it, C1); CRG has no budget parameter. CRG runs on a clone at a neutral path (good) with FTS only.
- Graphify node ranking = print order (seeds first, then BFS), not Graphify's internal score; that is what an agent reads, defensible.

## Checked and found correct [run]
Recall@k/Precision@k denominators; Acc@1/5/10 boundary ranks; MRR; multi-root-cause (first hit of any root cause); empty-list handling (no NaN); file metrics derivation; tokens-to-root-cause as sum of uniform renderings up to and including the first root cause; top-10 token sum; Recall@budget cut-off (no skipping of an over-budget item, inclusive `<=`); dedup to first rank; Graphify `end_line:null` handled as a single line; class-sized range -> class; single line -> innermost; decorator lines included in spans; overload merging; seeded PRNG/bootstrap determinism.

## Suggested priority
1. C1 (cap lists) and C2 (module chunk mapping), then re-run smoke.
2. M1 (chunk granularity vs property GT) and M2/M3 (file nodes, unresolved) before any comparative run.
3. Make uniform-token metrics the headline (M4/M5), two-sided paired stats (m1).
