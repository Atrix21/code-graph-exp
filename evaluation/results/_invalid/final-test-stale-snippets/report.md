# Run final-test

split=test · tasks=14 · files=170 · commit=per-task snapshots (base aec082a504bd42b67bb0f7cf663ae65dc1bbad13) · budget={"maxResults":50,"maxContextTokens":8000} · dataset=v1.0
tokenizer: o200k_base (js-tiktoken 1.0.21) — proxy for Claude tokens

## Accuracy (symbol level unless noted; mean [95% bootstrap CI])

| Method | n | Recall@5 | Recall@10 | Precision@5 | Precision@10 | RC Acc@1 | RC Acc@5 | RC MRR | File Recall@10 | RC file Acc@1 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ripgrep | 14 | 0.15 [0.02–0.32] | 0.23 [0.08–0.40] | 0.09 | 0.06 | 0.07 | 0.14 | 0.16 [0.05–0.31] | 0.61 | 0.07 |
| bm25 | 14 | 0.24 [0.10–0.40] | 0.40 [0.24–0.57] | 0.13 | 0.12 | 0.14 | 0.29 | 0.24 [0.09–0.44] | 0.59 | 0.21 |
| embeddings | 14 | 0.27 [0.15–0.39] | 0.47 [0.27–0.68] | 0.16 | 0.14 | 0.21 | 0.50 | 0.36 [0.18–0.56] | 0.68 | 0.36 |
| graphify | 14 | 0.06 [0.00–0.13] | 0.08 [0.02–0.15] | 0.04 | 0.03 | 0.00 | 0.07 | 0.05 [0.00–0.12] | 0.46 | 0.00 |
| code_review_graph | 14 | 0.08 [0.00–0.18] | 0.11 [0.00–0.23] | 0.04 | 0.03 | 0.00 | 0.14 | 0.05 [0.00–0.10] | 0.41 | 0.07 |
| custom_graph | 14 | 0.50 [0.32–0.68] | 0.60 [0.39–0.79] | 0.30 | 0.19 | 0.21 | 0.64 | 0.35 [0.18–0.56] | 0.72 | 0.36 |
| hybrid | 14 | 0.49 [0.33–0.65] | 0.67 [0.52–0.82] | 0.30 | 0.21 | 0.21 | 0.64 | 0.40 [0.23–0.59] | 0.78 | 0.29 |

## Token efficiency

| Method | Native ctx tokens (mean / median) | Uniform top-10 tokens | Recall@10 per 1k uniform tok | Native recall per 1k native tok | Tokens-to-root-cause (median, found) | TTR mean (cap 16k) | RC found in results | Recall@1k tok | Recall@2k tok | Recall@4k tok | Recall@8k tok | Latency p50 (ms) | Retrieval LLM tokens |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ripgrep | 3,908 / 3,970 | 1,926 | 0.12 | 0.12 | 1,412 | 6,292 | 0.71 | 0.23 | 0.26 | 0.36 | 0.46 | 23 | 0 |
| bm25 | 7,043 / 7,825 | 1,440 | 0.28 | 0.10 | 1,268 | 3,958 | 0.86 | 0.34 | 0.43 | 0.67 | 0.71 | 9 | 0 |
| embeddings | 5,475 / 5,441 | 1,219 | 0.39 | 0.13 | 632 | 3,327 | 0.86 | 0.35 | 0.57 | 0.63 | 0.71 | 48 | 0 |
| graphify | 8,993 / 6,065 | 1,235 | 0.06 | 0.04 | 1,571 | 12,322 | 0.29 | 0.08 | 0.21 | 0.27 | 0.33 | 228 | 0 |
| code_review_graph | 5,054 / 4,474 | 1,460 | 0.07 | 0.06 | 1,728 | 11,927 | 0.29 | 0.11 | 0.17 | 0.27 | 0.29 | 12 | 0 |
| custom_graph | 5,764 / 5,739 | 2,006 | 0.30 | 0.14 | 1,062 | 2,821 | 0.93 | 0.47 | 0.55 | 0.66 | 0.79 | 63 | 0 |
| hybrid | 6,311 / 6,403 | 2,335 | 0.29 | 0.13 | 858 | 1,778 | 1.00 | 0.38 | 0.61 | 0.69 | 0.85 | 29 | 0 |

## Indexing (one-time)

| Method | Index/build ms | Index LLM tokens | Embedding tokens | Nodes/chunks | Edges |
|---|---:|---:|---:|---:|---:|
| ripgrep | 0 | 0 | — | — | — |
| bm25 | 77 | 0 | — | 728 | — |
| embeddings | 69 | 0 | 59234 | 728 | — |
| graphify | 1,396 | 0 | — | 1176 | 2748 |
| code_review_graph | 488 | 0 | — | 637 | 4291 |
| custom_graph | 1,640 | 0 | — | 2670 | 8618 |
| hybrid | 166 | 0 | 59234 | — | — |

## Paired differences vs hybrid (Recall@10)

| method | Δ = hybrid − method (sym_recall_10) | 95% CI | P(Δ≤0) |
|---|---:|---:|---:|
| ripgrep | 0.43 | [0.26, 0.61] | 0.00 |
| bm25 | 0.26 | [0.18, 0.33] | 0.00 |
| embeddings | 0.20 | [0.03, 0.36] | 0.01 |
| graphify | 0.59 | [0.43, 0.76] | 0.00 |
| code_review_graph | 0.56 | [0.39, 0.73] | 0.00 |
| custom_graph | 0.07 | [-0.00, 0.15] | 0.04 |

## Paired differences vs hybrid (root-cause MRR)

| method | Δ = hybrid − method (rc_mrr) | 95% CI | P(Δ≤0) |
|---|---:|---:|---:|
| ripgrep | 0.25 | [0.03, 0.46] | 0.01 |
| bm25 | 0.16 | [-0.03, 0.36] | 0.05 |
| embeddings | 0.04 | [-0.21, 0.29] | 0.38 |
| graphify | 0.36 | [0.16, 0.54] | 0.00 |
| code_review_graph | 0.36 | [0.20, 0.52] | 0.00 |
| custom_graph | 0.05 | [-0.14, 0.25] | 0.32 |

## Per-task root-cause rank (— = not in returned results)

| task | ripgrep | bm25 | embeddings | graphify | code_review_graph | custom_graph | hybrid |
|---|---:|---:|---:|---:|---:|---:|---:|
| auth_jwt_secret_01 | 7 | 23 | 38 | — | — | — | 18 |
| auth_reset_sessions_01 | 11 | 16 | 4 | 16 | 5 | 2 | 1 |
| auth_uniform_login_01 | 7 | 1 | 1 | — | — | 4 | 2 |
| files_local_path_01 | 34 | 9 | 2 | — | 19 | 1 | 3 |
| files_photo_url_01 | 25 | 3 | 1 | — | — | 20 | 6 |
| files_presigned_size_01 | 7 | 1 | 2 | 15 | 15 | 1 | 1 |
| mail_new_email_link_01 | — | 10 | 2 | 2 | — | 4 | 6 |
| roles_admin_guard_01 | — | — | 8 | — | — | 27 | 19 |
| session_password_change_01 | — | 25 | 22 | — | — | 41 | 42 |
| users_create_provider_01 | — | — | — | — | — | 5 | 3 |
| users_list_page_01 | 2 | 6 | 10 | 49 | — | 3 | 5 |
| users_mapper_lastname_01 | 21 | 29 | — | — | — | 4 | 3 |
| users_photo_cleared_01 | 12 | 42 | 18 | — | — | 16 | 1 |
| utils_has_next_page_01 | 1 | 2 | 1 | — | 3 | 1 | 2 |

## Per-task Recall@10

| task | ripgrep | bm25 | embeddings | graphify | code_review_graph | custom_graph | hybrid |
|---|---:|---:|---:|---:|---:|---:|---:|
| auth_jwt_secret_01 | 0.50 | 0 | 0 | 0 | 0 | 0.50 | 0.50 |
| auth_reset_sessions_01 | 0 | 0.33 | 0.67 | 0.33 | 0.67 | 0.67 | 0.67 |
| auth_uniform_login_01 | 0.33 | 0.67 | 0.33 | 0 | 0 | 1 | 1 |
| files_local_path_01 | 0 | 0.67 | 1 | 0 | 0 | 1 | 1 |
| files_photo_url_01 | 0 | 0.33 | 0.33 | 0 | 0 | 0.33 | 0.67 |
| files_presigned_size_01 | 0.33 | 0.67 | 1 | 0 | 0.33 | 0.67 | 0.67 |
| mail_new_email_link_01 | 0 | 0.33 | 0.33 | 0.33 | 0 | 0.67 | 0.67 |
| roles_admin_guard_01 | 0 | 0 | 0.67 | 0 | 0 | 0 | 0.33 |
| session_password_change_01 | 0.25 | 0.25 | 0 | 0 | 0 | 0 | 0.25 |
| users_create_provider_01 | 0 | 0.75 | 0.25 | 0.25 | 0 | 1 | 1 |
| users_list_page_01 | 0.67 | 0.67 | 1 | 0 | 0 | 1 | 1 |
| users_mapper_lastname_01 | 0.17 | 0 | 0 | 0.17 | 0 | 0.50 | 0.33 |
| users_photo_cleared_01 | 0 | 0 | 0 | 0 | 0 | 0 | 0.25 |
| utils_has_next_page_01 | 1 | 1 | 1 | 0 | 0.50 | 1 | 1 |
