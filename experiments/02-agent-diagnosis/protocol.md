# Experiment 2: does graph-enhanced retrieval make a coding agent better at diagnosing bugs?

Status: **pre-registration draft. No billable agent run has been made.** This document is frozen (hash in `FROZEN.json`) before the first billable test-split run. Changes after that are logged with reasons in `decision-log.md`.

Experiment 1 (`research/findings.md`) showed that hybrid retrieval returns more of the relevant code than the baselines (Recall@10 0.67 vs 0.47), but **not** that it pinpoints root causes better (MRR 0.40 vs 0.36, n.s.). Experiment 2 asks the downstream question.

## Research questions and hypotheses

- **RQ1 (accuracy).** Does a coding agent diagnose bugs more accurately when it has graph-enhanced retrieval?
  - H1a (agentic): `agentic:hybrid` > `agentic:baseline` on RC+line@1.
  - H1b (agentic): `agentic:hybrid` > `agentic:embeddings`. This isolates the graph, given that a search tool is available at all.
  - H1c (single-shot): `single:hybrid` > `single:embeddings` at an equal context budget (2k and 8k).
- **RQ2 (efficiency).** At equal or better accuracy, does it use fewer tokens, less money, less time, or fewer turns?
  - H2: `agentic:hybrid` total tokens/run and cost/run < `agentic:baseline`.
- **RQ3 (competitors, intended use).** With an agent driving them through their own MCP servers, how do Graphify and Code Review Graph compare? Experiment 1 could not test this.
- Exploratory: interaction with bug difficulty, lexical overlap and call distance; whether set-recall gains (exp. 1) translate into diagnosis gains; tool-usage patterns.

## Units, tasks, splits

- The 20 frozen tasks (dataset v1.0, single-bug snapshots, unchanged). The **primary analysis uses the 14 test tasks.** The 6 dev tasks are used only for the pilot and prompt freezing, and are reported separately.
- The unit of analysis is the task. Repeats are averaged within a task before any comparison (paired bootstrap over tasks, seeded).

## Conditions

### Agentic protocol (primary)

Claude Code headless (`claude -p`) in an isolated workspace (`/tmp/work/<opaque>/app`): a `git archive` export of the task's single-bug snapshot, a fresh single-commit repo, no history, no other branches, and nothing in the path that names the task. Tools: Read, Grep, Glob (read-only, confined to the workspace). No Bash, web, subagents, skills, user CLAUDE.md or hooks; verified from recorded requests, see `results/isolation-report.md`. Identical system prompt and task prompt in every condition (`src/agent-eval/prompt.ts`, version `p1`). Turn cap 40. Structured output via `--json-schema` (file, symbol, start/end line, explanation required). Pinned: model id `claude-sonnet-5-5` (unless the approval names another), `--effort high`, Claude Code version recorded per run with auto-update disabled (a version change halts the run). Profile `restricted-oauth` only. Run order is a seeded (20261108) shuffle of all task × condition × repeat items, so prompt-cache warmth is spread evenly across conditions.

| Condition | Extra MCP server |
|---|---|
| `agentic:baseline` | none (how coding agents work today: grep + read) |
| `agentic:embeddings` | `search_code` backed by Qwen3-Embedding-0.6B (strongest flat baseline from exp. 1) |
| `agentic:hybrid` | `search_code` backed by our hybrid (frozen exp-1 config) |
| `agentic:graphify` | Graphify's own MCP server (`graphify-mcp`, v0.9.104, defaults) |
| `agentic:crg` | Code Review Graph's own MCP server (v2.3.9, defaults: FTS search; its embedding tool writes to the graph DB and is denied with the other write tools) |

Our servers expose one tool with the same name, description and budget (4,000 tokens per call). Competitors expose their native read-only tool sets: write- and network-capable tools (CRG refactor/wiki/embed, Graphify PR tools) are denied in every condition, per the read-only policy. The tool-count asymmetry (1 / 7 / 23 offered tools; ≈ 70 / 950 / 6,200 schema tokens per turn) is intended, since each tool is used as it ships, and is reported. Optional sixth arm, if budget allows: `agentic:custom_graph`.

### Single-shot protocol (secondary, cheap)

One model call, no tools: the bug report plus one method's native retrieved context (the exact contexts from exp. 1's frozen held-out runs) at 2k and 8k budgets. CRG's neutral clone path `/tmp/cgbench/w/` is rewritten to `/workspace/app/` so the context carries no benchmark hint. Methods: ripgrep, BM25, embeddings, Graphify, CRG, custom_graph, hybrid. Bounds: `none` (repository file list only) and `oracle` (the ground-truth relevant symbols, shuffled).

## Outcome measures (automatic; no LLM judge)

`src/agent-eval/scoring.ts`, tested on all 20 tasks (perfect = 1, right function but wrong line = partial, wrong = 0):

- **Primary: RC+line@1.** The top candidate resolves (same normaliser as exp. 1) to the root-cause symbol **and** its line range overlaps the mutated lines of the bug patch (±2 lines). The range earns line credit only if it is no wider than the defective declaration + 10 lines. Reported paths are normalised: workspace-absolute paths, `./`, and a trailing `:line` are accepted.
- **Secondary.**
  - RC@1 and RC@3 (right function).
  - Line@1 and Line@3.
  - File@1.
  - Valid-output rate.
- **Efficiency.** All are taken from Claude Code's own `result` event, never estimated where a measurement exists.
  - Total tokens/run: input, output, cache-read and cache-write, kept separate.
  - `total_cost_usd`. This is Claude Code's client-side estimate, not authoritative billing.
  - Wall-clock latency (process spawn to result).
  - Number of turns, tool calls by tool, and retrieval calls.
- **Derived.** RC+line@1 per dollar, and tokens per correct diagnosis.
- Cost of retrieval itself: index build time per workspace (`index_build_ms`) and MCP server start-up (`mcp_startup_ms`), reported separately from the agent's tokens. Latency is reported as wall time and as Claude Code's `duration_api_ms` (model time).

## Analysis plan

- Per condition: mean of task-level means with a seeded bootstrap 95% CI.
- Paired comparisons for H1a, H1b, H1c and H2 (paired bootstrap over tasks, 5,000 resamples, seed 4321), with W/L/T counts.
- The confirmatory family is H1a, H1b, H1c-2k, H1c-8k, H2-tokens and H2-cost (6 one-sided tests), with Holm–Bonferroni correction at α = 0.05 (`analysis.ts::confirmatoryReport`). Everything else is exploratory.
- Power: with 14 tasks, the independent audit's simulation gives 61–96% power for a 0.25 accuracy difference, depending on how heterogeneous the per-task differences are. Smaller effects are unlikely to be detected. A null result is reported as "no effect large enough to detect", not "no effect".
- Repeat agreement (the fraction of tasks whose primary outcome is identical across repeats) is reported as a stochasticity check.
- Efficiency comparisons are reported both unconditionally and restricted to tasks where both conditions are correct.

## Threats and controls

- **Leakage.** Workspaces contain one snapshot, no history and no dataset; file tools are confined to the cwd (a forbidden absolute-path read is tested). Paths are opaque. The agent never sees task ids.
- **Memorisation.** The model may know the upstream boilerplate. This affects all conditions equally; reported as a limitation.
- **Prompt bias.** Prompts are identical across conditions and frozen after the dev pilot. Nothing is tuned per method.
- **Stochasticity.** There is no temperature control in `claude -p`, hence 3 repeats on test.
- **Isolation drift.** Every run records the `system/init` fingerprint (tools, MCP servers and status, skills, plugins). A run whose fingerprint differs from its condition's expected set is killed and excluded; two consecutive identical exclusions halt the experiment.
- **Infrastructure failures.** API, rate-limit, auth and usage-limit errors, crashes and timeouts are excluded, never scored as wrong. Each is retried at most once. Three consecutive failures, or any auth or usage-limit error, halt the experiment. Excluded runs are reported.
- **Spend control.** Per-run `--max-budget-usd` is required. A run starts only if spent + in-flight × per-run cap + per-run cap ≤ the approved total. The ledger records both Claude Code's `total_cost_usd` and a recomputation at list prices, and uses the larger. Runs are resumable (completed runs are skipped), and an interrupt kills every child process group.
- **Competitor fairness.** Native MCP servers, default settings, graphs built on the identical workspace. CRG's absolute paths are opaque per workspace.
- **Same-author bias.** An independent Sonnet audit of this protocol and the harness happens before approval is requested (`AUDIT.md`).

## Staged execution (each billable stage needs explicit approval)

0. **Free validation (done before asking):** mock agents, a local Qwen3-1.7B for single-shot prompts, and a mock Anthropic API that records exactly what Claude Code would send (isolation report).
1. **Smoke pilot (billable, tiny):** 2 dev tasks × 5 agentic conditions × 1 repeat, plus single-shot on 2 dev tasks. Verifies real isolation (init event), parse rates and real per-run cost.
2. **Dev pilot (billable, small):** all 6 dev tasks. Prompts are frozen afterwards; real costs replace the estimate's assumptions.
3. **Main run (billable):** 14 test tasks × conditions × 3 repeats, with a hard cumulative cost cap enforced by the harness.
