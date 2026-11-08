| Condition | tasks | RC+line@1 [95% CI] | RC@1 | RC@3 | Line@1 | File@1 | Valid | Tokens/run | Cost/run (USD) | Latency p50 (ms) | Turns | Retrieval calls | RC+line@1 per $ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| agentic:baseline | 2 | 1.00 [1.00–1.00] | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 24,584 | 0.0384 | 11,316 | 7.00 | 0.00 | 26.03 |
| agentic:crg | 2 | 1.00 [1.00–1.00] | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 76,236 | 0.0648 | 12,375 | 7.00 | 0.00 | 15.43 |
| agentic:embeddings | 2 | 1.00 [1.00–1.00] | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 25,132 | 0.0368 | 12,743 | 7.00 | 0.00 | 27.15 |
| agentic:graphify | 2 | 1.00 [1.00–1.00] | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 31,590 | 0.0455 | 12,075 | 5.50 | 0.00 | 21.99 |
| agentic:hybrid | 2 | 1.00 [1.00–1.00] | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 33,455 | 0.0338 | 14,230 | 7.00 | 0.00 | 29.61 |

Paired differences vs `agentic:baseline` (per-task means over repeats; Δ = condition − reference):

| Condition | Δ RC+line@1 [95% CI] | Δ tokens/run | Δ cost/run | W/L/T |
|---|---:|---:|---:|---:|
| agentic:crg | 0.00 [0.00, 0.00] | 51,652 | 0.0264 | 0/0/2 |
| agentic:embeddings | 0.00 [0.00, 0.00] | 548 | -0.0016 | 0/0/2 |
| agentic:graphify | 0.00 [0.00, 0.00] | 7,006 | 0.0071 | 0/0/2 |
| agentic:hybrid | 0.00 [0.00, 0.00] | 8,871 | -0.0047 | 0/0/2 |
