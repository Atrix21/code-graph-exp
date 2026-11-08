# Run m2-dev

split=dev · tasks=6 · files=170 · commit=per-task snapshots (base aec082a504bd42b67bb0f7cf663ae65dc1bbad13) · budget={"maxResults":50,"maxContextTokens":8000} · dataset=v1.0
tokenizer: o200k_base (js-tiktoken 1.0.21) — proxy for Claude tokens

## Accuracy (symbol level unless noted; mean [95% bootstrap CI])

| Method | n | Recall@5 | Recall@10 | Precision@5 | Precision@10 | RC Acc@1 | RC Acc@5 | RC MRR | File Recall@10 | RC file Acc@1 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| custom_graph | 6 | 0.54 [0.33–0.79] | 0.67 [0.46–0.83] | 0.40 | 0.25 | 0.33 | 0.50 | 0.44 [0.11–0.83] | 0.92 | 0.67 |
| hybrid | 6 | 0.63 [0.42–0.83] | 0.67 [0.50–0.83] | 0.47 | 0.25 | 0.50 | 0.67 | 0.57 [0.24–0.89] | 0.92 | 0.67 |

## Token efficiency

| Method | Native ctx tokens (mean / median) | Uniform top-10 tokens | Recall@10 per 1k uniform tok | Native recall per 1k native tok | Tokens-to-root-cause (median, found) | TTR mean (cap 16k) | RC found in results | Recall@1k tok | Recall@2k tok | Recall@4k tok | Recall@8k tok | Latency p50 (ms) | Retrieval LLM tokens |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| custom_graph | 5,847 / 5,850 | 2,541 | 0.26 | 0.17 | 1,600 | 3,352 | 1.00 | 0.50 | 0.63 | 0.83 | 0.96 | 70 | 0 |
| hybrid | 6,505 / 6,606 | 2,757 | 0.24 | 0.15 | 497 | 3,428 | 0.83 | 0.58 | 0.67 | 0.75 | 0.96 | 71 | 0 |

## Indexing (one-time)

| Method | Index/build ms | Index LLM tokens | Embedding tokens | Nodes/chunks | Edges |
|---|---:|---:|---:|---:|---:|
| custom_graph | 1,672 | 0 | — | 2669 | 8618 |
| hybrid | 178 | 0 | 59229 | — | — |

## Paired differences vs hybrid (Recall@10)

| method | Δ = hybrid − method (sym_recall_10) | 95% CI | P(Δ≤0) |
|---|---:|---:|---:|
| custom_graph | 0.00 | [-0.17, 0.17] | 0.60 |

## Paired differences vs hybrid (root-cause MRR)

| method | Δ = hybrid − method (rc_mrr) | 95% CI | P(Δ≤0) |
|---|---:|---:|---:|
| custom_graph | 0.13 | [-0.07, 0.47] | 0.27 |

## Per-task root-cause rank (— = not in returned results)

| task | custom_graph | hybrid |
|---|---:|---:|
| auth_refresh_expiry_01 | 2 | 3 |
| auth_reset_link_reuse_01 | 14 | 1 |
| auth_social_link_01 | 1 | 1 |
| auth_update_email_dup_01 | 1 | 1 |
| session_refresh_replay_01 | 46 | — |
| users_update_noop_01 | 43 | 12 |

## Per-task Recall@10

| task | custom_graph | hybrid |
|---|---:|---:|
| auth_refresh_expiry_01 | 1 | 1 |
| auth_reset_link_reuse_01 | 0.75 | 1 |
| auth_social_link_01 | 0.75 | 0.50 |
| auth_update_email_dup_01 | 0.50 | 0.50 |
| session_refresh_replay_01 | 0.75 | 0.50 |
| users_update_noop_01 | 0.25 | 0.50 |
