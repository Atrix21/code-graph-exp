# Findings: does a richer code graph help agents localise bugs with fewer tokens?

Benchmark: `brocoders/nestjs-boilerplate@9620f159` (NestJS/TypeORM, 170 TS files). 20 injected-bug tasks, each evaluated on its own single-bug snapshot. Dataset v1.0, independently audited, frozen before any comparison. Method configurations were tuned on 6 dev tasks only and frozen. The **headline numbers come from a single run on the 14 held-out test tasks** (`evaluation/results/final-test`). All seven methods got the same bug report, the same snapshot, and a budget of 50 results / 8,000 proxy tokens. No method uses an LLM at index or query time. Means with 95% bootstrap CIs; Δ are paired bootstrap differences. With n = 14, treat everything below as directional.

## A. Executive summary

1. **Our hybrid (exact symbol + BM25 + embeddings, expanded by our type-checked call graph) retrieved more of the code an engineer must read than any baseline.** Recall@10 was 0.67 vs 0.47 for the strongest baseline, embeddings (Δ +0.20 [0.03, 0.36], wins/losses 8/2). Precision@10 was 0.21 vs 0.14 (Δ +0.07 [0.01, 0.13]). It still did so with a quarter of the context budget: at 2k tokens it reached Recall@10 0.64 using **65% fewer native tokens** than embeddings at 8k (1,910 vs 5,475).
2. **It did not significantly improve finding the root cause itself.** Root-cause MRR was 0.40 vs 0.36 (Δ +0.04 [−0.21, 0.29], 7 wins / 7 losses). Root cause in the top 5: 0.64 vs 0.50 (n.s.). Mean tokens read until the root cause: 1,778 vs 3,327 (−47%, CI includes 0).
3. **The advantage comes from one graph capability: call-graph traversal from good seeds.** Disabling traversal drops Recall@10 by 0.24 [−0.40, −0.08] and MRR by 0.24 [−0.45, −0.04]. The control-flow, data-flow, application-level, confidence and framework-inferred (DI dispatch) edges each had no measurable effect inside the hybrid. Structural and data-flow edges have small, borderline effects (≈ −0.04 to −0.05 Recall@10 when removed).
4. **Graphify and Code Review Graph performed poorly in this setting**: Recall@10 0.08 and 0.11; root cause found anywhere in their output on only 4/14 tasks. They are designed to be driven by an LLM agent that picks keywords and follow-up queries. With a raw bug report as input, their identifier-based lexical seeding rarely hits. This says more about the no-agent protocol than about their graphs.
5. **The pre-registered targets were not met for recall** (custom graph Recall@10 0.60 vs target ≥ 0.90; hybrid 0.67 vs ≥ 0.95). They were met for precision (no regression), graph reproducibility (21/21 snapshots byte-identical) and context-token reduction at equal-or-better recall. They were not met for root-cause localisation.

## B. Benchmark comparison (held-out test, n = 14, budget 8k)

| Method | Recall@5 | Recall@10 [95% CI] | Precision@10 | RC Acc@1 | RC Acc@5 | RC MRR [95% CI] | File Recall@10 | RC file Acc@1 | RC found in output |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ripgrep | 0.15 | 0.23 [0.08–0.40] | 0.06 | 0.07 | 0.14 | 0.16 [0.05–0.31] | 0.61 | 0.07 | 0.71 |
| BM25 | 0.24 | 0.40 [0.24–0.57] | 0.12 | 0.14 | 0.29 | 0.24 [0.09–0.44] | 0.59 | 0.21 | 0.86 |
| Embeddings (Qwen3-0.6B) | 0.27 | 0.47 [0.27–0.68] | 0.14 | 0.21 | 0.50 | 0.36 [0.18–0.56] | 0.68 | 0.36 | 0.86 |
| Graphify v0.9.104 | 0.06 | 0.08 [0.02–0.15] | 0.03 | 0.00 | 0.07 | 0.05 [0.00–0.12] | 0.46 | 0.00 | 0.29 |
| Code Review Graph v2.3.9 | 0.08 | 0.11 [0.00–0.23] | 0.03 | 0.00 | 0.14 | 0.05 [0.00–0.10] | 0.41 | 0.07 | 0.29 |
| **custom_graph** (ours, graph only) | **0.50** | 0.60 [0.39–0.79] | 0.19 | 0.21 | 0.64 | 0.35 [0.18–0.56] | 0.72 | 0.36 | 0.93 |
| **hybrid** (ours) | 0.49 | **0.67 [0.52–0.82]** | **0.21** | 0.21 | **0.64** | **0.40 [0.23–0.59]** | **0.78** | 0.29 | **1.00** |

Paired differences (`evaluation/results/final-test/paired-summary.json`):

| Comparison | ΔRecall@10 | ΔRC MRR | ΔPrecision@10 |
|---|---:|---:|---:|
| hybrid − embeddings | **+0.20 [0.03, 0.36]** | +0.04 [−0.21, 0.29] | **+0.07 [0.01, 0.13]** |
| custom_graph − embeddings | +0.13 [−0.07, 0.32] | −0.01 [−0.24, 0.18] | +0.05 [−0.01, 0.12] |
| hybrid − custom_graph | +0.07 [−0.00, 0.15] | +0.05 [−0.14, 0.25] | +0.02 [−0.01, 0.05] |
| custom_graph − Graphify | **+0.52 [0.32, 0.71]** | **+0.31 [0.11, 0.52]** | **+0.16 [0.10, 0.21]** |
| custom_graph − CRG | **+0.49 [0.29, 0.69]** | **+0.31 [0.15, 0.48]** | **+0.16 [0.09, 0.23]** |

Secondary competitor configurations did not change the picture (`final-test-competitor-variants`):

- **Graphify**: default budget 2000 and MCP-default depth 3 gave the same Recall@10 (0.08).
- **CRG**: search-only gave the same Recall@10 (0.11). CRG with its optional embeddings improved to Recall@10 0.27, MRR 0.07.

Dev split (6 tasks, used for tuning, not an unbiased estimate): hybrid Recall@10 0.75, MRR 0.57; embeddings 0.61 / 0.20.

Indexing (one-time, per snapshot, median): BM25 77 ms; embeddings 59k embedding-model tokens (cached per chunk); Graphify 1.4 s; CRG 0.5 s; custom graph 1.6 s (TS program + checker). Index-time LLM tokens: 0 for every method.

## C. Token efficiency

All counts are o200k_base proxy tokens. Retrieval-time LLM tokens are 0 for every method. "Native" = the exact text each tool returns. "Uniform" = each ranked symbol rendered identically, which isolates ranking quality from output format.

| Method | Native tokens (8k budget) | Tokens-to-root-cause, mean (unfound = 16k) | Recall within 1k / 2k / 4k uniform tokens | Recall@10 at a 2k native budget (native tokens) | Native recall per 1k native tokens @2k |
|---|---:|---:|---:|---:|---:|
| ripgrep | 3,908 | 6,292 | 0.23 / 0.26 / 0.36 | 0.21 (1,938) | 0.14 |
| BM25 | 7,043 | 3,958 | 0.34 / 0.43 / 0.67 | 0.35 (1,845) | 0.21 |
| Embeddings | 5,475 | 3,327 | 0.35 / 0.57 / 0.63 | 0.45 (1,861) | 0.28 |
| Graphify | 8,993 (budget is chars/3; overflows) | 12,322 | 0.08 / 0.21 / 0.27 | 0.08 (1,534) | 0.23 |
| CRG | 5,053 (no budget parameter) | 11,927 | 0.11 / 0.17 / 0.27 | 0.11 (5,052) | 0.06 |
| custom_graph | 5,773 | 2,821 | **0.47** / 0.55 / 0.66 | 0.58 (1,921) | 0.31 |
| hybrid | 6,320 | **1,778** | 0.38 / **0.61** / **0.69** | **0.64 (1,910)** | **0.34** |

- **Best accuracy per 1k tokens of delivered context: hybrid** (0.34 recall per 1k native tokens at an equal 2k budget, vs 0.28 for embeddings). Hybrid at 2k beats embeddings at 8k on Recall@10 (+0.17 [0.01, 0.34]) with 65% fewer tokens.
- **On the ranking-only uniform view, embeddings is as efficient or better at the very top.** Its Recall@10 per 1k uniform tokens is 0.39 vs 0.29 for hybrid, because hybrid's top 10 contains more (and longer) call-chain methods. When it finds the root cause, embeddings needs fewer tokens to reach it (median 632 vs 858). The two views answer different questions, so both are reported.
- **Snippet design matters as much as ranking for native tokens.** Rendering ranks 6+ as control-flow skeletons instead of full bodies saves 23% of hybrid's native tokens (all-full 7,757 → default 6,320; all-skeleton 5,661) with identical rankings. Capping at 10 results cuts native tokens to 2,072 (−67%) with unchanged Recall@10.

## D. Graph quality (`research/graph-coverage.md`, `evaluation/results/graph-validation.json`)

On every one of the 21 snapshots:

- Files parsed: 170/170.
- Declared functions extracted: 211/211.
- Imports resolved: 744/744.
- Call sites unresolved: 12 of 1,977 (0.6%, all on `any`-typed values).
- Edges by verification: 93.6% `static_verified`, 6.2% `framework_inferred`, 0.15% `unknown`, 0 ambiguous.
- Build-twice SHA-256 identical (100% reproducible). Builds take 1.4–3.6 s.

Not captured: implicit false branches, `finally`, flow-sensitive data flow (no SSA, locals are not nodes), destructuring writes, string-token providers, and global route prefixes. The repo has no event emitters.

## E. Ablation results (hybrid, frozen config, held-out test; `evaluation/results/ablation-test/ablation-summary*.md`)

| Removed component | ΔRecall@10 [95% CI] | ΔRC MRR [95% CI] | Tokens-to-RC (all = 1,778) |
|---|---:|---:|---:|
| Graph traversal (= graph entirely) | **−0.24 [−0.40, −0.08]** | **−0.24 [−0.45, −0.04]** | 4,385 |
| Structural edges | −0.05 [−0.12, 0.00] | −0.02 [−0.04, 0.00] | 2,332 |
| Data-flow edges | −0.04 [−0.10, 0.00] | +0.01 [−0.04, 0.05] | 1,947 |
| Lexical (BM25 + exact symbol + graph facts) | −0.04 [−0.14, 0.04] | −0.02 [−0.13, 0.12] | 2,523 |
| Semantic (embeddings) | −0.02 [−0.07, 0.00] | +0.01 [−0.13, 0.15] | 2,660 |
| Ranking priors (declaration kind, test-path demotion) | −0.06 [−0.15, 0.04] | −0.01 [−0.05, 0.03] | 2,078 |
| Control-flow edges + CF bonus | 0.00 | +0.07 [−0.02, 0.18] | 1,548 |
| Confidence weighting | 0.00 | +0.02 [−0.00, 0.05] | 1,756 |
| Application-level edges | 0.00 | 0.00 | 1,778 |
| Framework-inferred edges (DI dispatch, roles, config keys; post-freeze analysis) | 0.00 | +0.02 [−0.01, 0.06] | 1,770 |
| Hub damping | 0.00 | −0.00 | 2,426 |

The sweeps (traversal depth, seeds, budget) confirm the same pattern:

- **Depth.** Depth 1, 2 and 3 give the same Recall@10. Depth 1 reaches the root cause with the fewest tokens (1,405).
- **Seeds.** 4, 8 and 16 seeds are within noise (16 seeds: MRR +0.05 [−0.00, 0.15]).
- **Budget.** At 2k, Recall@10 is −0.02 and MRR −0.02 [−0.05, −0.00]. 4k and 16k are equal to 8k.
- **Uniform edge weights.** Recall@10 unchanged, MRR −0.04 (n.s.).

For the graph used alone (custom_graph vs itself):

- traversal off −0.08 [−0.17, 0.00]
- data flow off −0.07 [−0.17, 0.02]
- depth 1 −0.03 [−0.07, 0.00]
- control flow off −0.02 [−0.07, 0.00]
- framework-inferred edges off +0.02

**What created the advantage:** expanding semantically or lexically matched seeds along **type-checker-resolved call edges** (and, weakly, structural containment and data-flow links), so that the route handler, service and repository chain around a bug is retrieved together. **What did not (yet):** control-flow conditions/branches, confidence scores, application-layer roles, and DI dispatch edges as separate signals. Most application edges duplicate CALLS edges once intra-function nodes are projected onto their owning declarations. Nearly all edges have confidence 1, so confidence weighting barely changes anything.

## F. Failure analysis

Per-task root-cause ranks (— = not in the returned output):

| task | overlap | call dist. | rg | BM25 | emb | Graphify | CRG | custom | hybrid |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| auth_jwt_secret_01 | low | 1 | 7 | 23 | 38 | — | — | — | 18 |
| auth_reset_sessions_01 | medium | 0 | 11 | 16 | 4 | 16 | 5 | 2 | 1 |
| auth_uniform_login_01 | high | 1 | 7 | 1 | 1 | — | — | 4 | 2 |
| files_local_path_01 | medium | 0 | 34 | 9 | 2 | — | 19 | 1 | 3 |
| files_photo_url_01 | high | 2 | 25 | 3 | 1 | — | — | 20 | 6 |
| files_presigned_size_01 | high | 0 | 7 | 1 | 2 | 15 | 15 | 1 | 1 |
| mail_new_email_link_01 | medium | 1 | — | 10 | 2 | 2 | — | 4 | 6 |
| roles_admin_guard_01 | medium | 1 | — | — | 8 | — | — | 27 | 19 |
| session_password_change_01 | medium | 2 | — | 25 | 22 | — | — | 41 | 42 |
| users_create_provider_01 | high | 1 | — | — | — | — | — | 5 | 3 |
| users_list_page_01 | medium | 1 | 2 | 6 | 10 | 49 | — | 3 | 5 |
| users_mapper_lastname_01 | medium | 3 | 21 | 29 | — | — | — | 4 | 3 |
| users_photo_cleared_01 | medium | 1 | 12 | 42 | 18 | — | — | 16 | 1 |
| utils_has_next_page_01 | high | 1 | 1 | 2 | 1 | — | 3 | 1 | 2 |

- **Embeddings** is the best single baseline. It is strongest when the report's wording matches the buggy code (high-overlap tasks: MRR 0.70 vs hybrid 0.50; `files_photo_url_01` rank 1 vs 6). It fails when the root cause sits in a mapper or service below the symptom: `users_mapper_lastname_01` (3 hops) and `users_create_provider_01` are not found at all. On tasks with call distance ≥ 1, its Recall@10 is 0.36 vs 0.64 for hybrid.
- **Hybrid / custom graph** win on exactly those multi-hop cases. The recorded graph evidence shows how:
  - `UsersService.create` (rank 3) was reached via `CALLS ← AuthService.register`.
  - The relational `UserMapper.toPersistence` (rank 3) was reached via a data-flow edge, `WRITES → UserEntity.firstName`. This is one of the few places a data-flow edge visibly decided a task.
  - `UsersService.update` (rank 1) was reached via `CALLS ← UsersController.update`.

  They fail when:
  - **The symptom is generic**: `auth_jwt_secret_01`, "every protected route returns 401", where the guard is linked only through the string token `'jwt'`. String-token resolution is unsupported.
  - **The link is a framework-implicit class decorator**: `roles_admin_guard_01`, `@UseGuards(…, RolesGuard)`.
  - **The bug is two repository hops below a busy service method**: `session_password_change_01`, where everything fails.
  - **The bug sits in a decorator callback on a property**: `files_photo_url_01`. Embeddings does better there.
- **Graphify** fails mostly at seeding. Its label-only substring matching on prose reports picks generic labels (`User`, DTO names, `package.json` nodes). Words such as "returns" silently switch on an edge-context filter, and there are no function bodies. The root cause appeared in its output on 4/14 tasks.
- **CRG** fails the same way. Its FTS search ANDs the 12 longest report terms over names and signatures only (no bodies). Prose reports rarely match, so its expansion starts from the wrong nodes (root cause found 4/14). Its optional embeddings help (Recall@10 0.27).
- **ripgrep / BM25** suffer from keyword noise in auth-heavy code, where "token", "user" and "password" appear everywhere. ripgrep never reaches the root cause on 5/14 tasks.

## G. Recommendation

**Continue, but narrow the bet.** The experiment supports one specific claim: *semantic and lexical seeding plus expansion along type-checker-resolved call edges* retrieves the relevant code neighbourhood of a bug better than the best flat retriever, and does it in far less context. That is a measurable, reproducible advantage (Recall@10 +0.20, Precision@10 +0.07, ~65% fewer context tokens at equal-or-better recall). It is cheap: a 1.6 s deterministic build, and no LLM.

It does **not** yet show that the *richer* parts of the graph matter. Control flow, data flow, application roles, confidence and DI dispatch produced no significant gains. It also does not show better root-cause pinpointing than embeddings. Next steps, in order:

1. **Run the downstream agent experiment** (same model, each method's context, measure root-cause identification and real Claude tokens). Set-recall gains only matter if the agent uses the extra call-chain context. This was not run here (D-022): it needs sign-off because it would bill your account and load your global Claude config into the model.
2. **Spend ranking effort on the root cause, not the neighbourhood.** Root-cause MRR is about 0.4 for every good method. Candidates: use control-flow structure as a re-ranker over the retrieved neighbourhood (which conditions guard the reported symptom), rather than as traversal edges.
3. **Scale the evidence.** 14 held-out tasks from one repo leaves wide CIs. Add 2–3 repositories, historical (non-injected) bugs, and agent-rewritten queries for all methods. The last would also give Graphify and CRG the agent they are designed around.
4. **De-prioritise** further control-flow/data-flow/application-edge extraction until a task class demonstrates value. Keep them in the graph (they are cheap and provenance-tagged), but do not market them as the source of the gain.

## Limitations and threats to validity

- **Small n, one codebase.** CIs are wide and several "no effect" findings are underpowered.
- **Label structure favours graphs on Recall.** "Relevant" includes the route→root-cause call path, which call-graph traversal is built to find. Root-cause-only metrics (MRR, Acc@k), where hybrid ≈ embeddings, are the less structurally biased view.
- **Same author for method and harness.** The lead designed both our method and the evaluation. Mitigations: independent ground truth and audit (Agents A/B), an independent harness review whose 2 critical / 3 major findings were all fixed before the held-out run (Agent C), unmodified competitors, and dev-only tuning with frozen configs.
- **A post-freeze bug in the ablation runner.** It evaluated variants on the pristine snapshot. It was caught by a reproducibility cross-check, fixed, and re-run with the same frozen configs (D-023); the invalid runs are kept in `evaluation/results/_invalid/`.
- **Injected bugs, LLM-written reports.** The bugs are realistic mutations, not historical ones, and the reports were written by an LLM agent that knew the bug (mitigated by the leakage audit).
- **No agent in the loop.** Graphify and CRG are designed for agent-driven use, so this protocol under-represents them.
- **Proxy tokenizer.** All token counts use o200k_base, not Claude's tokenizer.
