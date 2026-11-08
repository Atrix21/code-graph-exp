# PROGRESS

Living status file. Another session should be able to continue from here plus `research/decision-log.md`.

## Current milestone: M1 (minimal working benchmark), in progress

### Done
- Environment: Node 22.22, TypeScript Compiler API 5.9.3, uv/Python 3.12, CUDA GPU (RTX 3060 6 GB). No LLM API keys (no LLM is used by any method).
- Target selected and verified: `brocoders/nestjs-boilerplate@9620f159` (type-checks clean). Target deps in `targets/deps` (symlinked `targets/node_modules`).
- Competitors investigated, pinned, and wrapped (notes in `research/notes/`):
  - Graphify `Graphify-Labs/graphify` v0.9.104 `433a57a0`. Code-only extract plus the `graphify query` CLI.
  - Code Review Graph `tirth8205/code-review-graph` v2.3.9 `343ab7ce`. Full build plus the search → callers/callees policy.
- Ground truth: 20 injected-bug tasks (Agent A), stratified split of 6 dev / 14 test. **Audit (Agent B) running.**
- Benchmark snapshot builder (`npm run setup:target`): upstream plus 20 patches, pruned to src/test, with a reproducible commit hash.
- Baselines: ripgrep (rg 15.0.0 pinned), BM25, embeddings (Qwen3-Embedding-0.6B, revision pinned). Competitor wrappers are in TS.
- Evaluation harness: canonical symbol index, normalisation, metrics (R/P@k, RC Acc/MRR, file-level, tokens-to-root-cause, recall@token-budget), bootstrap CIs, and per-run markdown reports.
- Plumbing smoke test (2 throwaway tasks, `tests/fixtures/smoke-tasks`): all 5 non-graph methods ran end to end. This found and fixed a silent mean-pooling bug in the embedding setup (D-008).
- Graph retrieval and hybrid code are written against the graph schema (`src/retrieval/graph-engine.ts`, `graph-retrieval.ts`, `hybrid-retrieval.ts`). The ablation command is written.

### In progress
- Graph builder (Agent, Sonnet): `src/parser/*`, `src/graph/{graph-builder,graph-store,graph-validator,build-cli}.ts`, tests.
- Ground-truth audit (Agent B) → lead adjudication → freeze.
- Harness review plus unit tests (Agent C).

### Working commands
```bash
npm install
npm run setup:competitors        # clones + pinned venvs + target deps (idempotent)
npm run setup:target             # builds targets/bench snapshot
npx tsx src/cli/index.ts validate-gt
npm run benchmark -- --split dev --methods ripgrep,bm25,embeddings,graphify,code_review_graph
```

### Known limitations so far
- Proxy tokenizer (o200k_base), because no Claude token counting is available.
- Graphify's budget is character-based and can overflow. CRG has no budget.
- CRG needs absolute paths, so it runs on a neutral clone path `/tmp/cgbench/w`.

### Next
1. Integrate the graph builder, then run all 7 methods on dev (M1 report).
2. Adjudicate the audit, freeze the dataset (FROZEN.json), and commit.
3. M2: measure each graph capability on dev. M4: tune on dev, freeze configs, run test once, run ablations on test. M5: final report.
