# Approval request: experiment 2 billable stages

Nothing billable has run. Everything below was validated at zero cost, using mock agents, a local Qwen3-1.7B, and a local mock of the Anthropic API driving the real `claude` binary.

## What is ready

- Isolated workspaces: one single-bug snapshot, no git history, opaque paths. Leak probes were all denied (independent audit).
- Read-only agent tools: Read/Grep/Glob plus at most one retrieval MCP server. Your CLAUDE.md, skills, memory, hooks and plugins are verifiably absent from what the model would receive under the `restricted-oauth` profile. A positive control proves the detectors work.
- Per-run `system/init` fingerprint check: a mismatch kills the run before any model request. Infrastructure errors are excluded, not scored. Two or three consecutive failures, or any auth or usage-limit error, halt the experiment.
- Spend control: a required per-run cap; a run starts only if spent + in-flight reservations + its cap ≤ the approved total. The ledger uses the larger of Claude Code's own cost estimate and a list-price recomputation. Runs are resumable, and interrupts kill every child process.
- Automatic scorer, tested on all 20 tasks (no LLM judge). Pre-registered confirmatory analysis with Holm correction.

## Stages (each needs a separate explicit approval)

Estimates use list prices (Sonnet 5.5 $2/$10 per M in/out, Haiku 5.5 $0.10/$0.50). Agentic runs are the uncertain part; stage 1 replaces the assumptions with measurements.

| Stage | What | Runs | Sonnet 5.5 (low / mid / high) | Haiku 5.5 (mid) |
|---|---|---:|---:|---:|
| 1. Smoke pilot | 2 dev tasks × 5 agentic conditions × 1 repeat, plus single-shot on the same 2 tasks (9 contexts × 2 budgets) | 10 + 36 | ≈ $1 / $3 / $9 | < $0.25 |
| 2. Dev pilot | remaining 4 dev tasks, same design; prompts frozen afterwards | 20 + 72 | ≈ $2 / $6 / $18 | < $0.50 |
| 3. Main run | 14 test tasks × 5 agentic conditions × 3 repeats, plus single-shot × 3 repeats | 210 + 756 | ≈ $33 / $78 / $210 | ≈ $4 |

Recommended stage 1 cap: **$5** (Sonnet), with a per-run cap of $1.

## Decisions needed from you

1. **Approve stage 1?** Yes or no.
2. **Model:**
   - **Sonnet 5.5** (recommended): the typical coding-agent model.
   - **Haiku 5.5**: about 20× cheaper. Retrieval may matter more for a weaker model.
   - **Both**: Haiku for every stage, Sonnet for stage 3 only.
3. **Billing path:**
   - **(a) Your current Claude login.** Runs count against your plan's usage limits, and your weekly limit was hit today during development. A limit hit mid-run halts the experiment safely, but stalls it.
   - **(b) An Anthropic API key.** Pay-per-token, independent of your plan limits. You would provide the key via `! export ANTHROPIC_API_KEY=...` in this session; it is never written to disk by the harness.
4. **Cap for stage 1:** recommended $5.

On approval, the lead writes `APPROVAL.json` covering exactly the approved stage, model, split and cap. Nothing outside it can run.
