# Experiment 3: retrieval architecture proposal

Status: proposal. Everything marked *measured* was run in this session without model calls; everything else is design.

## 1. What is reused unchanged

| Component | File(s) | Reuse at scale |
|---|---|---|
| Graph schema with provenance (type, src, dst, evidence location, extraction method, confidence, verification) | `src/graph/graph-schema.ts` | unchanged; already language-agnostic |
| TypeScript extractor (TS Compiler API + checker; NestJS DI, controllers, repositories) | `src/parser/*`, `src/graph/graph-builder.ts` | *measured*: M (572 files) 24 s / 1.9 GB; L (11,894 files) 97 s / 4.4 GB; 100% of files parsed |
| SQLite graph store | `src/graph/graph-store.ts` | unchanged (L: 1.2 GB SQLite); JSON export now streamed (E3-D05) |
| ripgrep, BM25, embeddings, hybrid, custom graph | `src/retrieval/*` | frozen experiment-1 configs; embeddings reuse the content-hash vector cache, so per-snapshot rebuilds only embed changed chunks |
| Competitor adapters (Graphify, CRG) | `src/competitors/*` | run where their indexers finish on M/L; failure to index is reported, not worked around |
| Metrics, normalisation, paired bootstrap | `src/evaluation/*` | extended with path/impact metrics |
| MCP retrieval server, agent harness (isolation, account binding, usage-limit handling, resumable runs, init fingerprint) | `src/agent-eval/*` | one new tool backend; harness unchanged |

No graph database: SQLite plus in-memory adjacency handled 232k nodes / 860k edges; nothing measured so far needs more.

## 2. Gaps the scale profiles exposed (measured)

These are general gaps, not repository-specific tuning; each fix must be framework-agnostic and is validated on S, M and L together.

1. **Keyed dispatch is invisible to the graph.** Job queues and event buses link producer and consumer through a key (an enum member, a string, or `SomeJob.name`), not a call.
   - Immich has 95 `@OnEvent` and 67 `@OnJob` handlers.
   - Twenty has 129 `@Processor`/`@Process` handlers, 55 `@OnDatabaseBatchEvent`, 10 `@OnCustomBatchEvent` and 16 `@OnEvent`.
   - The extractor produced **0 PUBLISHES_EVENT edges** on both repositories, and 0 (Immich) or 7 (Twenty) CONSUMES_EVENT edges. Every asynchronous multi-stage path, such as upload → metadata → thumbnails → ML in Immich, is therefore cut at each queue hop. These are exactly the cross-module paths the hypothesis is about.
2. **GraphQL entry points are not routes.** Twenty has 245 `@Query` and 358 `@Mutation` resolvers next to 154 REST routes. Its entry-point coverage is therefore mostly missing.
3. **Query builders are not database edges.** Immich uses Kysely (81 `@InjectKysely`) and gets `QUERIES_DATABASE` = 0. Its repository classes are still detected by role (1,706 REPOSITORY_ACCESSES edges).
4. **Unresolved calls without dependencies.** Twenty without `node_modules` and the `twenty-shared` workspace package: 12.2% of call sites unresolved. Immich after installing dependencies: 0.08% (before: 19.3%). Dependencies must be installed for L before stage 1.
5. **Lexical ambiguity grows with scale, unevenly.** A callee's simple name is shared on average by:
   - 6.9 callable declarations in S (p90 15; CRUD names repeat across modules);
   - 4.6 in M (p90 7);
   - **214 in L (p90 318; `execute`, `handle`, `run` across hundreds of command and job classes)**.

   This measures directly what makes grep harder in L, and it is not a monotone function of size.

**Proposed extractor extension (milestone 2): keyed-dispatch edges.**
- **Rule.** When a call argument (or an object-literal property inside one) contains a key expression K, and some declaration's registration (a decorator argument, or a registration call such as `on(K, handler)`) contains the same K, emit PUBLISHES_EVENT (producer → key node) and CONSUMES_EVENT (key node → handler).
- **Matching.** Keys are matched by checker symbol identity for enum members and `Class.name`, and by literal value for strings.
- **Labels.** `extraction: 'keyed-dispatch'`, `verification: framework_inferred`. Confidence is 0.9 for symbol keys and 0.7 for string keys. The key node records every producer and consumer site.
- **Validation.**
  - Matched-pair counts per repository.
  - A precision audit of 50 sampled edges per repository.
  - The unchanged experiment-1 graph hash when no keyed dispatch exists. S has none, so its graph must stay byte-identical.

## 3. Agent-facing interface: compact graph context

### 3.1 Why

In experiment 2, the hybrid tool returned about 4k tokens. Claude Code keeps every tool result in the conversation, so each later turn re-reads it from cache. Per tool result, the cost in input-token equivalents is roughly

`T × (w + r·R)`

where:
- T = result tokens;
- w = cache-write multiplier (2 for the 1-hour cache);
- r = cache-read multiplier (0.05–0.1);
- R = number of later turns.

For T = 4,000 and R = 10, that is about 10–12k input equivalents per call. It explains why tool use saved turns but not tokens. The quantity to minimise is total session effort, so a result should be small, and it should point to code instead of containing it (the agent can Read exact ranges cheaply). The literature agrees that bounded outputs matter (SWE-agent ACI ablations; see `notes/external-research.md` §1.2).

### 3.2 Interface

One tool with one parameter, so that the schema overhead is minimal and identical across arms. Experiment 2's Code Review Graph exposed 23 tools and cost 3.1× the tokens without being called.

```
find_relevant_code(query: string)
  "Find where something is implemented in this codebase. Returns a short list of symbols with file:line ranges,
   signatures and their direct callers/callees/handlers. Read the ranges you need."
```

- **Server-side, fixed per condition:** output cap 800 tokens (the agent cannot enlarge it), at most 10 symbols, 3 neighbours per direction, depth 1 for neighbours, depth 2 for the propagation that ranks symbols. These are frozen from S/dev data.
- **Content per symbol:** rank, qualified name, `file:start-end`, kind (and async), one-line signature, then `→ calls / ← called by / implements / routes / publishes / consumes` lines with `file:line`.
- **Labels:** non-static edges are tagged `(framework)`, `(semantic)` or `(ambiguous)`. No function bodies.
- **Same renderer for the no-graph control** (`relations: false`). It uses hybrid ranking without graph propagation and spends the same token cap on more symbols, so the arms differ only in graph content.
- **Deferred:** a second operation, `related_code(symbol, relation)`, for explicit navigation. It would make the graph arm's schema differ from the control's, so it is an exploratory arm only after A1/A2.

Sketch of one result block, as rendered by the prototype on an experiment-1 task:

```
5. AuthService.getTokensData — src/auth/auth.service.ts:599-644 [method, async]
   private async getTokensData(data: { id: User['id']; role: User['role']; sessionId: Session['id']; hash: Ses…
   ← called by: AuthService.refreshToken src/auth/auth.service.ts:523; AuthService.validateLogin src/auth/auth.service.ts:42; …
```

### 3.3 Prototype measurement (E3-D07; `results/compact-prototype.json`)

Setup:
- experiment 1's frozen held-out rankings, 14 tasks;
- base-snapshot graph;
- exact symbol-key matching (indicative; not the official scorer).

"Listed" means symbols named as results. "Pointed" adds the neighbours named with locations.

| Ranking | Output | Tokens | Relevant symbols pointed to | Root cause pointed to |
|---|---|---:|---:|---:|
| hybrid | native 8k snippets (experiment 1) | 6,320 | 0.85 | 1.00 |
| hybrid | compact, relations, cap 800 | 722 | 0.70 | 0.79 |
| hybrid | compact, no relations, cap 800 (25 symbols) | 764 | 0.72 | 0.86 |
| hybrid | compact, relations, cap 400 | 343 | 0.51 | 0.57 |
| hybrid | compact, no relations, cap 400 | 365 | 0.64 | 0.79 |
| BM25 | compact, relations, cap 800 | 504 | 0.63 | 0.71 |
| BM25 | compact, no relations, cap 800 (25 symbols) | 750 | 0.64 | 0.64 |
| BM25 | compact, relations, cap 400 | 359 | 0.46 | 0.57 |
| BM25 | compact, no relations, cap 400 | 368 | 0.41 | 0.50 |

Readings, kept honest:
- **Pointers are much cheaper.** About 12% of the tokens still point to about 85% of what the full snippet context contains (0.72 vs 0.85).
- **Relationship lines are not free.** On the 6k-line repository, at equal token cost, they did not beat listing more ranked symbols for the strong hybrid ranker. They helped the weaker BM25 ranker at the smaller cap.
- **What is tested next.** Whether relation lines pay off on M and L, where name ambiguity and path length are larger, is exactly H4 at the interface level. Stage 1 repeats this table on M and L before any agent run.
- **Pointing is not reading.** Pointer output moves cost into Read calls, so only the agent stage can measure the net effect on total session tokens.

## 4. Infrastructure measurements planned (stage 1)

For S, M and L, and for each nested corpus:
- **Build cost:** graph build time and peak RSS; embedding time (GPU, RTX 3060 6 GB) and vector storage; BM25 build.
- **Query latency:** p50/p95 per method.
- **Incremental update:** after 1-file and 20-file changes. Today the graph rebuilds fully, 97 s on L. The proposed path is TypeScript's `oldProgram` reuse plus re-extraction of changed files and of edges into them, timed and compared byte-for-byte against a full rebuild.
- **Freshness:** share of a changed file's edges that are stale before the update.
- **Competitors:** whether Graphify and CRG index M and L at all, and at what cost.
