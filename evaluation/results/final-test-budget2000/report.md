# Run final-test-budget2000

split=test · tasks=14 · files=170 · commit=per-task snapshots (base aec082a504bd42b67bb0f7cf663ae65dc1bbad13) · budget={"maxResults":50,"maxContextTokens":2000} · dataset=v1.0
tokenizer: o200k_base (js-tiktoken 1.0.21) — proxy for Claude tokens

## Accuracy (symbol level unless noted; mean [95% bootstrap CI])

| Method | n | Recall@5 | Recall@10 | Precision@5 | Precision@10 | RC Acc@1 | RC Acc@5 | RC MRR | File Recall@10 | RC file Acc@1 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ripgrep | 14 | 0.15 [0.02–0.32] | 0.21 [0.07–0.38] | 0.09 | 0.06 | 0.07 | 0.14 | 0.13 [0.02–0.30] | 0.47 | 0.07 |
| bm25 | 14 | 0.24 [0.10–0.40] | 0.35 [0.18–0.52] | 0.13 | 0.10 | 0.14 | 0.29 | 0.22 [0.06–0.42] | 0.51 | 0.21 |
| embeddings | 14 | 0.27 [0.15–0.39] | 0.45 [0.26–0.64] | 0.16 | 0.13 | 0.21 | 0.50 | 0.35 [0.16–0.56] | 0.66 | 0.36 |
| graphify | 14 | 0.06 [0.00–0.13] | 0.08 [0.02–0.15] | 0.04 | 0.03 | 0.00 | 0.07 | 0.05 [0.00–0.12] | 0.46 | 0.00 |
| code_review_graph | 14 | 0.08 [0.00–0.18] | 0.11 [0.00–0.23] | 0.04 | 0.03 | 0.00 | 0.14 | 0.05 [0.00–0.10] | 0.41 | 0.07 |
| custom_graph | 14 | 0.50 [0.32–0.68] | 0.58 [0.38–0.77] | 0.30 | 0.18 | 0.21 | 0.64 | 0.34 [0.16–0.55] | 0.69 | 0.36 |
| hybrid | 14 | 0.49 [0.33–0.65] | 0.64 [0.49–0.80] | 0.30 | 0.20 | 0.21 | 0.64 | 0.38 [0.20–0.58] | 0.71 | 0.29 |

## Token efficiency

| Method | Native ctx tokens (mean / median) | Uniform top-10 tokens | Recall@10 per 1k uniform tok | Native recall per 1k native tok | Tokens-to-root-cause (median, found) | TTR mean (cap 16k) | RC found in results | Recall@1k tok | Recall@2k tok | Recall@4k tok | Recall@8k tok | Latency p50 (ms) | Retrieval LLM tokens |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ripgrep | 1,938 / 1,967 | 1,658 | 0.13 | 0.14 | 782 | 10,740 | 0.36 | 0.20 | 0.23 | 0.26 | 0.27 | 20 | 0 |
| bm25 | 1,845 / 1,888 | 1,259 | 0.27 | 0.21 | 381 | 9,345 | 0.43 | 0.30 | 0.38 | 0.39 | 0.39 | 4 | 0 |
| embeddings | 1,861 / 1,901 | 1,128 | 0.40 | 0.28 | 497 | 6,096 | 0.64 | 0.35 | 0.53 | 0.53 | 0.53 | 47 | 0 |
| graphify | 1,534 / 1,660 | 1,235 | 0.06 | 0.23 | 1,571 | 12,322 | 0.29 | 0.08 | 0.21 | 0.27 | 0.33 | 239 | 0 |
| code_review_graph | 5,052 / 4,473 | 1,460 | 0.07 | 0.06 | 1,728 | 11,927 | 0.29 | 0.11 | 0.17 | 0.27 | 0.29 | 14 | 0 |
| custom_graph | 1,921 / 1,935 | 1,890 | 0.31 | 0.31 | 460 | 6,094 | 0.64 | 0.47 | 0.55 | 0.60 | 0.60 | 50 | 0 |
| hybrid | 1,910 / 1,953 | 1,814 | 0.35 | 0.34 | 565 | 5,047 | 0.71 | 0.38 | 0.61 | 0.64 | 0.64 | 14 | 0 |

## Indexing (one-time)

| Method | Index/build ms | Index LLM tokens | Embedding tokens | Nodes/chunks | Edges |
|---|---:|---:|---:|---:|---:|
| ripgrep | 0 | 0 | — | — | — |
| bm25 | 89 | 0 | — | 728 | — |
| embeddings | 75 | 0 | 59234 | 728 | — |
| graphify | 1,505 | 0 | — | 1176 | 2748 |
| code_review_graph | 549 | 0 | — | 637 | 4291 |
| custom_graph | 1,739 | 0 | — | 2670 | 8618 |
| hybrid | 187 | 0 | 59234 | — | — |

## Paired differences vs hybrid (Recall@10)

| method | Δ = hybrid − method (sym_recall_10) | 95% CI | P(Δ≤0) |
|---|---:|---:|---:|
| ripgrep | 0.43 | [0.26, 0.62] | 0.00 |
| bm25 | 0.30 | [0.20, 0.40] | 0.00 |
| embeddings | 0.20 | [0.04, 0.36] | 0.01 |
| graphify | 0.57 | [0.39, 0.74] | 0.00 |
| code_review_graph | 0.54 | [0.37, 0.71] | 0.00 |
| custom_graph | 0.06 | [-0.03, 0.15] | 0.11 |

## Paired differences vs hybrid (root-cause MRR)

| method | Δ = hybrid − method (rc_mrr) | 95% CI | P(Δ≤0) |
|---|---:|---:|---:|
| ripgrep | 0.25 | [0.02, 0.47] | 0.02 |
| bm25 | 0.16 | [-0.04, 0.37] | 0.06 |
| embeddings | 0.03 | [-0.23, 0.29] | 0.41 |
| graphify | 0.34 | [0.12, 0.54] | 0.00 |
| code_review_graph | 0.34 | [0.17, 0.51] | 0.00 |
| custom_graph | 0.04 | [-0.15, 0.25] | 0.37 |

## Per-task root-cause rank (— = not in returned results)

| task | ripgrep | bm25 | embeddings | graphify | code_review_graph | custom_graph | hybrid |
|---|---:|---:|---:|---:|---:|---:|---:|
| auth_jwt_secret_01 | 7 | — | — | — | — | — | — |
| auth_reset_sessions_01 | — | — | 4 | 16 | 5 | 2 | 1 |
| auth_uniform_login_01 | — | 1 | 1 | — | — | 4 | 2 |
| files_local_path_01 | — | 9 | 2 | — | 19 | 1 | 3 |
| files_photo_url_01 | — | 3 | 1 | — | — | — | 6 |
| files_presigned_size_01 | 7 | 1 | 2 | 15 | 15 | 1 | 1 |
| mail_new_email_link_01 | — | — | 2 | 2 | — | 4 | — |
| roles_admin_guard_01 | — | — | 8 | — | — | — | — |
| session_password_change_01 | — | — | — | — | — | — | — |
| users_create_provider_01 | — | — | — | — | — | 5 | 3 |
| users_list_page_01 | 2 | 6 | — | 49 | — | 3 | 5 |
| users_mapper_lastname_01 | — | — | — | — | — | 4 | 3 |
| users_photo_cleared_01 | 12 | — | 18 | — | — | — | 1 |
| utils_has_next_page_01 | 1 | 2 | 1 | — | 3 | 1 | 2 |

## Per-task Recall@10

| task | ripgrep | bm25 | embeddings | graphify | code_review_graph | custom_graph | hybrid |
|---|---:|---:|---:|---:|---:|---:|---:|
| auth_jwt_secret_01 | 0.50 | 0 | 0 | 0 | 0 | 0.50 | 0.50 |
| auth_reset_sessions_01 | 0 | 0.33 | 0.67 | 0.33 | 0.67 | 0.67 | 0.67 |
| auth_uniform_login_01 | 0 | 0.67 | 0.33 | 0 | 0 | 1 | 1 |
| files_local_path_01 | 0 | 0.67 | 1 | 0 | 0 | 1 | 1 |
| files_photo_url_01 | 0 | 0.33 | 0.33 | 0 | 0 | 0.33 | 0.67 |
| files_presigned_size_01 | 0.33 | 0.67 | 1 | 0 | 0.33 | 0.67 | 0.67 |
| mail_new_email_link_01 | 0 | 0 | 0.33 | 0.33 | 0 | 0.67 | 0.33 |
| roles_admin_guard_01 | 0 | 0 | 0.67 | 0 | 0 | 0 | 0.33 |
| session_password_change_01 | 0.25 | 0.25 | 0 | 0 | 0 | 0 | 0.25 |
| users_create_provider_01 | 0 | 0.25 | 0.25 | 0.25 | 0 | 1 | 1 |
| users_list_page_01 | 0.67 | 0.67 | 0.67 | 0 | 0 | 1 | 1 |
| users_mapper_lastname_01 | 0.17 | 0 | 0 | 0.17 | 0 | 0.33 | 0.33 |
| users_photo_cleared_01 | 0 | 0 | 0 | 0 | 0 | 0 | 0.25 |
| utils_has_next_page_01 | 1 | 1 | 1 | 0 | 0.50 | 1 | 1 |
