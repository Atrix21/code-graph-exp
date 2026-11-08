# Run m1-dev-baselines

split=dev · tasks=6 · files=170 · commit=per-task snapshots (base aec082a504bd42b67bb0f7cf663ae65dc1bbad13) · budget={"maxResults":50,"maxContextTokens":8000} · dataset=v1.0
tokenizer: o200k_base (js-tiktoken 1.0.21) — proxy for Claude tokens

## Accuracy (symbol level unless noted; mean [95% bootstrap CI])

| Method | n | Recall@5 | Recall@10 | Precision@5 | Precision@10 | RC Acc@1 | RC Acc@5 | RC MRR | File Recall@10 | RC file Acc@1 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ripgrep | 6 | 0.32 [0.17–0.49] | 0.50 [0.33–0.71] | 0.23 | 0.18 | 0.00 | 0.33 | 0.20 [0.04–0.37] | 0.60 | 0.00 |
| bm25 | 6 | 0.26 [0.14–0.38] | 0.50 [0.33–0.71] | 0.20 | 0.18 | 0.17 | 0.17 | 0.22 [0.03–0.55] | 0.69 | 0.17 |
| embeddings | 6 | 0.39 [0.19–0.58] | 0.61 [0.42–0.79] | 0.30 | 0.23 | 0.00 | 0.33 | 0.20 [0.04–0.36] | 0.83 | 0.00 |
| graphify | 6 | 0.14 [0.04–0.25] | 0.24 [0.04–0.46] | 0.10 | 0.08 | 0.00 | 0.00 | 0.03 [0.00–0.06] | 0.60 | 0.17 |
| code_review_graph | 6 | 0.06 [0.00–0.17] | 0.31 [0.10–0.53] | 0.03 | 0.12 | 0.00 | 0.00 | 0.02 [0.00–0.05] | 0.64 | 0.17 |

## Token efficiency

| Method | Native ctx tokens (mean / median) | Uniform top-10 tokens | Recall@10 per 1k uniform tok | Native recall per 1k native tok | Tokens-to-root-cause (median, found) | TTR mean (cap 16k) | RC found in results | Recall@1k tok | Recall@2k tok | Recall@4k tok | Recall@8k tok | Latency p50 (ms) | Retrieval LLM tokens |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ripgrep | 3,673 / 3,727 | 1,929 | 0.26 | 0.16 | 1,116 | 6,249 | 0.67 | 0.32 | 0.42 | 0.58 | 0.58 | 21 | 0 |
| bm25 | 7,731 / 7,802 | 1,388 | 0.36 | 0.09 | 1,372 | 6,153 | 0.67 | 0.26 | 0.50 | 0.67 | 0.67 | 10 | 0 |
| embeddings | 6,606 / 6,271 | 1,299 | 0.47 | 0.12 | 1,092 | 4,039 | 0.83 | 0.44 | 0.67 | 0.67 | 0.79 | 52 | 0 |
| graphify | 7,957 / 6,134 | 610 | 0.39 | 0.07 | 1,524 | 9,103 | 0.50 | 0.28 | 0.50 | 0.50 | 0.58 | 228 | 0 |
| code_review_graph | 7,857 / 8,588 | 1,416 | 0.22 | 0.06 | 3,014 | 11,671 | 0.33 | 0.18 | 0.35 | 0.40 | 0.46 | 13 | 0 |

## Indexing (one-time)

| Method | Index/build ms | Index LLM tokens | Embedding tokens | Nodes/chunks | Edges |
|---|---:|---:|---:|---:|---:|
| ripgrep | 0 | 0 | — | — | — |
| bm25 | 84 | 0 | — | 728 | — |
| embeddings | 73 | 0 | 59229 | 728 | — |
| graphify | 1,436 | 0 | — | 1176 | 2748 |
| code_review_graph | 512 | 0 | — | 637 | 4291 |

## Paired differences vs ripgrep (Recall@10)

| method | Δ = ripgrep − method (sym_recall_10) | 95% CI | P(Δ≤0) |
|---|---:|---:|---:|
| bm25 | 0.00 | [-0.13, 0.13] | 0.64 |
| embeddings | -0.11 | [-0.38, 0.15] | 0.80 |
| graphify | 0.26 | [0.14, 0.38] | 0.00 |
| code_review_graph | 0.19 | [-0.04, 0.42] | 0.06 |

## Paired differences vs ripgrep (root-cause MRR)

| method | Δ = ripgrep − method (rc_mrr) | 95% CI | P(Δ≤0) |
|---|---:|---:|---:|
| bm25 | -0.02 | [-0.26, 0.21] | 0.64 |
| embeddings | 0.00 | [-0.20, 0.21] | 0.48 |
| graphify | 0.17 | [0.00, 0.34] | 0.02 |
| code_review_graph | 0.18 | [0.03, 0.35] | 0.00 |

## Per-task root-cause rank (— = not in returned results)

| task | ripgrep | bm25 | embeddings | graphify | code_review_graph |
|---|---:|---:|---:|---:|---:|
| auth_refresh_expiry_01 | 8 | 7 | 23 | 12 | 23 |
| auth_reset_link_reuse_01 | 2 | 1 | 2 | — | 13 |
| auth_social_link_01 | 10 | 7 | 2 | 13 | — |
| auth_update_email_dup_01 | 2 | 16 | 31 | — | — |
| session_refresh_replay_01 | — | — | — | — | — |
| users_update_noop_01 | — | — | 8 | 40 | — |

## Per-task Recall@10

| task | ripgrep | bm25 | embeddings | graphify | code_review_graph |
|---|---:|---:|---:|---:|---:|
| auth_refresh_expiry_01 | 1 | 1 | 0.67 | 0.67 | 0.33 |
| auth_reset_link_reuse_01 | 0.50 | 0.50 | 1 | 0.50 | 0.75 |
| auth_social_link_01 | 0.25 | 0.50 | 0.50 | 0 | 0 |
| auth_update_email_dup_01 | 0.50 | 0.25 | 0.25 | 0 | 0.25 |
| session_refresh_replay_01 | 0.50 | 0.50 | 0.50 | 0.25 | 0.50 |
| users_update_noop_01 | 0.25 | 0.25 | 0.75 | 0 | 0 |
