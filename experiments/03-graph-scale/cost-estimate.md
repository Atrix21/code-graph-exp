# Experiment 3: cost estimate

Nothing billable has been run for experiment 3. These are estimates for the approval decision. Each figure states its basis.

## 1. Prices and observed baselines

| Item | Value | Source |
|---|---|---|
| Sonnet 5.5 | $2 input / $10 output per MTok, cache read $0.20 (Claude Code itself reports $0.10), 1-hour cache write 2× input | Claude API reference (models.md); E2-D18 |
| Haiku 5.5 | $0.10 / $0.50 per MTok for prompts ≤ 100K tokens, $0.50 / $2.50 above; its tokenizer counts about 30% more tokens | Claude API reference (models.md) |
| Experiment 2 agentic run (Sonnet, 6k-line repository, easy tasks) | ~5 turns, ~19.5k tokens, $0.022 per run | `../02-agent-diagnosis/results/final-report.md` |
| Experiment 2 throughput on the owner's Pro plan | $33.99 list over 1,349 calls used three 5-hour windows (≈ $11 list per window) | E2-D21 |

ESTIMATE, the key assumption: tasks on M and L will take **15–30 turns** and read **10–30 file ranges**. The context then grows to 40–80k tokens, and a run processes about 0.5–1.5M tokens, mostly as cache reads. That is 20–60× experiment 2's runs. Stage 2 exists to replace this assumption with measurements before the main run.

Per-run estimate (list prices):

| Model | Low | Central | High |
|---|---:|---:|---:|
| Sonnet 5.5 | $0.25 | $0.60 | $1.20 |
| Haiku 5.5 | $0.015 | $0.03 | $0.10 (contexts above 100K tokens are billed at 5×; runs are capped at 40 turns) |

## 2. Per stage

| Stage | Runs | List-price estimate | Sequential wall time | Pro 5-hour windows (ESTIMATE) |
|---|---|---:|---|---:|
| 0–1 implementation and retrieval-only evaluation | 0 model calls | $0 | local compute: ≈ 2 h of graph builds, ≈ 1 h of embeddings | 0 |
| 2 pilot (dev; 10 M + 10 L tasks) | Haiku: 5 arms × 20 tasks × 1 = 100. Sonnet sanity: 2 arms × 10 L tasks × 1 = 20 | $8–32 | 4–8 h | 1–3 |
| 3 main (test; 30 M + 30 L tasks) | Haiku: A0–A2 × 60 tasks × 3 repeats = 540, plus A3–A4 × 30 L × 3 = 180. Sonnet: A0, A2 × 30 L × 2 = 120 | Haiku $22–58 + Sonnet $30–144 = **$52–202** | 28–56 h | 5–18 |
| 4 single-shot (no tools) | Haiku: 60 tasks × 9 contexts × 2 budgets × 2 = 2,160 small calls. Sonnet subset (L): 300 | Haiku ≈ $2 + Sonnet ≈ $9 | 3–6 h | ≈ 1 |
| *Minimal alternative to stages 2–3* (L only, Haiku, A0/A1/A2) | 30-run dev pilot + 30 test tasks × 3 arms × 3 repeats = 300 | $9–30 | 10–20 h | 1–3 |
| **Total if every stage runs** | ≈ 3,300 calls | **≈ $70–245** | **≈ 35–70 h** | **≈ 7–22** |

## 3. Subscription implications (not free)

- **How windows were estimated.** The window counts assume plan usage is roughly proportional to list-price cost across models. That is an ASSUMPTION: Anthropic does not publish the exact accounting, and Haiku may weigh differently.
- **Practical effect on Pro.** The Sonnet part of stage 3 alone would occupy the owner's personal Pro plan for roughly 3–13 five-hour windows, which is 1–4 days of gated running. The weekly limit may stop it earlier, and the owner's own Claude Code use shares the same limits.
- **Recommendation.**
  - Approve stage 2 alone first.
  - Run the Haiku part of stage 3 before deciding on the Sonnet part.
  - Consider API-key billing for the Sonnet part if the personal plan should stay usable. The harness supports this (E2-D11).
- **Authoring and audit also use plan usage.** Mining, curating and auditing ~80 tasks with Sonnet sub-agents is not separately billed but consumes the plan running this session. ESTIMATE: 2–5M tokens over 10–20 agent sessions. For scale, the two research agents so far used about 0.15M tokens each.

## 4. Cost controls (reused from experiment 2, all tested)

- **Approval file.** `APPROVAL.json` names the stage, account, billing mode, model, maximum runs, per-run cap and total cap.
- **Per-run and total spend caps,** recorded in an append-only spend ledger.
- **Sequential execution** on the named account, one `claude` process at a time.
- **Halts and resume.** The run halts at once on a usage limit and resumes without counting it as an attempt. It also halts on repeated infrastructure errors or an init-fingerprint mismatch.
- **Mock-API dry runs.** Each new arm is first run against a mock Messages API at zero cost to verify prompts, tools and isolation.
- **New for experiment 3:**
  - a per-run turn cap (40) and a tool-output cap (800 tokens), both frozen;
  - the per-run cap set from stage-2 measurements, not from these estimates.
