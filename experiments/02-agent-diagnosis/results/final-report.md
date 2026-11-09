# Experiment 2: main run (test split) report

Generated 2026-11-09T05:14:11.981Z by `src/agent-eval/final-report.ts` from the run directories (no model calls). Model claude-sonnet-5-5, effort high, Claude Code restricted-oauth profile; RC+line@1 = right function and its mutated lines, top candidate.

## Run status

| Run | Status | Scored runs | Excluded (not scored) | Pending |
|---|---|---:|---|---:|
| stage3-agentic-test-p2 | completed | 210 | usage-limit interruption (re-run) ×3 | 0 |
| stage3-agentic-test-p1 | completed | 210 | usage-limit interruption (re-run) ×1 | 0 |
| stage3-single-test-2000 | completed | 378 | 0 | 0 |
| stage3-single-test-8000 | completed | 378 | 0 | 0 |

Cumulative list-price spend (all stages, spend-ledger.jsonl): $33.99 over 1349 billable runs (subscription billing; Claude Code's estimate or our list recomputation, whichever is higher).

## Confirmatory family (Holm over 6; agentic tests on the p2 arm)

| ID | Hypothesis | n tasks | A | B | Improvement [95% CI] | W/L/T | p (one-sided) | Holm-adjusted | Supported at α=0.05 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| H1a | agentic hybrid > agentic baseline (RC+line@1) | 14 | 1.00 | 1.00 | 0.00 [0.00, 0.00] | 0/0/14 | 1.000 | 1.000 | no |
| H1b | agentic hybrid > agentic embeddings (RC+line@1) | 14 | 1.00 | 1.00 | 0.00 [0.00, 0.00] | 0/0/14 | 1.000 | 1.000 | no |
| H1c-2k | single-shot hybrid > embeddings @2k (RC+line@1) | 14 | 0.71 | 0.64 | 0.07 [-0.10, 0.26] | 2/1/11 | 0.298 | 1.000 | no |
| H1c-8k | single-shot hybrid > embeddings @8k (RC+line@1) | 14 | 0.93 | 0.83 | 0.10 [-0.14, 0.33] | 3/1/10 | 0.258 | 1.000 | no |
| H2-tokens | agentic hybrid uses fewer tokens/run than baseline | 14 | 20,586 | 19,482 | -1,104 [-2,742, 353] | 3/11/0 | 0.921 | 1.000 | no |
| H2-cost | agentic hybrid costs less/run than baseline | 14 | 0.0244 | 0.0219 | -0.0025 [-0.0059, 0.0006] | 6/8/0 | 0.937 | 1.000 | no |

Exploratory efficiency (not part of the confirmatory family):

| ID | Comparison | n | A | B | Improvement [95% CI] | W/L/T |
|---|---|---:|---:|---:|---:|---:|
| E-tokens-both-correct | tokens/run, tasks where both are correct | 14 | 20,586 | 19,482 | -1,104 [-2,742, 353] | 3/11/0 |
| E-latency | latency/run | 14 | 9,954 | 9,297 | -657 [-1,062, -223] | 2/12/0 |
| E-turns | turns/run | 14 | 5 | 5 | 1 [0, 1] | 6/5/3 |

Repeat agreement (share of tasks whose primary outcome is identical across repeats): agentic:crg 1.00 · agentic:graphify 1.00 · agentic:embeddings 1.00 · agentic:baseline 1.00 · agentic:hybrid 1.00 · single:none@2000 0.79 · single:ripgrep@2000 0.64 · single:bm25@2000 0.86 · single:embeddings@2000 0.86 · single:graphify@2000 0.86 · single:code_review_graph@2000 0.79 · single:custom_graph@2000 0.93 · single:hybrid@2000 0.86 · single:oracle@2000 0.86 · single:none@8000 0.57 · single:ripgrep@8000 0.79 · single:bm25@8000 1.00 · single:embeddings@8000 0.93 · single:graphify@8000 0.93 · single:code_review_graph@8000 0.64 · single:custom_graph@8000 0.93 · single:hybrid@8000 1.00 · single:oracle@8000 1.00

## Agentic, p2 (directed to the MCP tool when attached)

| Condition | tasks | RC+line@1 [95% CI] | RC@1 | RC@3 | Line@1 | File@1 | Valid | Tokens/run | Cost/run (USD) | Latency p50 (ms) | Turns | Retrieval calls | RC+line@1 per $ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| agentic:baseline | 14 | 1.00 [1.00–1.00] | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 19,482 | 0.0219 | 9,559 | 5.26 | 0.00 | 45.67 |
| agentic:crg | 14 | 1.00 [1.00–1.00] | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 59,944 | 0.0291 | 9,797 | 5.45 | 0.00 | 34.41 |
| agentic:embeddings | 14 | 1.00 [1.00–1.00] | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 18,945 | 0.0218 | 9,678 | 4.95 | 0.19 | 45.84 |
| agentic:graphify | 14 | 1.00 [1.00–1.00] | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 26,901 | 0.0237 | 10,926 | 5.40 | 0.00 | 42.24 |
| agentic:hybrid | 14 | 1.00 [1.00–1.00] | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 20,586 | 0.0244 | 9,861 | 4.71 | 0.31 | 41.06 |

Paired differences vs `agentic:baseline` (per-task means over repeats; Δ = condition − reference):

| Condition | Δ RC+line@1 [95% CI] | Δ tokens/run | Δ cost/run | W/L/T |
|---|---:|---:|---:|---:|
| agentic:crg | 0.00 [0.00, 0.00] | 40,462 | 0.0072 | 0/0/14 |
| agentic:embeddings | 0.00 [0.00, 0.00] | -537 | -0.0001 | 0/0/14 |
| agentic:graphify | 0.00 [0.00, 0.00] | 7,419 | 0.0018 | 0/0/14 |
| agentic:hybrid | 0.00 [0.00, 0.00] | 1,104 | 0.0025 | 0/0/14 |

| ID | Comparison | n tasks | A | B | Improvement [95% CI] | W/L/T | p (one-sided, uncorrected) |
|---|---|---:|---:|---:|---:|---:|---:|
| p2-H1a | hybrid > baseline (RC+line@1) | 14 | 1.00 | 1.00 | 0.00 [0.00, 0.00] | 0/0/14 | 1.000 |
| p2-H1b | hybrid > embeddings (RC+line@1) | 14 | 1.00 | 1.00 | 0.00 [0.00, 0.00] | 0/0/14 | 1.000 |
| p2-H2-tokens | hybrid fewer tokens than baseline | 14 | 20,586 | 19,482 | -1,104 [-2,742, 353] | 3/11/0 | 0.921 |
| p2-H2-cost | hybrid cheaper than baseline | 14 | 0.0244 | 0.0219 | -0.0025 [-0.0059, 0.0006] | 6/8/0 | 0.937 |
| p2-E-latency | hybrid faster than baseline (wall) | 14 | 9,954 | 9,297 | -657 [-1,062, -223] | 2/12/0 | 0.997 |
| p2-E-turns | hybrid fewer turns than baseline | 14 | 4.71 | 5.26 | 0.55 [0.02, 1.12] | 6/5/3 | 0.021 |
| p2-E-emb-tokens | embeddings fewer tokens than baseline | 14 | 18,945 | 19,482 | 537 [-1,013, 2,275] | 5/9/0 | 0.278 |
| p2-RQ3-graphify-acc | graphify vs baseline (RC+line@1) | 14 | 1.00 | 1.00 | 0.00 [0.00, 0.00] | 0/0/14 | 1.000 |
| p2-RQ3-crg-acc | crg vs baseline (RC+line@1) | 14 | 1.00 | 1.00 | 0.00 [0.00, 0.00] | 0/0/14 | 1.000 |
| p2-RQ3-graphify-tokens | graphify fewer tokens than baseline | 14 | 26,901 | 19,482 | -7,419 [-9,598, -5,470] | 0/14/0 | 1.000 |
| p2-RQ3-crg-tokens | crg fewer tokens than baseline | 14 | 59,944 | 19,482 | -40,462 [-47,468, -34,717] | 0/14/0 | 1.000 |
| p2-RQ3-crg-cost | crg cheaper than baseline | 14 | 0.0291 | 0.0219 | -0.0072 [-0.0105, -0.0046] | 0/14/0 | 1.000 |

## Agentic, p1 (natural tool choice; secondary)

| Condition | tasks | RC+line@1 [95% CI] | RC@1 | RC@3 | Line@1 | File@1 | Valid | Tokens/run | Cost/run (USD) | Latency p50 (ms) | Turns | Retrieval calls | RC+line@1 per $ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| agentic-p1:baseline | 14 | 1.00 [1.00–1.00] | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 19,216 | 0.0223 | 8,715 | 5.33 | 0.00 | 44.89 |
| agentic-p1:crg | 14 | 1.00 [1.00–1.00] | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 60,324 | 0.0301 | 9,941 | 5.48 | 0.00 | 33.28 |
| agentic-p1:embeddings | 14 | 1.00 [1.00–1.00] | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 19,803 | 0.0229 | 9,670 | 5.36 | 0.00 | 43.76 |
| agentic-p1:graphify | 14 | 1.00 [1.00–1.00] | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 26,765 | 0.0247 | 10,100 | 5.64 | 0.00 | 40.42 |
| agentic-p1:hybrid | 14 | 1.00 [1.00–1.00] | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 19,975 | 0.0211 | 10,336 | 5.21 | 0.00 | 47.32 |

Paired differences vs `agentic-p1:baseline` (per-task means over repeats; Δ = condition − reference):

| Condition | Δ RC+line@1 [95% CI] | Δ tokens/run | Δ cost/run | W/L/T |
|---|---:|---:|---:|---:|
| agentic-p1:crg | 0.00 [0.00, 0.00] | 41,109 | 0.0078 | 0/0/14 |
| agentic-p1:embeddings | 0.00 [0.00, 0.00] | 588 | 0.0006 | 0/0/14 |
| agentic-p1:graphify | 0.00 [0.00, 0.00] | 7,550 | 0.0025 | 0/0/14 |
| agentic-p1:hybrid | 0.00 [0.00, 0.00] | 760 | -0.0011 | 0/0/14 |

| ID | Comparison | n tasks | A | B | Improvement [95% CI] | W/L/T | p (one-sided, uncorrected) |
|---|---|---:|---:|---:|---:|---:|---:|
| p1-H1a | hybrid > baseline (RC+line@1) | 14 | 1.00 | 1.00 | 0.00 [0.00, 0.00] | 0/0/14 | 1.000 |
| p1-H1b | hybrid > embeddings (RC+line@1) | 14 | 1.00 | 1.00 | 0.00 [0.00, 0.00] | 0/0/14 | 1.000 |
| p1-H2-tokens | hybrid fewer tokens than baseline | 14 | 19,975 | 19,216 | -760 [-2,320, 658] | 6/8/0 | 0.832 |
| p1-H2-cost | hybrid cheaper than baseline | 14 | 0.0211 | 0.0223 | 0.0011 [0.0001, 0.0022] | 12/2/0 | 0.022 |
| p1-E-latency | hybrid faster than baseline (wall) | 14 | 10,090 | 9,103 | -987 [-1,522, -457] | 4/10/0 | 1.000 |
| p1-E-turns | hybrid fewer turns than baseline | 14 | 5.21 | 5.33 | 0.12 [-0.12, 0.36] | 7/5/2 | 0.176 |
| p1-E-emb-tokens | embeddings fewer tokens than baseline | 14 | 19,803 | 19,216 | -588 [-1,777, 593] | 5/9/0 | 0.835 |
| p1-RQ3-graphify-acc | graphify vs baseline (RC+line@1) | 14 | 1.00 | 1.00 | 0.00 [0.00, 0.00] | 0/0/14 | 1.000 |
| p1-RQ3-crg-acc | crg vs baseline (RC+line@1) | 14 | 1.00 | 1.00 | 0.00 [0.00, 0.00] | 0/0/14 | 1.000 |
| p1-RQ3-graphify-tokens | graphify fewer tokens than baseline | 14 | 26,765 | 19,216 | -7,550 [-9,932, -5,398] | 0/14/0 | 1.000 |
| p1-RQ3-crg-tokens | crg fewer tokens than baseline | 14 | 60,324 | 19,216 | -41,109 [-45,451, -37,324] | 0/14/0 | 1.000 |
| p1-RQ3-crg-cost | crg cheaper than baseline | 14 | 0.0301 | 0.0223 | -0.0078 [-0.0121, -0.0043] | 0/14/0 | 1.000 |

## Tool adoption (pre-specified secondary)

| Condition | runs | used a retrieval tool | calls/run | tokens/run (used / not used) | turns/run (used / not used) | RC+line@1 (used / not used) |
|---|---:|---:|---:|---:|---:|---:|
| agentic-p1:crg | 42 | 0.00 | 0.00 | — / 60,324 | — / 5.48 | — / 1.00 |
| agentic-p1:embeddings | 42 | 0.00 | 0.00 | — / 19,803 | — / 5.36 | — / 1.00 |
| agentic-p1:graphify | 42 | 0.00 | 0.00 | — / 26,765 | — / 5.64 | — / 1.00 |
| agentic-p1:hybrid | 42 | 0.00 | 0.00 | — / 19,975 | — / 5.21 | — / 1.00 |
| agentic:crg | 42 | 0.00 | 0.00 | — / 59,944 | — / 5.45 | — / 1.00 |
| agentic:embeddings | 42 | 0.19 | 0.19 | 18,554 / 19,037 | 4.00 / 5.18 | 1.00 / 1.00 |
| agentic:graphify | 42 | 0.00 | 0.00 | — / 26,901 | — / 5.40 | — / 1.00 |
| agentic:hybrid | 42 | 0.31 | 0.31 | 25,902 / 18,203 | 4.08 / 5.00 | 1.00 / 1.00 |

## Single-shot (one call, no tools, one method's retrieved context)

### 2,000-token budget

| Condition | tasks | RC+line@1 [95% CI] | RC@1 | RC@3 | Line@1 | File@1 | Valid | Tokens/run | Cost/run (USD) | Latency p50 (ms) | Turns | Retrieval calls | RC+line@1 per $ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| single:bm25@2000 | 14 | 0.55 [0.31–0.79] | 0.81 | 0.90 | 0.55 | 0.83 | 1.00 | 6,760 | 0.0164 | 8,739 | 1.00 | 0.00 | 33.44 |
| single:code_review_graph@2000 | 14 | 0.45 [0.21–0.69] | 0.52 | 0.69 | 0.45 | 0.57 | 1.00 | 11,503 | 0.0246 | 9,163 | 1.00 | 0.00 | 18.37 |
| single:custom_graph@2000 | 14 | 0.76 [0.55–0.95] | 0.88 | 0.95 | 0.76 | 0.88 | 1.00 | 6,970 | 0.0151 | 4,889 | 1.00 | 0.00 | 50.32 |
| single:embeddings@2000 | 14 | 0.64 [0.40–0.86] | 0.71 | 0.86 | 0.64 | 0.71 | 1.00 | 6,364 | 0.0137 | 4,597 | 1.00 | 0.00 | 47.00 |
| single:graphify@2000 | 14 | 0.45 [0.21–0.69] | 0.64 | 0.71 | 0.45 | 0.71 | 1.00 | 6,028 | 0.0161 | 9,111 | 1.00 | 0.00 | 28.01 |
| single:hybrid@2000 | 14 | 0.71 [0.50–0.90] | 0.98 | 1.00 | 0.71 | 0.98 | 1.00 | 5,943 | 0.0133 | 5,067 | 1.00 | 0.00 | 53.64 |
| single:none@2000 | 14 | 0.33 [0.12–0.55] | 0.81 | 0.93 | 0.33 | 0.88 | 1.00 | 6,292 | 0.0172 | 9,190 | 1.00 | 0.00 | 19.39 |
| single:oracle@2000 | 14 | 0.83 [0.64–1.00] | 1.00 | 1.00 | 0.83 | 1.00 | 1.00 | 3,558 | 0.0077 | 4,094 | 1.00 | 0.00 | 107.56 |
| single:ripgrep@2000 | 14 | 0.52 [0.31–0.74] | 0.79 | 0.88 | 0.52 | 0.86 | 1.00 | 6,594 | 0.0155 | 8,332 | 1.00 | 0.00 | 33.82 |

Paired differences vs `single:none@2000` (per-task means over repeats; Δ = condition − reference):

| Condition | Δ RC+line@1 [95% CI] | Δ tokens/run | Δ cost/run | W/L/T |
|---|---:|---:|---:|---:|
| single:bm25@2000 | 0.21 [0.02, 0.43] | 468 | -0.0008 | 5/1/8 |
| single:code_review_graph@2000 | 0.12 [-0.14, 0.38] | 5,211 | 0.0074 | 3/3/8 |
| single:custom_graph@2000 | 0.43 [0.19, 0.67] | 678 | -0.0021 | 7/0/7 |
| single:embeddings@2000 | 0.31 [0.12, 0.50] | 72 | -0.0035 | 7/0/7 |
| single:graphify@2000 | 0.12 [-0.02, 0.31] | -264 | -0.0010 | 3/1/10 |
| single:hybrid@2000 | 0.38 [0.14, 0.62] | -349 | -0.0039 | 7/1/6 |
| single:oracle@2000 | 0.50 [0.29, 0.71] | -2,734 | -0.0094 | 10/0/4 |
| single:ripgrep@2000 | 0.19 [-0.02, 0.40] | 302 | -0.0017 | 5/2/7 |

### 8,000-token budget

| Condition | tasks | RC+line@1 [95% CI] | RC@1 | RC@3 | Line@1 | File@1 | Valid | Tokens/run | Cost/run (USD) | Latency p50 (ms) | Turns | Retrieval calls | RC+line@1 per $ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| single:bm25@8000 | 14 | 0.79 [0.57–1.00] | 0.93 | 0.93 | 0.79 | 0.93 | 1.00 | 17,160 | 0.0365 | 4,457 | 1.00 | 0.00 | 21.51 |
| single:code_review_graph@8000 | 14 | 0.45 [0.24–0.67] | 0.55 | 0.69 | 0.45 | 0.60 | 1.00 | 11,056 | 0.0252 | 9,976 | 1.00 | 0.00 | 17.98 |
| single:custom_graph@8000 | 14 | 0.98 [0.93–1.00] | 1.00 | 1.00 | 0.98 | 1.00 | 1.00 | 15,219 | 0.0304 | 4,869 | 1.00 | 0.00 | 32.13 |
| single:embeddings@8000 | 14 | 0.83 [0.64–1.00] | 0.93 | 0.93 | 0.83 | 0.93 | 1.00 | 13,659 | 0.0247 | 4,417 | 1.00 | 0.00 | 33.68 |
| single:graphify@8000 | 14 | 0.76 [0.55–0.95] | 0.79 | 0.86 | 0.76 | 0.86 | 1.00 | 23,217 | 0.0536 | 9,825 | 1.00 | 0.00 | 14.22 |
| single:hybrid@8000 | 14 | 0.93 [0.79–1.00] | 1.00 | 1.00 | 0.93 | 1.00 | 1.00 | 16,719 | 0.0301 | 4,683 | 1.00 | 0.00 | 30.83 |
| single:none@8000 | 14 | 0.31 [0.14–0.50] | 0.76 | 0.86 | 0.31 | 0.83 | 1.00 | 6,445 | 0.0170 | 8,747 | 1.00 | 0.00 | 18.22 |
| single:oracle@8000 | 14 | 0.93 [0.79–1.00] | 1.00 | 1.00 | 0.93 | 1.00 | 1.00 | 3,475 | 0.0077 | 3,756 | 1.00 | 0.00 | 120.09 |
| single:ripgrep@8000 | 14 | 0.57 [0.33–0.81] | 0.81 | 0.86 | 0.64 | 0.88 | 1.00 | 9,829 | 0.0217 | 6,421 | 1.00 | 0.00 | 26.34 |

Paired differences vs `single:none@8000` (per-task means over repeats; Δ = condition − reference):

| Condition | Δ RC+line@1 [95% CI] | Δ tokens/run | Δ cost/run | W/L/T |
|---|---:|---:|---:|---:|
| single:bm25@8000 | 0.48 [0.19, 0.74] | 10,715 | 0.0196 | 9/2/3 |
| single:code_review_graph@8000 | 0.14 [-0.07, 0.36] | 4,611 | 0.0082 | 5/2/7 |
| single:custom_graph@8000 | 0.67 [0.48, 0.83] | 8,774 | 0.0134 | 12/0/2 |
| single:embeddings@8000 | 0.52 [0.33, 0.71] | 7,214 | 0.0078 | 10/0/4 |
| single:graphify@8000 | 0.45 [0.21, 0.69] | 16,772 | 0.0366 | 8/1/5 |
| single:hybrid@8000 | 0.62 [0.38, 0.83] | 10,274 | 0.0131 | 11/1/2 |
| single:oracle@8000 | 0.62 [0.38, 0.83] | -2,970 | -0.0093 | 11/1/2 |
| single:ripgrep@8000 | 0.26 [0.07, 0.45] | 3,384 | 0.0047 | 6/1/7 |

### Exploratory method comparisons (not confirmatory, uncorrected)

| ID | Comparison | n tasks | A | B | Improvement [95% CI] | W/L/T | p (one-sided, uncorrected) |
|---|---|---:|---:|---:|---:|---:|---:|
| X-graph-vs-emb@2000 | custom_graph > embeddings @2000 | 14 | 0.76 | 0.64 | 0.12 [-0.10, 0.36] | 3/2/9 | 0.172 |
| X-graph-vs-hybrid@2000 | custom_graph > hybrid @2000 | 14 | 0.76 | 0.71 | 0.05 [-0.12, 0.21] | 2/1/11 | 0.323 |
| X-hybrid-vs-bm25@2000 | hybrid > bm25 @2000 | 14 | 0.71 | 0.55 | 0.17 [0.00, 0.36] | 3/0/11 | 0.038 |
| X-hybrid-vs-graphify@2000 | hybrid > graphify @2000 | 14 | 0.71 | 0.45 | 0.26 [0.05, 0.50] | 5/1/8 | 0.010 |
| X-hybrid-vs-crg@2000 | hybrid > code_review_graph @2000 | 14 | 0.71 | 0.45 | 0.26 [-0.05, 0.55] | 6/2/6 | 0.043 |
| X-graph-vs-emb@8000 | custom_graph > embeddings @8000 | 14 | 0.98 | 0.83 | 0.14 [-0.02, 0.36] | 3/1/10 | 0.091 |
| X-graph-vs-hybrid@8000 | custom_graph > hybrid @8000 | 14 | 0.98 | 0.93 | 0.05 [0.00, 0.14] | 1/0/13 | 0.351 |
| X-hybrid-vs-bm25@8000 | hybrid > bm25 @8000 | 14 | 0.93 | 0.79 | 0.14 [0.00, 0.36] | 2/0/12 | 0.110 |
| X-hybrid-vs-graphify@8000 | hybrid > graphify @8000 | 14 | 0.93 | 0.76 | 0.17 [0.00, 0.36] | 3/0/11 | 0.036 |
| X-hybrid-vs-crg@8000 | hybrid > code_review_graph @8000 | 14 | 0.93 | 0.45 | 0.48 [0.21, 0.74] | 9/1/4 | 0.000 |

Repeat agreement, all conditions: agentic-p1:baseline 1.00 · agentic-p1:crg 1.00 · agentic-p1:embeddings 1.00 · agentic-p1:graphify 1.00 · agentic-p1:hybrid 1.00 · agentic:baseline 1.00 · agentic:crg 1.00 · agentic:embeddings 1.00 · agentic:graphify 1.00 · agentic:hybrid 1.00 · single:bm25@2000 0.86 · single:bm25@8000 1.00 · single:code_review_graph@2000 0.79 · single:code_review_graph@8000 0.64 · single:custom_graph@2000 0.93 · single:custom_graph@8000 0.93 · single:embeddings@2000 0.86 · single:embeddings@8000 0.93 · single:graphify@2000 0.86 · single:graphify@8000 0.93 · single:hybrid@2000 0.86 · single:hybrid@8000 1.00 · single:none@2000 0.79 · single:none@8000 0.57 · single:oracle@2000 0.86 · single:oracle@8000 1.00 · single:ripgrep@2000 0.64 · single:ripgrep@8000 0.79
