# Experiment 2: dev pilot report

Generated 2026-11-08T16:18:00.415Z by `src/agent-eval/final-report.ts` from the run directories (no model calls). Model claude-sonnet-5-5, effort high, Claude Code restricted-oauth profile; RC+line@1 = right function and its mutated lines, top candidate.

## Run status

| Run | Status | Scored runs | Excluded (not scored) | Pending |
|---|---|---:|---|---:|
| stage2-agentic-dev-p2 | completed | 30 | 0 | 0 |
| stage1-agentic-dev | completed | 10 | 0 | 0 |
| stage2-agentic-dev-p1 | completed | 20 | 0 | 0 |
| stage1-single-dev-2000 | completed | 18 | 0 | 0 |
| stage2-single-dev-2000 | completed | 36 | 0 | 0 |
| stage1-single-dev-8000 | completed | 18 | 0 | 0 |
| stage2-single-dev-8000 | completed | 36 | 0 | 0 |

Cumulative list-price spend (all stages, spend-ledger.jsonl): $6.04 over 169 billable runs (subscription billing; Claude Code's estimate or our list recomputation, whichever is higher).

## Confirmatory family (Holm over 6; agentic tests on the p2 arm)

| ID | Hypothesis | n tasks | A | B | Improvement [95% CI] | W/L/T | p (one-sided) | Holm-adjusted | Supported at α=0.05 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| H1a | agentic hybrid > agentic baseline (RC+line@1) | 6 | 1.00 | 1.00 | 0.00 [0.00, 0.00] | 0/0/6 | 1.000 | 1.000 | no |
| H1b | agentic hybrid > agentic embeddings (RC+line@1) | 6 | 1.00 | 1.00 | 0.00 [0.00, 0.00] | 0/0/6 | 1.000 | 1.000 | no |
| H1c-2k | single-shot hybrid > embeddings @2k (RC+line@1) | 6 | 0.33 | 0.67 | -0.33 [-0.67, 0.00] | 0/2/4 | 1.000 | 1.000 | no |
| H1c-8k | single-shot hybrid > embeddings @8k (RC+line@1) | 6 | 0.67 | 0.67 | 0.00 [-0.50, 0.50] | 1/1/4 | 0.630 | 1.000 | no |
| H2-tokens | agentic hybrid uses fewer tokens/run than baseline | 6 | 18,602 | 23,040 | 4,438 [-491, 9,720] | 4/2/0 | 0.047 | 0.284 | no |
| H2-cost | agentic hybrid costs less/run than baseline | 6 | 0.0311 | 0.0291 | -0.0020 [-0.0101, 0.0057] | 4/2/0 | 0.674 | 1.000 | no |

Exploratory efficiency (not part of the confirmatory family):

| ID | Comparison | n | A | B | Improvement [95% CI] | W/L/T |
|---|---|---:|---:|---:|---:|---:|
| E-tokens-both-correct | tokens/run, tasks where both are correct | 6 | 18,602 | 23,040 | 4,438 [-491, 9,720] | 4/2/0 |
| E-latency | latency/run | 6 | 10,655 | 15,132 | 4,478 [136, 9,775] | 4/2/0 |
| E-turns | turns/run | 6 | 4 | 6 | 3 [1, 4] | 5/0/1 |

Repeat agreement (share of tasks whose primary outcome is identical across repeats): agentic:embeddings — · agentic:baseline — · agentic:crg — · agentic:graphify — · agentic:hybrid — · single:none@2000 — · single:ripgrep@2000 — · single:bm25@2000 — · single:embeddings@2000 — · single:graphify@2000 — · single:code_review_graph@2000 — · single:custom_graph@2000 — · single:hybrid@2000 — · single:oracle@2000 — · single:none@8000 — · single:ripgrep@8000 — · single:bm25@8000 — · single:embeddings@8000 — · single:graphify@8000 — · single:code_review_graph@8000 — · single:custom_graph@8000 — · single:hybrid@8000 — · single:oracle@8000 —

## Agentic, p2 (directed to the MCP tool when attached)

| Condition | tasks | RC+line@1 [95% CI] | RC@1 | RC@3 | Line@1 | File@1 | Valid | Tokens/run | Cost/run (USD) | Latency p50 (ms) | Turns | Retrieval calls | RC+line@1 per $ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| agentic:baseline | 6 | 1.00 [1.00–1.00] | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 23,040 | 0.0291 | 14,335 | 6.33 | 0.00 | 34.38 |
| agentic:crg | 6 | 1.00 [1.00–1.00] | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 63,108 | 0.0315 | 13,292 | 6.00 | 0.00 | 31.71 |
| agentic:embeddings | 6 | 1.00 [1.00–1.00] | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 16,040 | 0.0273 | 10,239 | 3.50 | 0.67 | 36.62 |
| agentic:graphify | 6 | 1.00 [1.00–1.00] | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 30,516 | 0.0284 | 12,849 | 6.00 | 0.00 | 35.21 |
| agentic:hybrid | 6 | 1.00 [1.00–1.00] | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 18,602 | 0.0311 | 11,558 | 3.83 | 0.67 | 32.12 |

Paired differences vs `agentic:baseline` (per-task means over repeats; Δ = condition − reference):

| Condition | Δ RC+line@1 [95% CI] | Δ tokens/run | Δ cost/run | W/L/T |
|---|---:|---:|---:|---:|
| agentic:crg | 0.00 [0.00, 0.00] | 40,068 | 0.0025 | 0/0/6 |
| agentic:embeddings | 0.00 [0.00, 0.00] | -7,000 | -0.0018 | 0/0/6 |
| agentic:graphify | 0.00 [0.00, 0.00] | 7,476 | -0.0007 | 0/0/6 |
| agentic:hybrid | 0.00 [0.00, 0.00] | -4,438 | 0.0020 | 0/0/6 |

| ID | Comparison | n tasks | A | B | Improvement [95% CI] | W/L/T | p (one-sided, uncorrected) |
|---|---|---:|---:|---:|---:|---:|---:|
| p2-H1a | hybrid > baseline (RC+line@1) | 6 | 1.00 | 1.00 | 0.00 [0.00, 0.00] | 0/0/6 | 1.000 |
| p2-H1b | hybrid > embeddings (RC+line@1) | 6 | 1.00 | 1.00 | 0.00 [0.00, 0.00] | 0/0/6 | 1.000 |
| p2-H2-tokens | hybrid fewer tokens than baseline | 6 | 18,602 | 23,040 | 4,438 [-491, 9,720] | 4/2/0 | 0.047 |
| p2-H2-cost | hybrid cheaper than baseline | 6 | 0.0311 | 0.0291 | -0.0020 [-0.0101, 0.0057] | 4/2/0 | 0.674 |
| p2-E-latency | hybrid faster than baseline (wall) | 6 | 10,655 | 15,132 | 4,478 [136, 9,775] | 4/2/0 | 0.013 |
| p2-E-turns | hybrid fewer turns than baseline | 6 | 3.83 | 6.33 | 2.50 [1.00, 4.17] | 5/0/1 | 0.000 |
| p2-E-emb-tokens | embeddings fewer tokens than baseline | 6 | 16,040 | 23,040 | 7,000 [1,460, 11,784] | 5/1/0 | 0.007 |
| p2-RQ3-graphify-acc | graphify vs baseline (RC+line@1) | 6 | 1.00 | 1.00 | 0.00 [0.00, 0.00] | 0/0/6 | 1.000 |
| p2-RQ3-crg-acc | crg vs baseline (RC+line@1) | 6 | 1.00 | 1.00 | 0.00 [0.00, 0.00] | 0/0/6 | 1.000 |
| p2-RQ3-graphify-tokens | graphify fewer tokens than baseline | 6 | 30,516 | 23,040 | -7,476 [-10,767, -5,072] | 0/6/0 | 1.000 |
| p2-RQ3-crg-tokens | crg fewer tokens than baseline | 6 | 63,108 | 23,040 | -40,068 [-48,697, -31,998] | 0/6/0 | 1.000 |
| p2-RQ3-crg-cost | crg cheaper than baseline | 6 | 0.0315 | 0.0291 | -0.0025 [-0.0051, 0.0001] | 2/4/0 | 0.969 |

## Agentic, p1 (natural tool choice; secondary)

| Condition | tasks | RC+line@1 [95% CI] | RC@1 | RC@3 | Line@1 | File@1 | Valid | Tokens/run | Cost/run (USD) | Latency p50 (ms) | Turns | Retrieval calls | RC+line@1 per $ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| agentic-p1:baseline | 6 | 1.00 [1.00–1.00] | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 21,236 | 0.0292 | 10,188 | 6.00 | 0.00 | 34.21 |
| agentic-p1:crg | 6 | 1.00 [1.00–1.00] | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 69,613 | 0.0441 | 14,813 | 6.00 | 0.00 | 22.67 |
| agentic-p1:embeddings | 6 | 1.00 [1.00–1.00] | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 23,228 | 0.0288 | 14,731 | 6.00 | 0.00 | 34.69 |
| agentic-p1:graphify | 6 | 1.00 [1.00–1.00] | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 29,213 | 0.0339 | 17,094 | 5.67 | 0.00 | 29.54 |
| agentic-p1:hybrid | 6 | 1.00 [1.00–1.00] | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 24,331 | 0.0263 | 11,849 | 6.00 | 0.00 | 38.00 |

Paired differences vs `agentic-p1:baseline` (per-task means over repeats; Δ = condition − reference):

| Condition | Δ RC+line@1 [95% CI] | Δ tokens/run | Δ cost/run | W/L/T |
|---|---:|---:|---:|---:|
| agentic-p1:crg | 0.00 [0.00, 0.00] | 48,378 | 0.0149 | 0/0/6 |
| agentic-p1:embeddings | 0.00 [0.00, 0.00] | 1,992 | -0.0004 | 0/0/6 |
| agentic-p1:graphify | 0.00 [0.00, 0.00] | 7,977 | 0.0046 | 0/0/6 |
| agentic-p1:hybrid | 0.00 [0.00, 0.00] | 3,095 | -0.0029 | 0/0/6 |

| ID | Comparison | n tasks | A | B | Improvement [95% CI] | W/L/T | p (one-sided, uncorrected) |
|---|---|---:|---:|---:|---:|---:|---:|
| p1-H1a | hybrid > baseline (RC+line@1) | 6 | 1.00 | 1.00 | 0.00 [0.00, 0.00] | 0/0/6 | 1.000 |
| p1-H1b | hybrid > embeddings (RC+line@1) | 6 | 1.00 | 1.00 | 0.00 [0.00, 0.00] | 0/0/6 | 1.000 |
| p1-H2-tokens | hybrid fewer tokens than baseline | 6 | 24,331 | 21,236 | -3,095 [-9,064, -14] | 1/5/0 | 0.983 |
| p1-H2-cost | hybrid cheaper than baseline | 6 | 0.0263 | 0.0292 | 0.0029 [-0.0025, 0.0093] | 5/1/0 | 0.161 |
| p1-E-latency | hybrid faster than baseline (wall) | 6 | 12,362 | 10,831 | -1,530 [-3,599, 423] | 2/4/0 | 0.930 |
| p1-E-turns | hybrid fewer turns than baseline | 6 | 6.00 | 6.00 | 0.00 [-0.50, 0.50] | 1/1/4 | 0.656 |
| p1-E-emb-tokens | embeddings fewer tokens than baseline | 6 | 23,228 | 21,236 | -1,992 [-5,545, 82] | 1/5/0 | 0.957 |
| p1-RQ3-graphify-acc | graphify vs baseline (RC+line@1) | 6 | 1.00 | 1.00 | 0.00 [0.00, 0.00] | 0/0/6 | 1.000 |
| p1-RQ3-crg-acc | crg vs baseline (RC+line@1) | 6 | 1.00 | 1.00 | 0.00 [0.00, 0.00] | 0/0/6 | 1.000 |
| p1-RQ3-graphify-tokens | graphify fewer tokens than baseline | 6 | 29,213 | 21,236 | -7,977 [-10,551, -5,461] | 0/6/0 | 1.000 |
| p1-RQ3-crg-tokens | crg fewer tokens than baseline | 6 | 69,613 | 21,236 | -48,377 [-53,181, -41,761] | 0/6/0 | 1.000 |
| p1-RQ3-crg-cost | crg cheaper than baseline | 6 | 0.0441 | 0.0292 | -0.0149 [-0.0284, -0.0060] | 0/6/0 | 1.000 |

## Tool adoption (pre-specified secondary)

| Condition | runs | used a retrieval tool | calls/run | tokens/run (used / not used) | turns/run (used / not used) | RC+line@1 (used / not used) |
|---|---:|---:|---:|---:|---:|---:|
| agentic-p1:crg | 6 | 0.00 | 0.00 | — / 69,613 | — / 6.00 | — / 1.00 |
| agentic-p1:embeddings | 6 | 0.00 | 0.00 | — / 23,228 | — / 6.00 | — / 1.00 |
| agentic-p1:graphify | 6 | 0.00 | 0.00 | — / 29,213 | — / 5.67 | — / 1.00 |
| agentic-p1:hybrid | 6 | 0.00 | 0.00 | — / 24,331 | — / 6.00 | — / 1.00 |
| agentic:crg | 6 | 0.00 | 0.00 | — / 63,108 | — / 6.00 | — / 1.00 |
| agentic:embeddings | 6 | 0.67 | 0.67 | 16,543 / 15,033 | 3.25 / 4.00 | 1.00 / 1.00 |
| agentic:graphify | 6 | 0.00 | 0.00 | — / 30,516 | — / 6.00 | — / 1.00 |
| agentic:hybrid | 6 | 0.67 | 0.67 | 21,617 / 12,571 | 4.00 / 3.50 | 1.00 / 1.00 |

## Single-shot (one call, no tools, one method's retrieved context)

### 2,000-token budget

| Condition | tasks | RC+line@1 [95% CI] | RC@1 | RC@3 | Line@1 | File@1 | Valid | Tokens/run | Cost/run (USD) | Latency p50 (ms) | Turns | Retrieval calls | RC+line@1 per $ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| single:bm25@2000 | 6 | 0.50 [0.17–0.83] | 0.83 | 0.83 | 0.50 | 0.83 | 1.00 | 5,708 | 0.0252 | 11,877 | 1.00 | 0.00 | 19.84 |
| single:code_review_graph@2000 | 6 | 0.33 [0.00–0.67] | 0.50 | 0.67 | 0.33 | 0.50 | 1.00 | 18,730 | 0.0679 | 12,201 | 1.00 | 0.00 | 4.91 |
| single:custom_graph@2000 | 6 | 0.50 [0.17–0.83] | 0.67 | 0.83 | 0.50 | 0.67 | 1.00 | 5,949 | 0.0256 | 7,117 | 1.00 | 0.00 | 19.53 |
| single:embeddings@2000 | 6 | 0.67 [0.33–1.00] | 0.83 | 0.83 | 0.67 | 0.83 | 1.00 | 6,598 | 0.0248 | 8,222 | 1.00 | 0.00 | 26.86 |
| single:graphify@2000 | 6 | 0.50 [0.17–0.83] | 0.67 | 0.67 | 0.50 | 0.83 | 1.00 | 6,635 | 0.0278 | 10,395 | 1.00 | 0.00 | 18.01 |
| single:hybrid@2000 | 6 | 0.33 [0.00–0.67] | 0.67 | 0.83 | 0.33 | 0.67 | 1.00 | 5,680 | 0.0235 | 7,019 | 1.00 | 0.00 | 14.19 |
| single:none@2000 | 6 | 0.00 [0.00–0.00] | 0.67 | 0.67 | 0.00 | 0.83 | 1.00 | 6,120 | 0.0275 | 10,355 | 1.00 | 0.00 | 0.00 |
| single:oracle@2000 | 6 | 0.83 [0.50–1.00] | 1.00 | 1.00 | 0.83 | 1.00 | 1.00 | 4,381 | 0.0151 | 5,453 | 1.00 | 0.00 | 55.25 |
| single:ripgrep@2000 | 6 | 0.50 [0.17–0.83] | 0.67 | 0.67 | 0.67 | 0.83 | 1.00 | 7,207 | 0.0279 | 11,157 | 1.00 | 0.00 | 17.91 |

Paired differences vs `single:none@2000` (per-task means over repeats; Δ = condition − reference):

| Condition | Δ RC+line@1 [95% CI] | Δ tokens/run | Δ cost/run | W/L/T |
|---|---:|---:|---:|---:|
| single:bm25@2000 | 0.50 [0.17, 0.83] | -412 | -0.0023 | 3/0/3 |
| single:code_review_graph@2000 | 0.33 [0.00, 0.67] | 12,610 | 0.0404 | 2/0/4 |
| single:custom_graph@2000 | 0.50 [0.17, 0.83] | -171 | -0.0019 | 3/0/3 |
| single:embeddings@2000 | 0.67 [0.33, 1.00] | 478 | -0.0027 | 4/0/2 |
| single:graphify@2000 | 0.50 [0.17, 0.83] | 515 | 0.0003 | 3/0/3 |
| single:hybrid@2000 | 0.33 [0.00, 0.67] | -440 | -0.0040 | 2/0/4 |
| single:oracle@2000 | 0.83 [0.50, 1.00] | -1,739 | -0.0124 | 5/0/1 |
| single:ripgrep@2000 | 0.50 [0.17, 0.83] | 1,087 | 0.0004 | 3/0/3 |

### 8,000-token budget

| Condition | tasks | RC+line@1 [95% CI] | RC@1 | RC@3 | Line@1 | File@1 | Valid | Tokens/run | Cost/run (USD) | Latency p50 (ms) | Turns | Retrieval calls | RC+line@1 per $ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| single:bm25@8000 | 6 | 0.50 [0.17–0.83] | 0.67 | 0.83 | 0.50 | 0.67 | 1.00 | 16,052 | 0.0651 | 7,513 | 1.00 | 0.00 | 7.68 |
| single:code_review_graph@8000 | 6 | 0.17 [0.00–0.50] | 0.33 | 0.50 | 0.17 | 0.33 | 1.00 | 15,571 | 0.0228 | 10,010 | 1.00 | 0.00 | 7.31 |
| single:custom_graph@8000 | 6 | 0.83 [0.50–1.00] | 1.00 | 1.00 | 0.83 | 1.00 | 1.00 | 17,532 | 0.0578 | 8,886 | 1.00 | 0.00 | 14.42 |
| single:embeddings@8000 | 6 | 0.67 [0.33–1.00] | 0.83 | 0.83 | 0.67 | 0.83 | 1.00 | 16,487 | 0.0589 | 7,779 | 1.00 | 0.00 | 11.32 |
| single:graphify@8000 | 6 | 0.50 [0.17–0.83] | 0.67 | 0.83 | 0.50 | 0.83 | 1.00 | 20,174 | 0.0763 | 14,101 | 1.00 | 0.00 | 6.56 |
| single:hybrid@8000 | 6 | 0.67 [0.33–1.00] | 1.00 | 1.00 | 0.67 | 1.00 | 1.00 | 19,010 | 0.0621 | 7,979 | 1.00 | 0.00 | 10.74 |
| single:none@8000 | 6 | 0.33 [0.00–0.67] | 0.67 | 0.67 | 0.33 | 0.83 | 1.00 | 6,216 | 0.0129 | 9,246 | 1.00 | 0.00 | 25.84 |
| single:oracle@8000 | 6 | 0.83 [0.50–1.00] | 1.00 | 1.00 | 0.83 | 1.00 | 1.00 | 3,682 | 0.0062 | 5,008 | 1.00 | 0.00 | 135.28 |
| single:ripgrep@8000 | 6 | 0.50 [0.17–0.83] | 0.50 | 0.50 | 0.50 | 0.67 | 1.00 | 10,894 | 0.0408 | 10,065 | 1.00 | 0.00 | 12.26 |

Paired differences vs `single:none@8000` (per-task means over repeats; Δ = condition − reference):

| Condition | Δ RC+line@1 [95% CI] | Δ tokens/run | Δ cost/run | W/L/T |
|---|---:|---:|---:|---:|
| single:bm25@8000 | 0.17 [-0.33, 0.67] | 9,837 | 0.0522 | 2/1/3 |
| single:code_review_graph@8000 | -0.17 [-0.50, 0.00] | 9,355 | 0.0099 | 0/1/5 |
| single:custom_graph@8000 | 0.50 [-0.17, 1.00] | 11,317 | 0.0449 | 4/1/1 |
| single:embeddings@8000 | 0.33 [0.00, 0.67] | 10,272 | 0.0460 | 2/0/4 |
| single:graphify@8000 | 0.17 [0.00, 0.50] | 13,959 | 0.0634 | 1/0/5 |
| single:hybrid@8000 | 0.33 [-0.33, 0.83] | 12,795 | 0.0492 | 3/1/2 |
| single:oracle@8000 | 0.50 [0.17, 0.83] | -2,533 | -0.0067 | 3/0/3 |
| single:ripgrep@8000 | 0.17 [-0.33, 0.67] | 4,678 | 0.0279 | 2/1/3 |

Repeat agreement, all conditions: agentic-p1:baseline — · agentic-p1:crg — · agentic-p1:embeddings — · agentic-p1:graphify — · agentic-p1:hybrid — · agentic:baseline — · agentic:crg — · agentic:embeddings — · agentic:graphify — · agentic:hybrid — · single:bm25@2000 — · single:bm25@8000 — · single:code_review_graph@2000 — · single:code_review_graph@8000 — · single:custom_graph@2000 — · single:custom_graph@8000 — · single:embeddings@2000 — · single:embeddings@8000 — · single:graphify@2000 — · single:graphify@8000 — · single:hybrid@2000 — · single:hybrid@8000 — · single:none@2000 — · single:none@8000 — · single:oracle@2000 — · single:oracle@8000 — · single:ripgrep@2000 — · single:ripgrep@8000 —
