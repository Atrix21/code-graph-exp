| Condition | tasks | RC+line@1 [95% CI] | RC@1 | RC@3 | Line@1 | File@1 | Valid | Tokens/run | Cost/run (USD) | Latency p50 (ms) | Turns | Retrieval calls | RC+line@1 per $ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| agentic:baseline | 1 | 0.00 [0.00–0.00] | 0.00 | 0.00 | 0.00 | 1.00 | 1.00 | 2,334 | 0.0016 | 330 | 2.00 | 0.00 | 0.00 |
| agentic:crg | 1 | 0.00 [0.00–0.00] | 0.00 | 0.00 | 0.00 | 1.00 | 1.00 | 8,641 | 0.0024 | 1,821 | 2.00 | 0.00 | 0.00 |
| agentic:embeddings | 1 | 0.00 [0.00–0.00] | 0.00 | 0.00 | 0.00 | 1.00 | 1.00 | 2,402 | 0.0016 | 1,160 | 2.00 | 0.00 | 0.00 |
| agentic:graphify | 1 | 0.00 [0.00–0.00] | 0.00 | 0.00 | 0.00 | 1.00 | 1.00 | 3,279 | 0.0017 | 1,057 | 2.00 | 0.00 | 0.00 |
| agentic:hybrid | 1 | 0.00 [0.00–0.00] | 0.00 | 0.00 | 0.00 | 1.00 | 1.00 | 2,400 | 0.0016 | 1,226 | 2.00 | 0.00 | 0.00 |

Paired differences vs `agentic:baseline` (per-task means over repeats; Δ = condition − reference):

| Condition | Δ RC+line@1 [95% CI] | Δ tokens/run | Δ cost/run | W/L/T |
|---|---:|---:|---:|---:|
| agentic:crg | 0.00 [0.00, 0.00] | 6,307 | 0.0008 | 0/0/1 |
| agentic:embeddings | 0.00 [0.00, 0.00] | 68 | 0.0000 | 0/0/1 |
| agentic:graphify | 0.00 [0.00, 0.00] | 945 | 0.0001 | 0/0/1 |
| agentic:hybrid | 0.00 [0.00, 0.00] | 66 | 0.0000 | 0/0/1 |
