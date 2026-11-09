# Experiment 2 findings: does graph-enhanced retrieval make a coding agent better at diagnosing bugs?

**Short answer, on this benchmark:**
- **Agent with tools: no.** A Claude Code agent (Sonnet 5.5) with Read/Grep/Glob diagnosed every bug correctly in every condition. Attaching a retrieval tool, graph-based or not, did not make it more accurate, cheaper, faster or more token-efficient.
  - Left to choose, it never called a retrieval tool.
  - Told to use one, it called ours in a minority of runs, at no net gain.
  - It never called Graphify or Code Review Graph even when told to. Their tool lists alone made each run 3.1× as token-hungry (CRG) or 1.4× (Graphify).
- **Model given retrieved context, no tools: yes, context quality matters a lot.**
  - With only the file list, the model got 31–33% right. With our graph or hybrid context it got 71–98%.
  - Graph-based contexts were the best of the retrieval methods. The pre-registered hybrid-vs-embeddings comparison was positive (+0.07 at 2k, +0.10 at 8k) but not significant with 14 tasks.

Everything below is from `results/final-report.md` (test split) and `results/dev-pilot-report.md`. The design is in `protocol.md` (frozen before any test run, Amendment A) and the decisions are in `decision-log.md`.

## What was run

- **Tasks.** The 20 frozen injected-bug tasks from experiment 1: 14 test and 6 dev, single-bug snapshots of `brocoders/nestjs-boilerplate`.
- **Agent.** Claude Code 2.1.319 headless, `claude-sonnet-5-5`, effort high, profile `restricted-oauth`.
  - It worked in an isolated workspace with Read/Grep/Glob and at most one MCP server.
  - None of the user's configuration reached it; this was verified from recorded requests and from the init fingerprint of every real run.
- **Agentic conditions:**
  - baseline (no MCP server);
  - `search_code` backed by embeddings, or by our hybrid (graph + lexical + embeddings);
  - Graphify's native MCP server;
  - Code Review Graph's native MCP server.
- **Two prompts, identical across conditions.**
  - **p1:** natural tool choice.
  - **p2:** p1 plus one sentence telling the agent to use an attached MCP search or graph tool first.
- **Single-shot.** One call, no tools. The bug report plus one method's experiment-1 retrieved context at 2k or 8k tokens, with `none` (file list) and `oracle` bounds.
- **Scale.** 14 test tasks × 3 repeats:
  - 420 agentic runs (5 conditions × 2 prompts);
  - 756 single-shot runs (9 contexts × 2 budgets).

  All 1,176 were scored. The only exclusions were 4 usage-limit interruptions, which were re-run. The dev pilot added another 168 runs.
- **Scoring.** The primary metric is RC+line@1: the top candidate names the root-cause function and its line range covers the mutated lines. It is scored automatically, with no LLM judge.
- **Billing.** The owner's personal Pro subscription, run strictly sequentially. List-price equivalent: $33.99 for 1,349 billable calls (all stages, including 5 interrupted attempts), of which $6.02 was the dev pilot. It took three 5-hour usage windows.

## Confirmatory tests (Holm over 6, α = 0.05)

| ID | Test | Result |
|---|---|---|
| H1a | agentic hybrid > baseline, RC+line@1 (p2) | 1.00 vs 1.00, no difference. **Not supported** (ceiling). |
| H1b | agentic hybrid > embeddings (p2) | 1.00 vs 1.00. **Not supported** (ceiling). |
| H1c-2k | single-shot hybrid > embeddings @2k | 0.71 vs 0.64, +0.07 [−0.10, 0.26]. **Not supported.** |
| H1c-8k | single-shot hybrid > embeddings @8k | 0.93 vs 0.83, +0.10 [−0.14, 0.33]. **Not supported.** |
| H2-tokens | agentic hybrid uses fewer tokens than baseline (p2) | 20.6k vs 19.5k: hybrid used **more**. **Not supported.** |
| H2-cost | agentic hybrid cheaper than baseline (p2) | $0.0244 vs $0.0219: hybrid cost **more**. **Not supported.** |

With 14 tasks, only differences of about 0.25 in accuracy are reliably detectable. The single-shot differences are smaller than that, so "not supported" means "no effect large enough to detect", not "no effect".

## Agentic results

**Accuracy is at the ceiling.** All 420 test runs and all 60 dev runs were correct, and repeats always agreed. The bug reports name concrete behaviour or identifiers, so Grep finds the defect in 4–10 turns, in about 10 seconds and about 20k tokens.

**Tool adoption** (share of runs that called the retrieval tool at least once):

| | embeddings | hybrid | Graphify | CRG |
|---|---:|---:|---:|---:|
| p1 (natural) | 0% | 0% | 0% | 0% |
| p2 (directed), test | 19% | 31% | 0% | 0% |
| p2 (directed), dev | 67% | 67% | 0% | 0% |

When the directed agent did use hybrid search, it took fewer turns: 4.1 against 5.0 in runs that didn't use it. It also used more tokens, 25.9k against 18.2k, because the tool's ~4k-token result is cached and re-read on every later turn.

On dev, the tool-using runs looked like a clear win: about 40% fewer turns and 20–30% fewer tokens. That did not hold on test, where adoption was lower.

**The competitors' native MCP servers are pure overhead here.** Their tool schemas are sent on every turn, and their tools were never called. Per run, against the baseline under p2:

| Server | Extra tokens/run | Extra cost/run | Accuracy change | Paired result (14 tasks) |
|---|---:|---:|---|---|
| Code Review Graph (23 tools) | +40.5k (3.1×) | +$0.007 | none | 14/14 tasks worse |
| Graphify (7 tools) | +7.4k | +$0.002 | none | 14/14 tasks worse |

The p1 arm repeats this pattern.

**One secondary result is spurious, and that is instructive.** Under p1, hybrid was "cheaper" than baseline: $0.0211 vs $0.0223, p = 0.022 uncorrected. But the p1 agent never called the tool, so the only difference between the two conditions is 68 schema tokens. The gap must come from noise or prompt-cache timing. It shows why the uncorrected secondary comparisons should not be read as evidence.

## Single-shot results (no tools; one method's context)

RC+line@1, mean over 14 test tasks (3 repeats each):

| Context | 2k | 8k |
|---|---:|---:|
| none (file list only) | 0.33 | 0.31 |
| ripgrep | 0.52 | 0.57 |
| BM25 | 0.55 | 0.79 |
| embeddings | 0.64 | 0.83 |
| **hybrid (ours)** | **0.71** | **0.93** |
| **custom graph (ours)** | **0.76** | **0.98** |
| Graphify | 0.45 | 0.76 |
| Code Review Graph | 0.45 | 0.45 |
| oracle (ground-truth symbols) | 0.83 | 0.93 |

- **Any retrieval beats none.** Every method except Code Review Graph improves on the file-list bound significantly at 8k; the paired 95% CIs exclude 0.
- **The ranking follows experiment 1's set-recall ranking.** Recall gains there do translate into diagnosis gains here.
- **Our graph-based contexts did best.** At 8k, custom graph (0.98) and hybrid (0.93) beat the competitors' contexts.
  - Hybrid vs Code Review Graph: +0.48 [0.21, 0.74].
  - Hybrid vs Graphify: +0.17 [0.00, 0.36].
  - Both are exploratory and uncorrected.
- **Graph vs flat retrieval is not significant.** Custom graph vs embeddings was +0.12 at 2k and +0.14 at 8k, both with CIs including 0. With 14 tasks it is not separable.
- **Custom graph matches the oracle at 8k.** The oracle gives only the relevant symbols, shuffled. The graph context adds callers and neighbours, which seem to help the model place the defect.
- **Cost.** Single-shot calls cost about $0.008–0.054 each, depending on context size. Latency differences between methods are confounded by cross-run prompt caching (1-hour TTL) and are not interpreted.

## What this means

1. **For a strong agent on bugs that grep can find, retrieval tools add nothing.** Graph-enhanced or not, an MCP retrieval tool doesn't change accuracy. An unused tool with a large schema, such as Code Review Graph's 23 tools, makes each run up to 3× more expensive in tokens. If you ship such a server to an agent, its schema cost is paid on every turn whether or not it is used.
2. **Retrieval quality matters wherever the model can't search for itself.** Examples are one-shot prompts, constrained context and pre-fetched context for review bots. There, our graph-based contexts gave the best diagnoses, close to or at the oracle bound.
3. **The benchmark is too easy for the agentic question.** Injected single-site bugs with descriptive reports sit at the agentic ceiling. The single-shot gradient shows that context does matter for the underlying model, so harder tasks are needed to see whether an agent would benefit.

## Limitations

- One repository and 14 test tasks; wide confidence intervals.
- The bugs are injected, single-site and lexically anchored. The model may also have memorised the upstream boilerplate; this affects all conditions equally.
- One agent and model (Claude Code + Sonnet 5.5, effort high). A weaker model, or an agent without Grep, might behave differently.
- **p2 was added after the dev pilot showed the agent ignored the tools.** It was decided on dev data before any test run and logged (E2-D17, E2-D19). The confirmatory agentic tests were moved to p2 at the same time.
- **A post-freeze harness fix (E2-D20)** changed how usage limits are recognised and resumed. It did not touch scoring, analysis or prompts.
- Costs are Claude Code's list-price estimates on a subscription, not billed amounts. The prompt cache spans runs (1 hour).
- The independent auditor's re-verification of the pre-run fixes was not done; it was deferred to save plan usage. The fixes are covered by tests, and the runs had no unexplained exclusions.

## Next steps

1. **Harder tasks**, chosen to separate the agentic conditions:
   - historical (non-injected) bugs;
   - multi-file or cross-module defects;
   - reports without identifiers.
2. **A no-Grep arm** (Read plus the retrieval tool only), and **a weaker model** (Haiku 5.5). Both test whether retrieval helps when lexical search is unavailable or the model explores less well.
3. **A retrieval tool shaped for agents.** It would return a compact graph neighbourhood rather than a 4k-token context, so that using it saves tokens instead of adding them.

## Reproduce

```bash
npx tsx src/agent-eval/final-report.ts --split test   # rebuilds results/final-report.md from the run directories (no model calls)
npx tsx src/agent-eval/final-report.ts --split dev    # dev-pilot report
# Re-running the experiment (billable; needs APPROVAL.json and AGENT_EVAL_BILLABLE=1):
experiments/02-agent-diagnosis/run-stage3-loop.sh     # resumable; sequential; sleeps through usage limits
```
