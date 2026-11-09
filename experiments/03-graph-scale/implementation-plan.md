# Experiment 3: implementation plan

The principle is to extend, not rewrite. Everything in the reuse table runs today on the new repositories; the remaining work is task data, a few generic extractor rules, nested corpora, two renderers and new scorers.

## 1. Reused as is

- **Extractor and graph store.** The TypeScript extractor, graph schema and SQLite store; on Twenty, graph hashing and export now stream (E3-D05).
- **Retrieval methods, unchanged.** ripgrep, BM25, embeddings, hybrid and custom_graph with their frozen configs.
- **Graph-off control.** The hybrid ablation `no_graph_at_all` (`wGraph: 0, wFact: 0`, in `src/cli/ablation.ts`) is the **hybrid-nograph** control. It needs registering as a method, not reimplementing.
- **Evaluation layer.** Metrics, normalisation, paired bootstrap, and per-task snapshot materialisation (`targets/bench.manifest.json` pattern).
- **Agent harness from experiment 2.** Isolation, account binding, approval and spend ledger, usage-limit halts and auto-resume, the mock Messages API, the MCP retrieval server and final-report generation.
- **New in this session, non-billable:**
  - `scripts/exp3/graph_profile.py` (complexity profiles);
  - `src/retrieval/compact-context.ts` and `scripts/exp3/compact-measure.ts` (compact-output prototype and measurement).

## 2. Milestones

| # | Work | New or changed files | Done when |
|---|---|---|---|
| **M2.1** | **Environments.** Install Twenty's dependencies (`yarn` workspace focus on twenty-server, plus the `twenty-shared` build) and check out Immich's full workspace (it needs `@immich/plugin-sdk` for unit tests). Pin every snapshot in a manifest (repo, commit, corpus hash). | `targets/exp3.manifest.json`, setup script | unresolved call sites < 2% on M and L; one Immich and one Twenty unit test pass locally |
| **M2.2** | **Generic extractor rules:** keyed-dispatch edges (job queues, event buses); GraphQL resolvers as entry points; query-builder calls (Kysely) as DB edges. | `src/parser/framework-extractor.ts` (+ fixtures) | fixture tests; S graph byte-identical (its hash is unchanged); precision audit of 50 sampled edges per repository ≥ 90% |
| **M2.3** | **Task schema v2 and validator.** Adds `task_type`, `snapshot`, `gt_path`, `impact {direct, indirect, tests}`, `evidence[]`, `alternatives`, `lexical_overlap` (computed), `connectivity` covariates (computed from the import graph). | `src/types.ts`, `src/evaluation/ground-truth.ts` | v1 tasks still load unchanged; schema tests |
| **M2.4** | **Mining and curation pipeline for historical bugs.** Candidates (from `notes/immich-bug-candidates.jsonl`, plus the same for Twenty) are curated into tasks; a snapshot is materialised at each fix's parent commit; FAIL_TO_PASS is checked where tests run. | `scripts/exp3/mine-*.ts`, `scripts/exp3/materialise.ts` | ≥ 30 + 10 accepted tasks per repository (category A ≈ half) |
| **M2.5** | **Executable oracles.** C: apply a scripted change and collect type-checker errors and failing tests. D: a runtime call trace of a test via V8 coverage. | `scripts/exp3/oracle-*.ts` | each oracle reproduces twice with identical output |
| **M2.6** | **Independent audit** of all tasks by a separate auditor agent with no retrieval outputs, plus an owner spot-check; then freeze dataset v2. | `evaluation/dataset-v2/{AUDIT,ADJUDICATION,FROZEN}.md/json` | audit verdicts resolved; dataset hash frozen |
| **M2.7** | **Nested-corpus builder** (community-based, deterministic) and per-corpus index building. | `scripts/exp3/nested-corpora.ts` | identical corpus hashes on rebuild; ground-truth files present in every corpus |
| **M2.8** | **New methods:** `hybrid_nograph`; `compact_graph` and `compact_nograph` as RetrievalMethods. Compact outputs report "pointed" symbols as results for scoring. | `src/evaluation/methods.ts`, `src/retrieval/compact-context.ts` | unit tests; S results for existing methods unchanged |
| **M2.9** | **Scorers for paths, impact sets and token-budgeted recall**; stage-1 runner over repositories × corpora; infrastructure timing (build, memory, storage, query latency, incremental update). | `src/evaluation/metrics.ts`, `scripts/exp3/stage1.ts` | scorer tests on hand-made cases |
| **M2.10** | **Freeze configs on S/dev and run stage 1** (non-billable); write the stage-1 report. | `results/stage1-*` | report with H1/H2 and the go/no-go decision |
| **M3** | **Agent arms:** `find_relevant_code` MCP backend (compact-graph / compact-nograph, byte-identical schema); no-Grep tool profile; Haiku model option; turn cap; mock-API dry runs of every arm; isolation re-verification; approval request for stage 2 with the stage-1 numbers. | `src/agent-eval/mcp/retrieval-server.ts`, `src/agent-eval/agentic.ts` | zero-cost dry runs pass; `APPROVAL-REQUEST.md` |

**Order.** M2.1 → M2.2 → (M2.3–M2.6 in parallel with M2.7–M2.9) → M2.10 → M3.

**Delegation.** Task mining for Twenty and the independent audit go to separate Sonnet agents, one component per agent. Extractor rules, scorers and analysis stay with the lead.

## 3. Testing strategy

- **Regression.** All 236 existing tests pass, and experiment-1 graph hashes and results are unchanged for S. The new rules must not fire on S, which has no job queue or event bus.
- **Extractor rules.** Fixture mini-applications cover BullMQ/EventEmitter/CQRS-style keyed dispatch, GraphQL resolvers and Kysely chains, with positive and negative cases (same key name but different enum, for example).
- **Determinism.** Build every graph twice and compare hashes (as in experiment 1); nested corpora and snapshots are hashed.
- **Scorers.** Hand-made answer/ground-truth pairs for path order, impact F1 and token-budgeted recall.
- **Agent arms.** Mock Messages API dry runs record exactly what the model would receive: tool schemas byte-identical between A1 and A2, the output cap enforced, and no repository-identifying paths in the workspace.
- **Known flaky tests.** The two tests that fail under full-suite parallel load (shared scoring directory) get fixed in M2.9, since the stage-1 runner touches that code.

## 4. Effort (ESTIMATE)

M2.1–M2.2 take about 1 working session each. M2.3–M2.6 (tasks, oracles and audit) are the bulk, at about 3–4 sessions, because ground truth is authored and checked rather than generated. M2.7–M2.10 take about 2 sessions and M3 about 1. All of it is non-billable but uses plan usage for the sessions and agents (`cost-estimate.md` §3).
