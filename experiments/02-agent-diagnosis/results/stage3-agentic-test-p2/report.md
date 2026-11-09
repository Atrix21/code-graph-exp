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
