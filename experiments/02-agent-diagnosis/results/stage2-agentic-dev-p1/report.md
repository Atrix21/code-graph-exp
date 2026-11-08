| Condition | tasks | RC+line@1 [95% CI] | RC@1 | RC@3 | Line@1 | File@1 | Valid | Tokens/run | Cost/run (USD) | Latency p50 (ms) | Turns | Retrieval calls | RC+line@1 per $ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| agentic:baseline | 4 | 1.00 [1.00–1.00] | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 19,562 | 0.0246 | 10,188 | 5.50 | 0.00 | 40.58 |
| agentic:crg | 4 | 1.00 [1.00–1.00] | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 66,302 | 0.0338 | 16,338 | 5.50 | 0.00 | 29.61 |
| agentic:embeddings | 4 | 1.00 [1.00–1.00] | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 22,276 | 0.0248 | 15,046 | 5.50 | 0.00 | 40.27 |
| agentic:graphify | 4 | 1.00 [1.00–1.00] | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 28,024 | 0.0280 | 18,444 | 5.75 | 0.00 | 35.66 |
| agentic:hybrid | 4 | 1.00 [1.00–1.00] | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 19,769 | 0.0226 | 11,849 | 5.50 | 0.00 | 44.27 |

Paired differences vs `agentic:baseline` (per-task means over repeats; Δ = condition − reference):

| Condition | Δ RC+line@1 [95% CI] | Δ tokens/run | Δ cost/run | W/L/T |
|---|---:|---:|---:|---:|
| agentic:crg | 0.00 [0.00, 0.00] | 46,741 | 0.0091 | 0/0/4 |
| agentic:embeddings | 0.00 [0.00, 0.00] | 2,715 | 0.0002 | 0/0/4 |
| agentic:graphify | 0.00 [0.00, 0.00] | 8,463 | 0.0034 | 0/0/4 |
| agentic:hybrid | 0.00 [0.00, 0.00] | 207 | -0.0021 | 0/0/4 |
