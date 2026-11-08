| Condition | tasks | RC+line@1 [95% CI] | RC@1 | RC@3 | Line@1 | File@1 | Valid | Tokens/run | Cost/run (USD) | Latency p50 (ms) | Turns | Retrieval calls | RC+line@1 per $ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| agentic:baseline | 1 | 0.00 [0.00–0.00] | 0.00 | 0.00 | 0.00 | 1.00 | 1.00 | 2,390 | 0.0016 | 297 | 2.00 | 0.00 | 0.00 |
| agentic:hybrid | 1 | 0.00 [0.00–0.00] | 0.00 | 0.00 | 0.00 | 1.00 | 1.00 | 2,455 | 0.0016 | 1,749 | 2.00 | 0.00 | 0.00 |

Paired differences vs `agentic:baseline` (per-task means over repeats; Δ = condition − reference):

| Condition | Δ RC+line@1 [95% CI] | Δ tokens/run | Δ cost/run | W/L/T |
|---|---:|---:|---:|---:|
| agentic:hybrid | 0.00 [0.00, 0.00] | 65 | 0.0000 | 0/0/1 |
