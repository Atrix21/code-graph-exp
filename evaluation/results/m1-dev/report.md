# Run m1-dev

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
| custom_graph | 6 | 0.46 [0.21–0.71] | 0.63 [0.46–0.83] | 0.33 | 0.23 | 0.00 | 0.50 | 0.15 [0.04–0.27] | 0.88 | 0.17 |
| hybrid | 6 | 0.53 [0.28–0.75] | 0.67 [0.50–0.83] | 0.40 | 0.25 | 0.17 | 0.33 | 0.28 [0.07–0.58] | 0.83 | 0.17 |

## Token efficiency

| Method | Native ctx tokens (mean / median) | Uniform top-10 tokens | Recall@10 per 1k uniform tok | Native recall per 1k native tok | Tokens-to-root-cause (median, found) | TTR mean (cap 16k) | RC found in results | Recall@1k tok | Recall@2k tok | Recall@4k tok | Recall@8k tok | Latency p50 (ms) | Retrieval LLM tokens |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ripgrep | 3,673 / 3,727 | 1,929 | 0.26 | 0.16 | 1,116 | 6,249 | 0.67 | 0.32 | 0.42 | 0.58 | 0.58 | 20 | 0 |
| bm25 | 7,731 / 7,802 | 1,388 | 0.36 | 0.09 | 1,372 | 6,153 | 0.67 | 0.26 | 0.50 | 0.67 | 0.67 | 9 | 0 |
| embeddings | 6,606 / 6,271 | 1,299 | 0.47 | 0.12 | 1,092 | 4,039 | 0.83 | 0.44 | 0.67 | 0.67 | 0.79 | 47 | 0 |
| graphify | 7,957 / 6,134 | 610 | 0.39 | 0.07 | 1,524 | 9,103 | 0.50 | 0.28 | 0.50 | 0.50 | 0.58 | 224 | 0 |
| code_review_graph | 7,857 / 8,588 | 1,416 | 0.22 | 0.06 | 3,014 | 11,671 | 0.33 | 0.18 | 0.35 | 0.40 | 0.46 | 12 | 0 |
| custom_graph | 4,304 / 4,238 | 1,346 | 0.46 | 0.20 | 775 | 6,404 | 0.67 | 0.58 | 0.67 | 0.75 | 0.83 | 58 | 0 |
| hybrid | 6,486 / 6,499 | 1,579 | 0.42 | 0.14 | 845 | 3,630 | 0.83 | 0.58 | 0.67 | 0.75 | 0.92 | 63 | 0 |

## Indexing (one-time)

| Method | Index/build ms | Index LLM tokens | Embedding tokens | Nodes/chunks | Edges |
|---|---:|---:|---:|---:|---:|
| ripgrep | 0 | 0 | — | — | — |
| bm25 | 79 | 0 | — | 728 | — |
| embeddings | 68 | 0 | 59229 | 728 | — |
| graphify | 1,408 | 0 | — | 1176 | 2748 |
| code_review_graph | 503 | 0 | — | 637 | 4291 |
| custom_graph | 1,663 | 0 | — | 2669 | 8618 |
| hybrid | 167 | 0 | 59229 | — | — |

## Paired differences vs hybrid (Recall@10)

| method | Δ = hybrid − method (sym_recall_10) | 95% CI | P(Δ≤0) |
|---|---:|---:|---:|
| ripgrep | 0.17 | [0.04, 0.33] | 0.02 |
| bm25 | 0.17 | [0.04, 0.33] | 0.02 |
| embeddings | 0.06 | [-0.08, 0.21] | 0.28 |
| graphify | 0.43 | [0.35, 0.50] | 0.00 |
| code_review_graph | 0.36 | [0.17, 0.53] | 0.00 |
| custom_graph | 0.04 | [-0.08, 0.17] | 0.38 |

## Paired differences vs hybrid (root-cause MRR)

| method | Δ = hybrid − method (rc_mrr) | 95% CI | P(Δ≤0) |
|---|---:|---:|---:|
| ripgrep | 0.07 | [-0.14, 0.29] | 0.25 |
| bm25 | 0.05 | [0.01, 0.11] | 0.01 |
| embeddings | 0.08 | [-0.07, 0.27] | 0.21 |
| graphify | 0.25 | [0.05, 0.56] | 0.00 |
| code_review_graph | 0.26 | [0.06, 0.55] | 0.00 |
| custom_graph | 0.13 | [-0.09, 0.48] | 0.31 |

## Per-task root-cause rank (— = not in returned results)

| task | ripgrep | bm25 | embeddings | graphify | code_review_graph | custom_graph | hybrid |
|---|---:|---:|---:|---:|---:|---:|---:|
| auth_refresh_expiry_01 | 8 | 7 | 23 | 12 | 23 | 3 | 7 |
| auth_reset_link_reuse_01 | 2 | 1 | 2 | — | 13 | 35 | 1 |
| auth_social_link_01 | 10 | 7 | 2 | 13 | — | 3 | 3 |
| auth_update_email_dup_01 | 2 | 16 | 31 | — | — | 5 | 8 |
| session_refresh_replay_01 | — | — | — | — | — | — | — |
| users_update_noop_01 | — | — | 8 | 40 | — | — | 18 |

## Per-task Recall@10

| task | ripgrep | bm25 | embeddings | graphify | code_review_graph | custom_graph | hybrid |
|---|---:|---:|---:|---:|---:|---:|---:|
| auth_refresh_expiry_01 | 1 | 1 | 0.67 | 0.67 | 0.33 | 1 | 1 |
| auth_reset_link_reuse_01 | 0.50 | 0.50 | 1 | 0.50 | 0.75 | 0.75 | 1 |
| auth_social_link_01 | 0.25 | 0.50 | 0.50 | 0 | 0 | 0.75 | 0.50 |
| auth_update_email_dup_01 | 0.50 | 0.25 | 0.25 | 0 | 0.25 | 0.50 | 0.50 |
| session_refresh_replay_01 | 0.50 | 0.50 | 0.50 | 0.25 | 0.50 | 0.50 | 0.50 |
| users_update_noop_01 | 0.25 | 0.25 | 0.75 | 0 | 0 | 0.25 | 0.50 |
