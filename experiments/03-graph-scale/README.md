# Experiment 3: does graph-based code retrieval become more valuable at scale?

**Status (2026-11-09): milestone 1 (investigation and proposal) complete. No billable run has been made. Waiting for the owner's review before any model-based stage.**

| Document | Contents |
|---|---|
| `repository-assessment.md` | availability of the candidate repositories; measured complexity profiles (deliverable 1) |
| `protocol.md` | hypotheses, design, matrix, metrics, statistics, stages and gates — DRAFT, not frozen (deliverable 2) |
| `task-catalogue.md` | candidate tasks with ground-truth strategies; 98 mined Immich bugs; Twenty sample; 15 understanding tasks (deliverable 3) |
| `retrieval-architecture.md` | reuse; gaps found at scale; the compact `find_relevant_code` interface and its prototype measurement (deliverable 4) |
| `implementation-plan.md` | reuse, milestones, tests, effort (deliverable 5) |
| `cost-estimate.md` | per-stage runs, list-price and subscription estimates (deliverable 6) |
| `decision-log.md` | E3-D01 … E3-D11 |
| `profiles/*.json` | raw complexity profiles (S, M, L) |
| `results/compact-prototype.json` | compact-output measurement |
| `notes/` | external research, Immich analysis, mined candidates, Twenty sample |

## Executive summary

**1. The personal repositories cannot test scale.**
- **SignalStream:** 2,612 non-test Go lines (about 17k tokens) and 2 commits. It is smaller than the 6k-line repository on which an agent already scored 100%, and it has no bug history.
- **DocuParse:** 10k lines with 19 mostly feature commits.
- **IntelliDoc:** does not exist locally or on GitHub.
- **Hyrra:** present, but not opened (not authorised).

**2. The experiment climbs a ×10 ladder of real TypeScript/NestJS backends** instead:
- S nestjs-boilerplate (6.3k lines);
- M Immich server (62.6k);
- L Twenty server (763k; 8.5M tokens).

The existing compiler-based extractor indexes L in 97 s with 4.4 GB of memory, after a streaming fix to graph hashing and export whose outputs stay byte-identical. Holding language and framework constant keeps size from being confounded with extractor quality.

**3. Size is not the same as difficulty, and the profiles show it.**
- **Name lookup.** The average callee name is shared by 6.9 declarations in S, 4.6 in M and **214 in L**.
- **Execution reach.** From an HTTP handler, execution reaches 13, 9 and **473** files at depth 5, 5 and **21**.
- **Cross-module ratio.** Measured by communities, it barely differs across the three (0.21–0.32), so it is not a useful separator at repository level.
- **Design consequence.** The protocol manipulates size *within* tasks, through nested corpora inside Twenty, and measures connectivity *per task* (communities spanned, path length, job/event/DI boundaries).

**4. Our graph is blind exactly where the hypothesis lives.**
- Immich has 162 event and job handlers and Twenty 210; the extractor produced **0 publish edges** in both.
- Twenty's 603 GraphQL resolvers are not modelled as entry points.
- Asynchronous, multi-stage paths, such as Immich's upload → metadata → thumbnails → ML → duplicates chain, are therefore cut at every queue hop.
- Testing the hypothesis before adding generic keyed-dispatch edges would risk a false negative. This is the first thing to implement.

**5. Real historical bugs are plentiful but not automatically hard.**
- **Pool:** 98 post-cutoff Immich fixes with tests were mined. With method-independent rules, 42 are hard, 37 medium and 19 easy.
- **Lexical findability:** a BM25 screen put the fixed file in the top 10 for 78 of 97.
- **Selection rule:** tasks are never selected by any retriever's rank, which would bias the benchmark. Results will be reported by stratum.

**6. A compact, pointer-style tool output is much cheaper than snippets, but graph annotations are not free.**
- **Token cost:** on experiment 1's frozen rankings, about 760 tokens of pointers carried 85% of what hybrid's 6.3k-token snippet context pointed to.
- **Relationship lines:** at equal tokens, listing callers and callees did **not** beat listing more ranked symbols on the small repository.
- **Consequence:** the agent comparison is therefore graph-compact vs **no-graph-compact** with byte-identical schemas and token caps, not "graph tool vs nothing".

**7. Literature.** No published study tests whether graph retrieval's advantage grows with repository size (`notes/external-research.md`; about 12 graph-retrieval papers checked). Lexical search is consistently the strongest single component (LocAgent's ablation; our experiment 1). Any scale curve we produce is new evidence. The hypothesis is untested, not supported.

## What is verified, what is existing, what is new, what is hypothesis

| Kind | Items |
|---|---|
| **Existing results** (experiments 1–2, unchanged) | hybrid Recall@10 0.67 vs embeddings 0.47; call-graph traversal the only graph component with an effect; agent at 100% with or without tools; tool outputs increased tokens; single-shot context quality matters; 0 of 6 confirmatory tests significant |
| **Verified this session** (measured, reproducible, no model calls) | repository availability and sizes; S/M/L complexity profiles (`profiles/`); extractor coverage and cost on M and L; the streaming fix keeps experiment-1 hashes; compact-output token and pointer-recall table; Immich and Twenty fix-PR counts |
| **New observations** | name ambiguity and execution reach jump at L, not at M; keyed-dispatch and GraphQL gaps; historical bugs mostly lexically findable at file level; relation lines do not pay for themselves at S under equal token budgets |
| **Hypotheses** (to be tested; may fail) | H1 graph contribution grows with corpus size; H2 larger for cross-module tasks; H3 compact graph tool cuts agent tokens on L at equal accuracy; H4 graph content beats an identical no-graph tool on L |
| **Recommendations** | below |
| **Decisions for the owner** | below |

## Final recommendation

1. **Is SignalStream complex enough?** No. Measured at 2.6k Go lines and 2 commits, it is below the scale we already showed to be at ceiling, and it has no history for real bugs. Its event-pipeline architecture is the right *kind* of system, and Immich (BullMQ job pipeline: ingest → metadata → thumbnails → ML embeddings → search) provides the same kind at 24× the size.
2. **Do we need a larger repository?** Yes, two, and both are selected and profiled: Immich server (M) and Twenty server (L). Same language and framework as experiments 1–2; 291 and 462 merged issue-linked PRs since June 2026 (external research; not all are fixes).
3. **Smallest experiment that meaningfully tests the hypothesis:**
   - **Retrieval-only part (non-billable).** Stage 1 runs on S/M/L plus nested corpora of Twenty, with about 30 audited test tasks each on M and L. This tests H1 and H2.
   - **Agent part (small, billable).** One agent stage on L only, Haiku 5.5, three arms: baseline, compact-nograph and compact-graph. It is preceded by a 30-run dev pilot that calibrates cost and checks the ceiling. That is 30 test tasks × 3 repeats = **270 runs**, about **$8–27 list** and about 1–3 Pro windows. It tests H3 and H4 where the effect should be largest.
   - **Everything else** (M agents, Sonnet, no-Grep arms, single-shot) is added only if those results justify it.
4. **What to implement first:**
   - **Environments.** Install Twenty's dependencies so call resolution improves from 88% to ≥ 98%.
   - **Generic extractor rules.** Keyed-dispatch edges (job queues and event buses, matched by key symbol), GraphQL resolvers as entry points, and query-builder DB edges. Validated on S, M and L with S's graph unchanged.
   - **Tasks in parallel.** In parallel, curate and audit tasks: task schema v2, oracles, independent audit.
5. **Evidence that would justify a much larger benchmark:**
   - **Retrieval:** stage 1 shows a graph contribution ≥ +0.10 Recall@10 on L, or a positive size slope whose CI excludes 0.
   - **Agent:** compact-graph beats *both* baseline and compact-nograph on L by ≥ 20% total tokens at equal accuracy, or by ≥ 15 accuracy points.
6. **Outcomes that falsify the hypothesis** (on this ladder):
   - H1 and H2 both unsupported with CIs that exclude the minimum effects (slope < +0.03 per 10×; cross-module difference < +0.05);
   - or compact-graph no better than compact-nograph on L while the baseline is below ceiling.

   A null result with a working, gap-free index is the answer, not a reason to tune the graph until it wins.

## Decisions requiring the owner's approval

1. **The direction.** TypeScript/NestJS ladder (Immich M, Twenty L); personal Go repositories and Hyrra not used.
2. **Proceed with milestone 2** (non-billable): implementation, task mining and audit, stage 1. This includes downloading Twenty's dependencies (several GB, network only, no lifecycle scripts).
3. **Later, separately (billable): stage 2 pilot.** About 120 runs, $8–32 list, 1–3 Pro windows. The smallest-experiment alternative is the 270-run L-only Haiku stage. Each needs a named account, billing mode, caps and the window estimate.
4. **Billing for any Sonnet portion:** personal Pro plan, or API key so the personal plan stays usable.

## Changes to shared code in this milestone

- `src/graph/graph-validator.ts` (`graphHash`) and `src/graph/graph-store.ts` (`exportGraphJson`) now stream; output is byte-identical. Covered by the new `tests/graph/streaming-export.test.ts`, including re-deriving the recorded experiment-1 base-graph hash.
- New non-billable tools:
  - `scripts/exp3/graph_profile.py`;
  - `src/retrieval/compact-context.ts`;
  - `scripts/exp3/compact-measure.ts`.
- Test suite: 236 tests. The one failure under full-suite parallel load is the known flaky `agentic-harness` test, which passes alone.
