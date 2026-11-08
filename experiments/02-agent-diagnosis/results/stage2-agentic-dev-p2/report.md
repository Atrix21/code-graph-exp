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
