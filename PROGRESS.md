# PROGRESS

## Experiment 2 (branch `agent-eval`): downstream agent diagnosis. Status: main run (stage 3) in progress
- Question: does graph-enhanced retrieval make a coding agent diagnose bugs more accurately or cheaply?
- Everything is in `experiments/02-agent-diagnosis/`: `protocol.md` (frozen 2026-11-08, Amendment A), `FROZEN.json`, `decision-log.md` (E2-D01..D19), `AUDIT.md`, `APPROVAL.json` (owner-approved stages), `results/`.
- Approval (2026-11-08): run on the owner's "personal" Claude Code login (Pro subscription), strictly one run at a time. Model claude-sonnet-5-5, effort high.
- Stages 1–2 (dev pilot, done): 60 agentic + 108 single-shot runs, all valid, 0 exclusions, $6.02 list-price. Agentic accuracy at ceiling (1.00 everywhere). Under p1 the agent never calls retrieval tools; under p2 (directed) it uses our `search_code` (≈ 40% fewer turns, 20–30% fewer tokens) but still never Graphify/CRG. Report: `results/dev-pilot-report.md`.
- Stage 3 (test split, 1,176 runs: agentic p2 → single-shot 2k → 8k → agentic p1): `experiments/02-agent-diagnosis/run-stage3.sh` (resumable; stops on a usage-limit halt; re-run the script to resume). Log: `results/stage3.log`.
- Final report: `npx tsx src/agent-eval/final-report.ts --split test` → `results/final-report.md`.
- Not done: the independent auditor's re-verification of the audit fixes (deferred to save plan usage; the fixes are covered by tests and the dev pilot ran clean).

---

Living status file. Another session should be able to continue from here plus `research/decision-log.md`.

## Status: M1–M5 complete (final report: `research/findings.md`)

| Milestone | Status | Evidence |
|---|---|---|
| M1 minimal benchmark (7 methods, common interface, metrics, report) | done | `evaluation/results/m1-dev/report.md` |
| M2 richer graph (structural, calls, control flow, data flow, provenance, coverage checks) | done | `research/graph-coverage.md`, `evaluation/results/graph-validation.json` |
| M3 20 tasks, independent audit, dev/test split | done | `evaluation/dataset/{AUDIT,ADJUDICATION}.md`, `FROZEN.json` (v1.0) |
| M4 ablations + dev-only tuning, frozen configs, single held-out run | done | `evaluation/results/tuning-dev`, `evaluation/configs/FROZEN-CONFIG.json`, `final-test`, `ablation-test` |
| M5 final report | done | `research/findings.md` |

## Reproduce (all commands verified in this session)
```bash
npm install
npm run setup:competitors        # pinned clones + venvs + target deps (idempotent)
npm run setup:target             # 20 single-bug snapshots + base, reproducible commit hashes
npm run graph:build              # custom graph for every snapshot (cached by commit)
npm run graph:validate           # coverage + integrity + build-twice hash check
npm run benchmark -- --split test --run final-test
npm run benchmark:ablation -- --split test --run ablation-test
npm run report                   # regenerate every evaluation/results/*/report.md
npm test                         # 85 tests (graph extractor + harness)
```
`npm run index` pre-builds all caches. `npx tsx scripts/tune-dev.ts` re-runs the dev-only tuning (it rewrites `evaluation/configs/*.json`; do not run it after a held-out evaluation without logging a decision).

## Headline results (held-out test, n=14; details in research/findings.md)
- hybrid: Recall@10 0.67, RC MRR 0.40, Precision@10 0.21, native tokens 6.3k (8k budget) / Recall@10 0.64 at 1.9k tokens.
- best baseline (embeddings): Recall@10 0.47, RC MRR 0.36, Precision@10 0.14, 5.5k tokens.
- custom_graph 0.60 / 0.35; BM25 0.40 / 0.24; ripgrep 0.23 / 0.16; CRG 0.11 / 0.05; Graphify 0.08 / 0.05.
- Significant: hybrid > embeddings on Recall@10 (+0.20 [0.03, 0.36]) and Precision@10; not significant on root-cause MRR.
- Ablations: graph traversal is the only component with a CI excluding 0. Control flow, confidence, application and DI edges show no measurable effect.

## Key decisions (see decision-log.md)
- Single-bug snapshots (D-017), because the combined snapshot had cross-task masking found by the audit.
- Harness fixes from the independent review (D-018): cap at 50 items; unresolved and file-only items occupy rank slots; module chunks; file nodes; multi-line property chunks.
- Ranking priors and the control-flow bonus were added during dev iteration (D-019) and ablated on test.
- D-023: a post-freeze bug (ablation runner used the pristine snapshot; stale snippet cache) was found by a cross-check, fixed, and re-run with the frozen configs. Invalid runs are in `evaluation/results/_invalid/`.

## Known limitations
- 14 held-out tasks from one repository. CIs are wide.
- No LLM in the loop: Graphify and CRG are used without the agent they were designed for.
- Proxy tokenizer (o200k_base).
- The downstream "LLM identifies the root cause from each method's context" experiment was not run (see findings §G, step 1).

## Next steps (if continuing)
1. Downstream agent experiment: same model, each method's context, measure root-cause identification and real Claude token usage.
2. A second repository, and historical (non-injected) bugs.
3. An LLM-agent query-rewriting variant for all methods (would make Graphify/CRG closer to their intended use).
