# Run final-test-competitor-variants

split=test · tasks=14 · files=170 · commit=per-task snapshots (base aec082a504bd42b67bb0f7cf663ae65dc1bbad13) · budget={"maxResults":50,"maxContextTokens":8000} · dataset=v1.0
tokenizer: o200k_base (js-tiktoken 1.0.21) — proxy for Claude tokens

## Accuracy (symbol level unless noted; mean [95% bootstrap CI])

| Method | n | Recall@5 | Recall@10 | Precision@5 | Precision@10 | RC Acc@1 | RC Acc@5 | RC MRR | File Recall@10 | RC file Acc@1 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| graphify | 14 | 0.06 [0.00–0.13] | 0.08 [0.02–0.15] | 0.04 | 0.03 | 0.00 | 0.07 | 0.05 [0.00–0.12] | 0.46 | 0.00 |
| graphify_budget2000 | 14 | 0.06 [0.00–0.13] | 0.08 [0.02–0.15] | 0.04 | 0.03 | 0.00 | 0.07 | 0.05 [0.00–0.12] | 0.46 | 0.00 |
| graphify_depth3 | 14 | 0.06 [0.00–0.13] | 0.08 [0.02–0.15] | 0.04 | 0.03 | 0.00 | 0.07 | 0.04 [0.00–0.12] | 0.49 | 0.00 |
| code_review_graph | 14 | 0.08 [0.00–0.18] | 0.11 [0.00–0.23] | 0.04 | 0.03 | 0.00 | 0.14 | 0.05 [0.00–0.10] | 0.41 | 0.07 |
| code_review_graph_search_only | 14 | 0.08 [0.00–0.18] | 0.11 [0.00–0.23] | 0.04 | 0.03 | 0.00 | 0.14 | 0.05 [0.00–0.10] | 0.41 | 0.07 |
| code_review_graph_emb | 14 | 0.11 [0.00–0.23] | 0.27 [0.10–0.45] | 0.06 | 0.08 | 0.00 | 0.14 | 0.07 [0.02–0.14] | 0.50 | 0.07 |

## Token efficiency

| Method | Native ctx tokens (mean / median) | Uniform top-10 tokens | Recall@10 per 1k uniform tok | Native recall per 1k native tok | Tokens-to-root-cause (median, found) | TTR mean (cap 16k) | RC found in results | Recall@1k tok | Recall@2k tok | Recall@4k tok | Recall@8k tok | Latency p50 (ms) | Retrieval LLM tokens |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| graphify | 8,993 / 6,065 | 1,235 | 0.06 | 0.04 | 1,571 | 12,322 | 0.29 | 0.08 | 0.21 | 0.27 | 0.33 | 239 | 0 |
| graphify_budget2000 | 1,534 / 1,660 | 1,235 | 0.06 | 0.23 | 1,571 | 12,322 | 0.29 | 0.08 | 0.21 | 0.27 | 0.33 | 240 | 0 |
| graphify_depth3 | 4,483 / 6,163 | 1,220 | 0.06 | 0.07 | 1,046 | 12,825 | 0.21 | 0.08 | 0.18 | 0.29 | 0.31 | 236 | 0 |
| code_review_graph | 5,053 / 4,474 | 1,460 | 0.07 | 0.06 | 1,728 | 11,927 | 0.29 | 0.11 | 0.17 | 0.27 | 0.29 | 13 | 0 |
| code_review_graph_search_only | 2,425 / 2,384 | 1,460 | 0.07 | 0.10 | 1,728 | 11,927 | 0.29 | 0.11 | 0.17 | 0.24 | 0.24 | 6 | 0 |
| code_review_graph_emb | 6,025 / 5,357 | 1,639 | 0.16 | 0.06 | 919 | 10,625 | 0.36 | 0.19 | 0.28 | 0.37 | 0.38 | 37 | 0 |

## Indexing (one-time)

| Method | Index/build ms | Index LLM tokens | Embedding tokens | Nodes/chunks | Edges |
|---|---:|---:|---:|---:|---:|
| graphify | 1,451 | 0 | — | 1176 | 2748 |
| graphify_budget2000 | 1,441 | 0 | — | 1176 | 2748 |
| graphify_depth3 | 1,467 | 0 | — | 1176 | 2748 |
| code_review_graph | 533 | 0 | — | 637 | 4291 |
| code_review_graph_search_only | 558 | 0 | — | 637 | 4291 |
| code_review_graph_emb | 4,943 | 0 | — | 637 | 4291 |

## Paired differences vs graphify (Recall@10)

| method | Δ = graphify − method (sym_recall_10) | 95% CI | P(Δ≤0) |
|---|---:|---:|---:|
| graphify_budget2000 | 0.00 | [0.00, 0.00] | 1.00 |
| graphify_depth3 | 0.00 | [0.00, 0.00] | 1.00 |
| code_review_graph | -0.03 | [-0.15, 0.08] | 0.71 |
| code_review_graph_search_only | -0.03 | [-0.15, 0.08] | 0.71 |
| code_review_graph_emb | -0.19 | [-0.38, -0.02] | 0.99 |

## Paired differences vs graphify (root-cause MRR)

| method | Δ = graphify − method (rc_mrr) | 95% CI | P(Δ≤0) |
|---|---:|---:|---:|
| graphify_budget2000 | 0.00 | [0.00, 0.00] | 1.00 |
| graphify_depth3 | 0.00 | [0.00, 0.00] | 0.34 |
| code_review_graph | -0.00 | [-0.08, 0.10] | 0.54 |
| code_review_graph_search_only | -0.00 | [-0.08, 0.10] | 0.54 |
| code_review_graph_emb | -0.03 | [-0.10, 0.05] | 0.78 |

## Per-task root-cause rank (— = not in returned results)

| task | graphify | graphify_budget2000 | graphify_depth3 | code_review_graph | code_review_graph_search_only | code_review_graph_emb |
|---|---:|---:|---:|---:|---:|---:|
| auth_jwt_secret_01 | — | — | — | — | — | — |
| auth_reset_sessions_01 | 16 | 16 | 16 | 5 | 5 | 7 |
| auth_uniform_login_01 | — | — | — | — | — | — |
| files_local_path_01 | — | — | — | 19 | 19 | 15 |
| files_photo_url_01 | — | — | — | — | — | — |
| files_presigned_size_01 | 15 | 15 | 15 | 15 | 15 | 3 |
| mail_new_email_link_01 | 2 | 2 | 2 | — | — | 6 |
| roles_admin_guard_01 | — | — | — | — | — | — |
| session_password_change_01 | — | — | — | — | — | — |
| users_create_provider_01 | — | — | — | — | — | — |
| users_list_page_01 | 49 | 49 | — | — | — | — |
| users_mapper_lastname_01 | — | — | — | — | — | — |
| users_photo_cleared_01 | — | — | — | — | — | — |
| utils_has_next_page_01 | — | — | — | 3 | 3 | 3 |

## Per-task Recall@10

| task | graphify | graphify_budget2000 | graphify_depth3 | code_review_graph | code_review_graph_search_only | code_review_graph_emb |
|---|---:|---:|---:|---:|---:|---:|
| auth_jwt_secret_01 | 0 | 0 | 0 | 0 | 0 | 0 |
| auth_reset_sessions_01 | 0.33 | 0.33 | 0.33 | 0.67 | 0.67 | 0.67 |
| auth_uniform_login_01 | 0 | 0 | 0 | 0 | 0 | 0 |
| files_local_path_01 | 0 | 0 | 0 | 0 | 0 | 0.67 |
| files_photo_url_01 | 0 | 0 | 0 | 0 | 0 | 0 |
| files_presigned_size_01 | 0 | 0 | 0 | 0.33 | 0.33 | 0.67 |
| mail_new_email_link_01 | 0.33 | 0.33 | 0.33 | 0 | 0 | 0.33 |
| roles_admin_guard_01 | 0 | 0 | 0 | 0 | 0 | 0 |
| session_password_change_01 | 0 | 0 | 0 | 0 | 0 | 0.25 |
| users_create_provider_01 | 0.25 | 0.25 | 0.25 | 0 | 0 | 0 |
| users_list_page_01 | 0 | 0 | 0 | 0 | 0 | 0 |
| users_mapper_lastname_01 | 0.17 | 0.17 | 0.17 | 0 | 0 | 0.17 |
| users_photo_cleared_01 | 0 | 0 | 0 | 0 | 0 | 0 |
| utils_has_next_page_01 | 0 | 0 | 0 | 0.50 | 0.50 | 1 |
