| Condition | tasks | RC+line@1 [95% CI] | RC@1 | RC@3 | Line@1 | File@1 | Valid | Tokens/run | Cost/run (USD) | Latency p50 (ms) | Turns | Retrieval calls | RC+line@1 per $ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| agentic:baseline | 2 | 0.00 [0.00–0.00] | 0.00 | 0.00 | 0.00 | 0.50 | 1.00 | 21,614 | 0.0196 | 381 | 5.00 | 0.00 | 0.00 |
| agentic:crg | 2 | 0.00 [0.00–0.00] | 0.00 | 0.00 | 0.00 | 0.50 | 1.00 | 56,101 | 0.0241 | 1,441 | 6.00 | 1.00 | 0.00 |
| agentic:embeddings | 2 | 0.00 [0.00–0.00] | 0.00 | 0.00 | 0.00 | 0.50 | 1.00 | 30,464 | 0.0256 | 5,505 | 6.00 | 1.00 | 0.00 |
| agentic:graphify | 2 | 0.00 [0.00–0.00] | 0.00 | 0.00 | 0.00 | 0.50 | 1.00 | 34,633 | 0.0259 | 1,169 | 6.00 | 1.00 | 0.00 |
| agentic:hybrid | 2 | 0.00 [0.00–0.00] | 0.00 | 0.00 | 0.00 | 0.50 | 1.00 | 36,205 | 0.0308 | 5,437 | 6.00 | 1.00 | 0.00 |

Paired differences vs `agentic:baseline` (per-task means over repeats; Δ = condition − reference):

| Condition | Δ RC+line@1 [95% CI] | Δ tokens/run | Δ cost/run | W/L/T |
|---|---:|---:|---:|---:|
| agentic:crg | 0.00 [0.00, 0.00] | 34,488 | 0.0045 | 0/0/2 |
| agentic:embeddings | 0.00 [0.00, 0.00] | 8,850 | 0.0061 | 0/0/2 |
| agentic:graphify | 0.00 [0.00, 0.00] | 13,020 | 0.0063 | 0/0/2 |
| agentic:hybrid | 0.00 [0.00, 0.00] | 14,592 | 0.0113 | 0/0/2 |
