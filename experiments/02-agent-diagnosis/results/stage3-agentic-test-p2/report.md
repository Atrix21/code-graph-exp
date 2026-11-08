| Condition | tasks | RC+line@1 [95% CI] | RC@1 | RC@3 | Line@1 | File@1 | Valid | Tokens/run | Cost/run (USD) | Latency p50 (ms) | Turns | Retrieval calls | RC+line@1 per $ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| agentic:baseline | 12 | 1.00 [1.00–1.00] | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 19,045 | 0.0215 | 10,486 | 5.13 | 0.00 | 46.55 |
| agentic:crg | 12 | 1.00 [1.00–1.00] | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 60,809 | 0.0292 | 10,618 | 5.63 | 0.00 | 34.27 |
| agentic:embeddings | 12 | 1.00 [1.00–1.00] | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 19,212 | 0.0221 | 10,368 | 5.08 | 0.17 | 45.18 |
| agentic:graphify | 9 | 1.00 [1.00–1.00] | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 24,243 | 0.0215 | 10,290 | 5.00 | 0.00 | 46.51 |
| agentic:hybrid | 7 | 1.00 [1.00–1.00] | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 21,716 | 0.0255 | 10,823 | 4.79 | 0.29 | 39.24 |

Paired differences vs `agentic:baseline` (per-task means over repeats; Δ = condition − reference):

| Condition | Δ RC+line@1 [95% CI] | Δ tokens/run | Δ cost/run | W/L/T |
|---|---:|---:|---:|---:|
| agentic:crg | 0.00 [0.00, 0.00] | 35,529 | 0.0043 | 0/0/10 |
| agentic:embeddings | 0.00 [0.00, 0.00] | -946 | -0.0006 | 0/0/10 |
| agentic:graphify | 0.00 [0.00, 0.00] | 2,455 | -0.0007 | 0/0/8 |
| agentic:hybrid | 0.00 [0.00, 0.00] | 1,270 | 0.0020 | 0/0/6 |
