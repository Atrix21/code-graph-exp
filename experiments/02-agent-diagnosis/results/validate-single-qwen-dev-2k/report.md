| Condition | tasks | RC+line@1 [95% CI] | RC@1 | RC@3 | Line@1 | File@1 | Valid | Tokens/run | Cost/run (USD) | Latency p50 (ms) | Turns | Retrieval calls | RC+line@1 per $ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| single:embeddings@2000 | 6 | 0.17 [0.00–0.50] | 0.17 | 0.50 | 0.17 | 0.50 | 1.00 | 2,495 | 0.0000 | 9,167 | 1.00 | 0.00 | — |
| single:hybrid@2000 | 6 | 0.50 [0.17–0.83] | 0.50 | 0.67 | 0.50 | 0.67 | 1.00 | 2,610 | 0.0000 | 10,040 | 1.00 | 0.00 | — |
| single:none@2000 | 6 | 0.00 [0.00–0.00] | 0.00 | 0.17 | 0.00 | 0.17 | 1.00 | 2,362 | 0.0000 | 7,608 | 1.00 | 0.00 | — |
| single:oracle@2000 | 6 | 0.17 [0.00–0.50] | 0.33 | 0.50 | 0.17 | 0.50 | 1.00 | 1,512 | 0.0000 | 8,931 | 1.00 | 0.00 | — |

Paired differences vs `single:none@2000` (per-task means over repeats; Δ = condition − reference):

| Condition | Δ RC+line@1 [95% CI] | Δ tokens/run | Δ cost/run | W/L/T |
|---|---:|---:|---:|---:|
| single:embeddings@2000 | 0.17 [0.00, 0.50] | 133 | 0.0000 | 1/0/5 |
| single:hybrid@2000 | 0.50 [0.17, 0.83] | 247 | 0.0000 | 3/0/3 |
| single:oracle@2000 | 0.17 [0.00, 0.50] | -850 | 0.0000 | 1/0/5 |
