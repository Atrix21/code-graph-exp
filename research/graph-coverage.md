# Graph coverage: what our TypeScript graph captures and what it misses

Measured on the pristine benchmark snapshot (`base`, commit in `targets/bench.manifest.json`, 170 corpus files). Per-snapshot numbers for all 20 task snapshots are in `evaluation/results/graph-validation.json` (`npm run graph:validate`). Design details and extraction APIs: `research/notes/graph-design.md`. Builder: `src/parser/*`, `src/graph/*` (TypeScript Compiler API 5.9.3 with the type checker; no LLM).

## Completeness checks (independently counted by `src/graph/graph-validator.ts`)

| Check | Result |
|---|---|
| Parsed files / eligible files | **170 / 170** (0 parse failures) |
| Extracted functions / declared functions (named functions, methods, constructors, accessors, function-valued properties/consts) | **211 / 211** |
| Detected call sites | 1,977 (532 of them decorator calls) |
| → resolved to a project declaration | 211 (209 with a graph edge; 2 are calls to local closures, which have no node) |
| → resolved to an external package / TS stdlib | 1,508 / 246 (stdlib calls are counted as resolved but emit no edge) |
| → unresolved | **12 (0.6%)**: 8 × `body.find` on supertest's `any` body in an e2e test, 3 calls on `any` in `src/utils`, 1 `connection.plugin` on `any` |
| Resolved imports / detected imports | **744 / 744** |
| Unresolved references | 0 |
| Unsupported syntax encountered | none |
| Canonical-symbol join | all 681 evaluation symbol keys exist as graph declaration nodes with identical spans |
| Reproducibility (build twice, SHA-256 over canonical JSON) | identical on base and on every task snapshot (see graph-validation.json) |
| Build time | ≈ 1.6–2.4 s per snapshot (program creation dominates) |

## What the graph contains (base snapshot)

**2,670 nodes**: import 744, property 318, branch 255, parameter 232, condition 196, method 188, file 170, return 138, variable 133 (incl. synthetic config-key nodes), class 126, external_dependency 48, type 29, route 24, function 23, interface 15, export 11, exception_handler 8, db_entity 8, loop 3, repository 1.

**8,618 edges**: CONTAINS 2,484, CALLS 1,841, IMPORTS 744, READS 596, REFERENCES 570, CHECKS 341, HAS_TYPE 281, BRANCHES_TO 255, PASSES_TO 212, EXPORTS 187, RETURNS 155, INSTANTIATES 150, WRITES 136, THROWS 108, SERVICE_USES 105, QUERIES_DATABASE 88, REPOSITORY_ACCESSES 69, RECEIVES_FROM 54, RETURNS_VALUE_TO 54, INJECTS_DEPENDENCY 48, DEFINES 32, CONTROLLER_CALLS 26, ROUTES_TO 24, EXTENDS 13, CALLS_EXTERNAL_API 11, IMPLEMENTS 11, CATCHES 9, MUTATES 6, LOOPS 4, RECURSES_TO 4.

**Provenance**: every edge carries an evidence location, extraction method, confidence and verification status: 8,067 `static_verified` (type-checker or syntax), 538 `framework_inferred` (NestJS decorators/DI, `provide`/`useClass` bindings, TypeORM/Mongoose receivers, config-service keys), 13 `unknown`, 0 `ambiguous` (every abstract repository in this repo has exactly the bindings found in its persistence module). No inferred edge is labelled verified.

## Supported, with caveats

- **Calls via abstract repositories** (`UserRepository.findById` → relational and document implementations) are added as `framework_inferred` (conf 0.8) with the DI-binding line as evidence. Virtual overrides in subclasses, `useFactory`/`useExisting` and string-token providers are not bound.
- **Control flow**: `if`/ternary/`switch` cases/`&&`/`||`/`??` guards/loop conditions become condition nodes. `BRANCHES_TO` true/false/case branches carry line ranges, and early returns are flagged. Effects inside a branch are emitted with `meta.guard`. Conditions are linked by `CHECKS` to the properties/parameters they read.
- **Data flow**: READS/WRITES of project properties, module variables and config keys (`configService.get('auth.refreshSecret')`, `process.env.X`); MUTATES of objects not created locally; argument→parameter `PASSES_TO`; call-result binding `RECEIVES_FROM`/`RETURNS_VALUE_TO`.
- **Application layer**: 24 routes (decorator prefix + method path), controller/service/repository roles, `INJECTS_DEPENDENCY`, 8 DB entities with `QUERIES_DATABASE` (op names are name-based), and `CALLS_EXTERNAL_API` for an explicit package list (AWS SDK, nodemailer, google-auth-library, apple-signin-auth, axios/fetch).

## Not captured (explicit)

- Events: the repo has no event emitters, so `PUBLISHES_EVENT`/`CONSUMES_EVENT` are exercised only by the fixture test.
- Implicit false branch of an `if` without `else`; short-circuits inside larger expressions; `finally`; labelled break/continue; await ordering; any real flow-sensitivity (no SSA / reaching definitions).
- Destructuring assignments as WRITES; getter reads; mutual recursion (only direct recursion).
- Local variables (not nodes), so intra-procedural data flow stops at properties/parameters.
- Calls to nested closures and object-literal methods (no node); callbacks passed as values are not CALLS.
- Route paths exclude the global prefix and versioning (stored as raw expressions only).
- `THROWS` targets the package node (`@nestjs/common`); the exception class is in edge meta, not a node.
- 48 TypeORM/Mongoose calls have no entity resolvable from the receiver type (module setup, migrations, query modifiers).

## What mattered for retrieval (from the held-out ablations, `evaluation/results/ablation-test`)

Inside hybrid retrieval, removing graph traversal is the only change with a CI excluding zero (Recall@10 −0.24 [−0.40, −0.08], root-cause MRR −0.24 [−0.45, −0.04]).

- Removing data-flow or structural edges costs ≈ 0.04–0.05 Recall@10 (CIs touch 0).
- Removing control-flow edges, application-level edges, framework-inferred edges or confidence weighting has no measurable effect. Application edges duplicate CALLS edges after projection, and 94% of edges have confidence 1.
- For the graph used alone (custom_graph vs itself): traversal −0.08 [−0.17, 0.00], data flow −0.07 [−0.17, 0.02], control flow −0.02 [−0.07, 0.00] Recall@10.

(Numbers from the corrected ablation run; see decision D-023.)
