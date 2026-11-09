| Condition | tasks | RC+line@1 [95% CI] | RC@1 | RC@3 | Line@1 | File@1 | Valid | Tokens/run | Cost/run (USD) | Latency p50 (ms) | Turns | Retrieval calls | RC+line@1 per $ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| agentic:baseline | 14 | 1.00 [1.00–1.00] | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 19,216 | 0.0223 | 8,715 | 5.33 | 0.00 | 44.89 |
| agentic:crg | 14 | 1.00 [1.00–1.00] | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 60,324 | 0.0301 | 9,941 | 5.48 | 0.00 | 33.28 |
| agentic:embeddings | 14 | 1.00 [1.00–1.00] | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 19,803 | 0.0229 | 9,670 | 5.36 | 0.00 | 43.76 |
| agentic:graphify | 14 | 1.00 [1.00–1.00] | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 26,765 | 0.0247 | 10,100 | 5.64 | 0.00 | 40.42 |
| agentic:hybrid | 14 | 1.00 [1.00–1.00] | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 19,975 | 0.0211 | 10,336 | 5.21 | 0.00 | 47.32 |

Paired differences vs `agentic:baseline` (per-task means over repeats; Δ = condition − reference):

| Condition | Δ RC+line@1 [95% CI] | Δ tokens/run | Δ cost/run | W/L/T |
|---|---:|---:|---:|---:|
| agentic:crg | 0.00 [0.00, 0.00] | 41,109 | 0.0078 | 0/0/14 |
| agentic:embeddings | 0.00 [0.00, 0.00] | 588 | 0.0006 | 0/0/14 |
| agentic:graphify | 0.00 [0.00, 0.00] | 7,550 | 0.0025 | 0/0/14 |
| agentic:hybrid | 0.00 [0.00, 0.00] | 760 | -0.0011 | 0/0/14 |
