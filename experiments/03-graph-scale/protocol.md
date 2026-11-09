# Experiment 3 protocol: does graph-based retrieval become more valuable at scale?

**Status: DRAFT for review — not frozen. No billable stage may start before the owner approves it (§11).**
Decisions and amendments: `decision-log.md` (E3-Dxx). Experiments 1–2 are immutable reference points.

## 1. Question and hypotheses

**Research question.** Does graph-based code retrieval give a benefit that *increases* with codebase size and with the architectural connectivity a task requires, for retrieval quality and for a coding agent's accuracy and effort?

What experiments 1–2 established (not re-litigated here): on a 6k-line NestJS repository with 14 injected-bug tasks, hybrid retrieval (lexical + embeddings + call-graph propagation) had the best Recall@10 (0.67 vs 0.47 for embeddings); call-graph traversal was the only graph component with a measurable effect; a Claude Code agent with Read/Grep/Glob was at ceiling (100%) with or without retrieval tools; large tool outputs increased total tokens; single-shot diagnosis improved with better context (custom graph 0.98, hybrid 0.93 at 8k). None of the 6 confirmatory tests of experiment 2 was significant.

The hypotheses are stated so that each can fail.

| ID | Hypothesis (directional) | Estimand | Falsified if |
|---|---|---|---|
| **H1** scale | The graph's contribution to retrieval grows with corpus size | slope of Δ_graph = Recall@10(hybrid) − Recall@10(hybrid-nograph) against log10(corpus tokens), within task (nested corpora, §4.2) | slope 95% CI upper bound < +0.03 per 10× |
| **H2** connectivity | The graph's contribution is larger for cross-module tasks | Δ_graph(cross-module stratum) − Δ_graph(local stratum), pooled over M and L | CI upper bound < +0.05 |
| **H3** agent effort | On the large repository, a compact graph tool reduces an agent's total session tokens at non-inferior accuracy | ratio of mean total tokens (compact-graph / baseline); accuracy non-inferiority margin 5 points | token ratio CI lower bound > 0.95, or accuracy non-inferiority fails |
| **H4** graph content | At equal interface and token budget, graph content helps the agent | accuracy(compact-graph) − accuracy(compact-nograph) on L | CI upper bound < +0.05 |

H1 and H2 are retrieval-only (no model calls). H3 and H4 need the billable agent stage (§11). Primary family = {H1, H2, H3, H4}, Holm-corrected at α = 0.05. Everything else is exploratory and is labelled as such.

## 2. Repositories (scale ladder)

Language (TypeScript) and framework (NestJS) are held constant so that size is not confounded with language or extractor quality (E3-D03). Measured facts are in `repository-assessment.md`.

| Level | Repository (pinned) | Non-test lines | Est. tokens (chars/4) | Files | Navigation-graph nodes / edges |
|---|---|---:|---:|---:|---:|
| S | brocoders/nestjs-boilerplate (experiment 1 base) | 6,268 | 44k | 157 | 354 / 663 |
| M | immich-app/immich `server/` @a203e288 | 62,612 | 590k | 472 | 3,868 / 10,954 |
| L | twentyhq/twenty `packages/twenty-server/` @bde4ff13 | 763,415 | 8.5M | 10,046 | 25,354 / 76,434 |

With three repositories, repository-level properties cannot be separated statistically from repository idiosyncrasies. Size is therefore also manipulated **within** a repository (§4.2), and connectivity is measured **per task** (§4.3). Repository-level comparisons are descriptive.

## 3. Task categories and ground truth

Every task has: a query (as a user or reviewer would write it), a pinned snapshot, and ground truth that a third party can verify without our retrieval systems (E3-D08). The task schema extends experiment 1's `GroundTruthTask` (§7).

| Cat. | Task | Agent output (structured JSON) | Ground-truth source | Independent check |
|---|---|---|---|---|
| A | Bug localisation (historical) | ranked candidates {file, symbol, lines}; root-cause explanation | merged fix PR: non-test functions changed by the fix; query = linked issue text, verbatim | the fix's added/changed test fails at the parent commit and passes at the fix (where runnable) |
| B | Feature understanding | entry points; components; ordered main path | the PR(s) that introduced or last reworked the feature + code reading | auditor traces the path; a test that exercises the feature |
| C | Change impact | directly / indirectly affected symbols; affected modules; tests to update | **executable oracle**: apply the change (e.g. signature or DTO shape) at the snapshot, run the type checker → exact direct-impact set; run unit tests → failing tests; plus historical co-change in commits making the same kind of change | re-run the oracle |
| D | Cross-module data-flow tracing | ordered path from origin to sinks; transformations; persisted/emitted where | code reading + runtime trace of a test exercising the flow (V8 coverage / call trace) where runnable | auditor re-traces; trace is reproducible |
| E | Architectural questions | set of components/symbols with roles | code reading with citations; failure-path questions checked against error-handling code | second annotator; disagreement adjudicated |

Rules (from the weaknesses of experiments 1–2):
- **Difficulty.** No injected defects in M and L. Reports are used verbatim; their *lexical overlap* with the ground truth (share of ground-truth identifier tokens present in the query) is measured and used for stratification, not edited away. For a subset of category-A tasks a second, identifier-free version of the report is written and audited (a within-task manipulation of "grep-ability").
- **Ground-truth content.** Correct symbols; files and line ranges; relevant relationships (typed edges between ground-truth symbols, written by the annotator from the code); expected path (ordered); acceptable alternatives; distractors; evidence (commit, test, trace, citation).
- **No self-generated labels.** Retrieval outputs are never shown to annotators before the ground truth is frozen. Module communities used as covariates come from the import graph only.
- **Independent audit** of every task before any run that scores it (an auditor that did not author the task, with access to the code and the evidence but not to retrieval results). Agreement and changes recorded as in experiment 1 (`AUDIT.md`, `ADJUDICATION.md`).
- **Contamination.** Prefer fixes merged after 2026-06-01. The repositories themselves are public and probably in training data, which affects all arms equally; the tool-free single-shot arm (§5, stage 4) also serves as a memorisation probe.

## 4. Design: separating size from connectivity

### 4.1 Factors

| Factor | Levels | How it varies |
|---|---|---|
| Repository scale | S, M, L | between repositories (descriptive) |
| Corpus size (within repository) | nested corpora C1 ⊂ C2 ⊂ C3 (L) and C1 ⊂ C2 (M) | **manipulated within task** |
| Task connectivity | local vs cross-module (pre-registered stratum) + continuous covariates | measured per task |
| Retrieval method | 7–9 methods (§6) | within task |
| Task category | A–E | between tasks |
| Agent capability | Haiku 5.5 / Sonnet 5.5; Read+Grep+Glob vs Read+Glob (no Grep) | stage 3 only |

### 4.2 Nested corpora (size held apart from task)

For a task on L, its ground-truth files are always present; corpus size grows by adding whole import-graph communities in order of community-graph distance from the ground-truth communities (ties: smaller first), until the corpus reaches ≈ 60k lines (C1, Immich's size), ≈ 200k lines (C2) and the full server (C3). On M: ≈ 6k lines (C1, the experiment-1 size) and the full server (C2). Whole communities are added so that the local graph structure around the task is intact at every size; random file removal would cut edges and penalise graph methods unfairly. Every method rebuilds its index per corpus (BM25 statistics, embeddings from the content-hash cache, graph).

This isolates the effect of *more surrounding code* (distractors, name collisions, longer graph paths) from the task itself. Its limitation, stated up front: a C1 slice of Twenty is not a real 60k-line repository; the between-repository comparison M vs L-C1 shows how much that matters.

### 4.3 Task-level connectivity covariates (measured, not estimated)

From the ground truth and the snapshot's import graph: number of ground-truth files; number of import communities spanned; ground-truth path length; presence of an indirect boundary (DI through an interface or token, job queue, event bus, GraphQL resolver, HTTP to another service); name ambiguity of ground-truth symbols (count of declarations sharing the simple name); lexical overlap of the query. **Cross-module stratum** (pre-registered): spans ≥ 2 import communities **and** (path length ≥ 3 **or** an indirect boundary). Target ≥ 50% of tasks in each stratum.

### 4.4 Sample sizes

| Repository | Dev | Test | Composition target |
|---|---:|---:|---|
| S | existing 6 dev + 14 test injected tasks (experiment 1) + ~10 historical (A) | | anchor to experiments 1–2 |
| M (Immich) | 10 | 30 | A ≈ 15–20, B–E ≈ 10–15; ≥ 50% cross-module |
| L (Twenty) | 10 | 30 | same |

Power (paired, two-sided α = 0.05, 80%): with the per-task SD of a paired Recall@10 difference observed in experiment 1 (≈ 0.32), n = 30 detects ≈ 0.16 per repository and n = 60 pooled ≈ 0.12. For binary agent accuracy with ≈ 30% discordant pairs, n = 60 detects ≈ 0.20; for log total tokens (assumed per-task SD 0.4), n = 60 detects ≈ 15%. H1 uses within-task slopes (more power); its SD is estimated on dev before freezing. These are the minimum effects worth detecting: **+0.10 Recall@10** graph contribution at L; **+0.05 per 10× corpus** slope; **−20% total tokens** or **+15 points accuracy** for agents. Smaller effects are not worth the engineering of a graph index, and the study is not powered for them.

## 5. Stages (least cost first; each stage has a go/no-go gate)

| Stage | What | Billable | Gate to next stage |
|---|---|---|---|
| 0 | Implementation + non-billable validation (§ implementation-plan.md); tasks authored and audited; dev/test split frozen | no | audited tasks; extractor coverage ≥ 95% resolved calls on M and L; tests green |
| 1 | **Retrieval-only** on S, M, L and nested corpora; infrastructure metrics; H1, H2 | no | always reported. If Δ_graph at L ≤ 0 with CI upper < 0.05 **and** H2 not supported, stages 3–4 are re-scoped to a small confirmation (or dropped) |
| 2 | Agent pilot on dev tasks (Haiku 5.5 mostly; a Sonnet sanity check); calibrates cost per run, ceiling, tool adoption | **yes — needs approval** | no ceiling (baseline accuracy ≤ 85%); parse rate ≥ 95%; measured cost within estimate |
| 3 | Agent main run on test tasks (M, L); H3, H4 | **yes — needs approval** | — |
| 4 | Single-shot (no tools) at scale: each method's context at 2k/8k; memorisation probe | **yes — cheap with Haiku** | — |

Stage 3 matrix (recommended; full matrix not run):

| Arm | Tools | Retrieval | Models |
|---|---|---|---|
| A0 baseline | Read, Grep, Glob | — | Haiku (M, L); Sonnet (L) |
| A1 compact-nograph | + `find_relevant_code` | hybrid without graph propagation; pointer list, no relationship lines | Haiku (M, L) |
| A2 compact-graph | + `find_relevant_code` | hybrid with graph; pointers + relationship lines | Haiku (M, L); Sonnet (L) |
| A3 no-grep graph | Read, Glob + `find_relevant_code` | as A2 | Haiku (L) |
| A4 no-grep nograph | Read, Glob + `find_relevant_code` | as A1 | Haiku (L) |

A1 and A2 have byte-identical tool name, description and schema, and the same output token cap, so they differ only in the content behind the interface (E3-D07). Prompt: experiment 2's p2 (directed) sentence, identical in all arms. Repeats: 3 per task × arm (Haiku), 2 (Sonnet), averaged within task (single-run agent noise is 2–6 points; `notes/external-research.md` §4). Per-run caps: 40 turns, 800-token tool output.

## 6. Retrieval methods

ripgrep, BM25, embeddings (Qwen3-Embedding-0.6B, pinned revision), hybrid (frozen experiment-1 config), **hybrid-nograph** (hybrid with graph propagation disabled — the graph ablation, primary contrast for H1/H2), custom graph (frozen), **compact-graph** and **compact-nograph** (pointer renderers over hybrid and hybrid-nograph, `retrieval-architecture.md`), Graphify and CRG through the experiment-1 adapters where their indexers complete on M and L (failure to index at scale is itself reported). Configs are frozen from S/dev before any M/L test evaluation; no per-repository tuning (the brief: do not optimise the graph for one repository).

Fairness: identical corpus files per condition, identical top-k and token budgets, recall reported at fixed token budgets (500 / 1k / 2k / 8k) as well as at fixed k, so that a method cannot win by returning more text.

## 7. Metrics

Retrieval (all categories; set-valued ground truth): Recall@5/10, Precision@k, MRR of the first root-cause symbol (A), path recall (share of ground-truth path edges whose both endpoints are retrieved), impact-set recall@20/50 (C), recall at fixed token budgets, tokens returned.

Agent: exact task accuracy (category-specific, automatic): A root cause in the top candidate and line overlap (experiment 2's RC+line@1); B/D ordered-path score (share of ground-truth consecutive pairs present in order) and component F1; C impact-set F1 and test-set recall; E component F1. Plus total session tokens (input + cache read + cache write + output), number of tool calls by tool, distinct source files read, lines read, turns, latency, cost (Claude Code `total_cost_usd` and our list recomputation), tool adoption, tokens returned by the retrieval tool and their re-consumption (cache-read tokens attributable to tool results).

Infrastructure (per repository and corpus): graph build time and peak memory, embedding time, BM25 build time, storage (SQLite, vectors), query latency p50/p95, incremental update time after a 1-file and a 20-file change, freshness (share of edges in a changed file that are stale until rebuild).

Scaling: every metric above against corpus tokens, files, symbols, edges, cross-community edge ratio and task-level covariates.

## 8. Statistical analysis

Unit = task (repeats averaged within task). Paired comparisons with task-level bootstrap CIs (10k resamples, seeded) as in experiments 1–2. H1: per-task OLS slope of Δ_graph on log10(corpus tokens) across that task's nested corpora; mean slope with bootstrap CI over tasks; sensitivity: mixed model `Δ ~ log10(size) + (1 + log10(size) | task)`. H2: difference of stratum means with a stratified bootstrap; sensitivity: regression on the continuous covariates. H3: ratio of means of total tokens with bootstrap CI, plus accuracy non-inferiority (one-sided 95% CI lower bound of accuracy difference > −0.05). H4: paired accuracy difference. Holm over {H1–H4}. Secondary analyses report CIs without p-value claims. Repeat agreement and within-task variance are reported (experiment 2 showed agentic repeats agree; single-shot ones vary).

## 9. Controls and isolation (carried over from experiments 1–2)

Single-task workspaces exported from the pinned snapshot (parent commit of the fix for category A), re-initialised as one neutral commit with no history; no cross-task caches in the agent; one `claude` process at a time on the named account; tool allow-list and MCP isolation as in experiment 2 (`restricted-oauth`); init-fingerprint check; resumable, limit-aware runs; dev/test separation; configs frozen before test; every amendment logged.

## 10. What would justify a larger benchmark, and what falsifies the hypothesis

Go bigger (more repositories, languages, tasks) only if stage 1 shows Δ_graph ≥ +0.10 at L **or** a positive H1 slope with CI excluding 0, **and** stage 3 shows either a ≥ 20% token reduction at equal accuracy or a ≥ 15-point accuracy gain for compact-graph over both baseline and compact-nograph on L.

The scaling hypothesis is falsified (for this ladder and these methods) if H1 and H2 are both not supported with CIs excluding the minimum effects of §4.4, or if compact-graph is no better than compact-nograph on L (H4) while baseline accuracy is below ceiling. A null result at L with a working index is a publishable answer, not a reason to tune the graph until it wins.

## 11. Approvals required

Stages 0–1 are authorised (non-billable). Stages 2, 3 and 4 each require explicit owner approval naming: account, billing mode, model(s), maximum runs, maximum list-price spend, and the expected number of 5-hour usage windows (`cost-estimate.md`).
