# Run ablation-test-postfreeze

split=test · tasks=14 · files=170 · commit=aec082a504bd42b67bb0f7cf663ae65dc1bbad13 · budget={"maxResults":50,"maxContextTokens":8000} · dataset=v1.0
tokenizer: o200k_base (js-tiktoken 1.0.21) — proxy for Claude tokens

## Accuracy (symbol level unless noted; mean [95% bootstrap CI])

| Method | n | Recall@5 | Recall@10 | Precision@5 | Precision@10 | RC Acc@1 | RC Acc@5 | RC MRR | File Recall@10 | RC file Acc@1 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| hybrid_all | 14 | 0.49 [0.33–0.65] | 0.67 [0.52–0.82] | 0.30 | 0.21 | 0.21 | 0.64 | 0.41 [0.24–0.61] | 0.80 | 0.29 |
| no_framework_inferred_edges | 14 | 0.43 [0.27–0.60] | 0.67 [0.52–0.82] | 0.27 | 0.21 | 0.21 | 0.57 | 0.41 [0.24–0.60] | 0.81 | 0.29 |
| custom_graph_no_framework_inferred_edges | 14 | 0.50 [0.30–0.70] | 0.61 [0.43–0.79] | 0.30 | 0.19 | 0.21 | 0.64 | 0.35 [0.18–0.56] | 0.76 | 0.36 |
| custom_graph | 14 | 0.50 [0.32–0.68] | 0.60 [0.39–0.79] | 0.30 | 0.19 | 0.21 | 0.64 | 0.35 [0.18–0.56] | 0.74 | 0.36 |

## Token efficiency

| Method | Native ctx tokens (mean / median) | Uniform top-10 tokens | Recall@10 per 1k uniform tok | Native recall per 1k native tok | Tokens-to-root-cause (median, found) | TTR mean (cap 16k) | RC found in results | Recall@1k tok | Recall@2k tok | Recall@4k tok | Recall@8k tok | Latency p50 (ms) | Retrieval LLM tokens |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| hybrid_all | 6,325 / 6,404 | 2,337 | 0.29 | 0.14 | 861 | 1,855 | 1.00 | 0.38 | 0.61 | 0.69 | 0.87 | 33 | 0 |
| no_framework_inferred_edges | 6,284 / 6,397 | 2,329 | 0.29 | 0.14 | 959 | 1,945 | 1.00 | 0.38 | 0.57 | 0.69 | 0.85 | 31 | 0 |
| custom_graph_no_framework_inferred_edges | 5,714 / 5,808 | 2,064 | 0.30 | 0.14 | 775 | 2,789 | 0.93 | 0.45 | 0.59 | 0.66 | 0.79 | 25 | 0 |
| custom_graph | 5,766 / 5,739 | 1,972 | 0.30 | 0.14 | 1,062 | 2,818 | 0.93 | 0.47 | 0.55 | 0.66 | 0.82 | 26 | 0 |

## Indexing (one-time)

| Method | Index/build ms | Index LLM tokens | Embedding tokens | Nodes/chunks | Edges |
|---|---:|---:|---:|---:|---:|
| hybrid_all | 290 | 0 | 59230 | — | — |
| no_framework_inferred_edges | 195 | 0 | 59230 | — | — |
| custom_graph_no_framework_inferred_edges | 3,587 | 0 | — | 2670 | 8618 |
| custom_graph | 3,587 | 0 | — | 2670 | 8618 |

## Paired differences vs hybrid_all (Recall@10)

| method | Δ = hybrid_all − method (sym_recall_10) | 95% CI | P(Δ≤0) |
|---|---:|---:|---:|
| no_framework_inferred_edges | 0.00 | [0.00, 0.00] | 1.00 |
| custom_graph_no_framework_inferred_edges | 0.05 | [-0.01, 0.13] | 0.09 |
| custom_graph | 0.07 | [-0.00, 0.15] | 0.04 |

## Paired differences vs hybrid_all (root-cause MRR)

| method | Δ = hybrid_all − method (rc_mrr) | 95% CI | P(Δ≤0) |
|---|---:|---:|---:|
| no_framework_inferred_edges | 0.00 | [0.00, 0.01] | 0.03 |
| custom_graph_no_framework_inferred_edges | 0.06 | [-0.11, 0.25] | 0.27 |
| custom_graph | 0.06 | [-0.11, 0.25] | 0.27 |

## Per-task root-cause rank (— = not in returned results)

| task | hybrid_all | no_framework_inferred_edges | custom_graph_no_framework_inferred_edges | custom_graph |
|---|---:|---:|---:|---:|
| auth_jwt_secret_01 | 31 | 34 | — | — |
| auth_reset_sessions_01 | 1 | 1 | 2 | 2 |
| auth_uniform_login_01 | 2 | 2 | 4 | 4 |
| files_local_path_01 | 2 | 2 | 1 | 1 |
| files_photo_url_01 | 6 | 6 | 20 | 20 |
| files_presigned_size_01 | 1 | 1 | 1 | 1 |
| mail_new_email_link_01 | 6 | 6 | 4 | 4 |
| roles_admin_guard_01 | 21 | 21 | 25 | 25 |
| session_password_change_01 | 37 | 40 | 35 | 41 |
| users_create_provider_01 | 3 | 3 | 4 | 5 |
| users_list_page_01 | 5 | 7 | 3 | 3 |
| users_mapper_lastname_01 | 3 | 3 | 5 | 4 |
| users_photo_cleared_01 | 1 | 1 | 16 | 16 |
| utils_has_next_page_01 | 2 | 2 | 1 | 1 |

## Per-task Recall@10

| task | hybrid_all | no_framework_inferred_edges | custom_graph_no_framework_inferred_edges | custom_graph |
|---|---:|---:|---:|---:|
| auth_jwt_secret_01 | 0.50 | 0.50 | 0.50 | 0.50 |
| auth_reset_sessions_01 | 0.67 | 0.67 | 0.67 | 0.67 |
| auth_uniform_login_01 | 1 | 1 | 1 | 1 |
| files_local_path_01 | 1 | 1 | 1 | 1 |
| files_photo_url_01 | 0.67 | 0.67 | 0.33 | 0.33 |
| files_presigned_size_01 | 0.67 | 0.67 | 0.67 | 0.67 |
| mail_new_email_link_01 | 0.67 | 0.67 | 0.67 | 0.67 |
| roles_admin_guard_01 | 0.33 | 0.33 | 0 | 0 |
| session_password_change_01 | 0.25 | 0.25 | 0.25 | 0 |
| users_create_provider_01 | 1 | 1 | 1 | 1 |
| users_list_page_01 | 1 | 1 | 1 | 1 |
| users_mapper_lastname_01 | 0.33 | 0.33 | 0.50 | 0.50 |
| users_photo_cleared_01 | 0.25 | 0.25 | 0 | 0 |
| utils_has_next_page_01 | 1 | 1 | 1 | 1 |
