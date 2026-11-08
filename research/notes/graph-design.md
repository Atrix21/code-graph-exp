# Deterministic TypeScript-Compiler-API code graph: design notes

Implementation: `src/parser/*` (extractors) + `src/graph/{graph-builder,graph-store,graph-validator,build-cli}.ts`.
Schema: `src/graph/graph-schema.ts` (unchanged; see "Schema usage" below).

Run: `npx tsx src/graph/build-cli.ts --repo targets/nestjs-boilerplate-upstream --out .cache/graph-upstream [--check-repro]`
Outputs `graph.sqlite`, `graph.json`, `coverage.json`, `stats.json`. Tests: `npx vitest run tests/graph` (fixture: `tests/fixtures/mini-app`).

## Pipeline
1. `typescript-parser.ts`: `ts.createProgram` from the repo tsconfig (compiler options + `extends`), root files = the corpus
   (plus any ambient `.d.ts` matched by tsconfig `include`). One type checker; no emit, no semantic diagnostics (only syntactic
   ones, used for `parse_failures`).
2. `symbol-extractor.ts` (pass 1): declaration nodes + CONTAINS. `declInfo()` is the single mapping from any declaration to a node id.
3. `structural-extractor.ts` (pass 2): IMPORTS/EXPORTS (+import/export nodes), EXTENDS/IMPLEMENTS, HAS_TYPE.
4. `framework-extractor.ts` pre-pass: class roles, DI bindings, implementers, db_entity, routes, INJECTS_DEPENDENCY, @OnEvent.
5. `body-walker.ts` (pass 3): one AST walk per declaration "owner" dispatching to control-flow / call / data-flow / framework / reference collectors.
6. Sort nodes and edges by id; compute stats, coverage (`graph-validator.ts`).

Conventions: paths are repo-relative POSIX; lines AND columns are 1-based; no timestamps/absolute paths; edge id =
`edge:<TYPE>:<sha1(src|dst|file|line|col|key)[:16]>` (first writer wins on duplicates). Canonical hash = SHA-256 over key-sorted JSON of sorted nodes+edges.

## Node ids / names
| type | id | notes |
|---|---|---|
| repository | `repository:<package.json name>` | one |
| file | `file:<rel>` | `meta.symbol_key = <rel>::<module>` |
| class / interface | `class:<file>#Name` | `meta.role` (controller/service/repository/mapper/entity/module/guard/...) + `role_source` |
| function | `function:<file>#name` | function declarations and module-level arrow/function-expression consts |
| method | `method:<file>#Class.member` | methods, `Class.constructor`, accessors (get/set merged, `meta.accessor`), arrow-function properties (`kind=arrow_property`), abstract members, interface method signatures |
| type | `type:<file>#Name` | type aliases and enums (`meta.decl_kind = type_alias | enum`; no new `enum` node type) |
| variable | `variable:<file>#name` | module-level non-function consts/lets |
| property | `property:<file>#Class.prop` | class/interface properties and constructor parameter properties (`meta.parameter_property`) |
| parameter | `parameter:<file>#<OwnerQualified>(<name>)` | destructured params are `$<index>`; `meta.index/type/decorators` |
| import / export | `import:<file>#<specifier>@L<l>:C<c>`, `export:<file>#<names>@L..` | |
| condition / branch / loop / return / exception_handler | `<type>:<file>#<OwnerQualified>@L<line>:C<col>` | `~2` suffix only on a same-position collision of different kinds |
| external_dependency | `external_dependency:<npm package>` | also `<stdlib>` (language builtins, used for THROWS of `Error` etc.) and `<unresolved>` (placeholder, `verification=unknown`) |
| route | `route:<VERB> <path>#<file>::<Class.method>` | |
| db_entity | `db_entity:<file>#<Class>` | `@Entity` (typeorm) / `@Schema` (mongoose) |
| event | `event:<name>` | only from string-literal `emit`/`@OnEvent` |

Qualified names and spans are identical to `src/evaluation/symbol-index.ts` (checked on the target: all 681 symbol-index keys present, 0 span
differences). `meta.symbol_key` is `<file>::<qualified_name>` on declaration nodes (`meta.declaration = true`); every other node that
lives in a file carries the symbol key of its *owner* (e.g. a condition inside `AuthService.refreshToken` carries
`...::AuthService.refreshToken`) so any hit can be mapped to a canonical symbol. Synthetic nodes (config keys, events, externals) have none.
Code that is not inside any declaration (decorator-free top-level statements, `export default registerAs(...)`) is owned by the file node.
Calls inside nested closures/callbacks are attributed to the enclosing declared owner (`meta.in_callback = true` on the effect edge).

Synthetic config nodes: `type=variable`, id `variable:config#<key>` (`auth.refreshSecret`, `env.DATABASE_URL`), `meta.synthetic = true`,
`meta.config_key`, `meta.source = nestjs-config | process.env`. No schema change was needed.

## Edge types: meaning, extraction, verification
Every edge has `extraction` (method string), `confidence`, `verification`, evidence file/line/col and short evidence text.
Evidence position of a call is the callee-name token (so `a.b().c()` has distinct positions).

**Verification/confidence policy**
- `static_verified` (conf 1): syntax or type-checker/module-resolution fact: declarations, IMPORTS, EXTENDS/IMPLEMENTS, INSTANTIATES, direct CALLS, all control-flow/data-flow edges whose target is resolved through the checker.
- `framework_inferred` (0.6-0.95): needs a framework convention on top of resolved symbols: DI-binding dispatch (0.8), CONTROLLER_CALLS/SERVICE_USES/REPOSITORY_ACCESSES (0.9; keep 0.8 / ambiguous when derived from a dispatch edge), ROUTES_TO (0.95 when the decorators resolve to `@nestjs/common`, else 0.7), INJECTS_DEPENDENCY (0.95/0.9), QUERIES_DATABASE (0.9), CALLS_EXTERNAL_API (0.9), db_entity DEFINES, config-key READS via `@nestjs/config` (0.9), PUBLISHES/CONSUMES_EVENT.
- `semantic_inferred` (0.6): name heuristics only: ConfigService / EventEmitter detected by receiver *type name* when the declaration is not from the known package (this is what the fixture exercises), decorators that do not resolve to the expected package.
- `ambiguous` (1/n): several candidate declarations, or several implementers and no DI binding.
- `unknown` (conf 0): detected but unresolved; edge to `external_dependency:<unresolved>` (13 on the target: `any`-typed receivers).
Inferred relationships are never `static_verified` (enforced by a test).

**Structural**
- CONTAINS: repository->file->top-level decls->members; owner->parameters and all intra-function nodes; file->import/export nodes; class->ctor parameter properties.
- IMPORTS (file->file | file->external_dependency): `ts.resolveModuleName` with the program options (handles paths/baseUrl), builtin modules, ambient modules via `checker.getSymbolAtLocation(specifier)`. `meta`: specifier, names, type_only, import_node. Re-exports are IMPORTS+EXPORTS. Dynamic `import('lit')` included. An unresolvable specifier gets an edge to the package node with `verification=unknown`.
- EXPORTS (file->declaration): exported declarations, `export {a as b}`, `export default x`, re-exports (file->file, `meta.reexport`).
- EXTENDS / IMPLEMENTS: heritage expression resolved via checker (alias followed). External bases (`extends PartialType(X)`, `PassportStrategy`) -> external_dependency with `meta.mixin`/`base`. Stdlib bases (`Error`) -> `<stdlib>`.
- INSTANTIATES (`new X`): class node for project classes (plus CALLS to an explicit constructor), external_dependency for library classes (`meta.class_name`).
- REFERENCES: owner -> project class/interface/type/enum/module-variable that is mentioned by an identifier or type reference (including signatures and decorators) and is not already an INSTANTIATES/EXTENDS/IMPLEMENTS target; self-class references skipped.
- HAS_TYPE: parameter/property -> every project type referenced in the annotation (`meta.role = primary | type_arg`).
- DEFINES: class -> db_entity, controller class -> route (documented use of the existing `DEFINES` type).

**Execution**
- CALLS: `checker.getResolvedSignature(call).declaration`, falling back to `getSymbolAtLocation` (aliases followed via `getAliasedSymbol`). Project declaration -> node; package -> `external_dependency` (member in `meta.member`, e.g. `ConfigService.get`); decorators are calls (`meta.decorator`). Dispatch: if the resolved member is abstract/an interface signature, additional CALLS go to each implementation's member: bound via `{ provide: X, useClass: Y }` (any object literal in the corpus) -> `framework_inferred` 0.8, `meta.dispatch = {via, impl_class, binding: file:line}`; no binding -> `ambiguous` 1/n over transitive implementers. The primary edge to the abstract member stays `static_verified`.
- RETURNS (owner->return node; `meta.expression`, `early_return`, `guard`, `implicit` for expression-bodied arrows). `early_return` = the return is not in tail position of the function body (tail analysis through if/else, blocks, switch clauses, try/catch).
- THROWS: owner->exception class (project class, external_dependency of the class's package, or `<stdlib>`), resolved from the *type* of the thrown expression (works for `throw this.makeException()`); unresolved -> placeholder + `unknown`. Rethrow of a catch variable is flagged `meta.rethrow`.
- CATCHES owner->exception_handler (catch clauses; `meta.variable`, try range). `finally` blocks are not modelled. Effects inside a `try` block carry `meta.caught_by`, inside a catch block `meta.in_handler`.
- RECURSES_TO: owner->owner when a call resolves to the owner itself (direct recursion only; mutual recursion is unsupported). LOOPS: owner->loop (for/while/do/for-of/for-in; array callbacks are not loops).
- CHECKS: owner->condition and condition->project properties/parameters/module variables that the condition expression reads (checker-resolved; locals are not nodes).
- BRANCHES_TO: condition->branch with `meta.polarity = true | false | case` and line range.

**Control-flow nodes**: `condition.meta.kind` = `if | ternary | guard (&&,||,?? statements) | switch_case | loop_for | loop_while | loop_do_while | loop_for_of | loop_for_in`. `else if` is a nested condition whose `parent_branch` is the outer false-branch. An `if` without `else` has no false branch node. `&&` guards have a true branch on the right operand, `||`/`??` a false branch. Effects (CALLS, INSTANTIATES, RETURNS, THROWS, WRITES, MUTATES, loops/catches, QUERIES_DATABASE, external-API and event edges) inside a branch are emitted twice: from the function with `meta.guard = {condition_id, polarity}` and from the innermost branch node (`meta.owner`).

**Data flow**
- READS: owner -> project property (`a.b` rvalue, excluding method-call callees, pure LHS writes and DI-style class-typed constructor properties) / module variable / config key (`ConfigService.get|getOrThrow('a.b')`, `process.env.X`).
- WRITES: assignment/compound/++/-- to a project property or module variable (`meta.op`, `meta.root`). MUTATES: property assignment, `delete`, or a mutating stdlib call (`Array.push/splice/sort/..., Set/Map.add/set/delete/clear, Object.assign(target, ...)`) on an object not created in this function (`this` outside constructors, parameter, destructured parameter, call result, module variable); target is the property node when resolvable, else the root parameter/variable. Locally created objects (`{}`, `[]`, `new`) are excluded.
- PASSES_TO: caller -> callee *parameter node* by argument index (rest parameters map to the last), `meta = {arg_index, arg, param, callee}`.
- RECEIVES_FROM (caller -> callee) / RETURNS_VALUE_TO (callee -> caller): the call result (through `await`, parens, `as`) is bound to a variable (`const x = f()`, `x = f()`); `meta.variable`, `meta.awaited`. Only the directly resolved target (not dispatch implementations).

**Application layer** (all `framework_inferred`)
- Roles by decorator (`@Controller`, `@Entity/@Schema`, `@Module`, `@Injectable`) then class name (`*Repository`, `*Mapper`, `*Service`) or inheritance from a `*Repository`; stored in `class.meta.role`/`role_source`.
- CONTROLLER_CALLS: controller method -> service method. SERVICE_USES: service method -> service/repository/mapper/helper-function in another class. REPOSITORY_ACCESSES: any caller -> repository-class method (primary target and dispatched implementations). All derived from resolved internal CALLS (`meta.rule`).
- ROUTES_TO: route -> handler. Path = `@Controller(prefix | {path,version})` + method decorator path (`Get/Post/Put/Patch/Delete/Options/Head/All`); `meta.version`, `guards`, `roles`, and the raw `setGlobalPrefix(...)`/`enableVersioning(...)` argument text found in the corpus (`global_prefix_expr`, `versioning_expr`) (the prefix itself is a config key, not folded into `path`).
- db_entity + QUERIES_DATABASE: entity found by scanning the receiver's type (and type arguments, alias arguments, unions to depth 4) for a class that is a db_entity; the call must resolve into `typeorm`/`mongoose`/`@nestjs/*`. `meta.op` = find|save|update|delete|count|index|... (name-based); query-builder/chain modifiers (`sort/skip/limit/populate/exec/...`) are skipped; `new Model(...)` is op `save`.
- INJECTS_DEPENDENCY: constructor parameter types resolved to project classes (or external classes -> external_dependency); `@InjectRepository(E)` / `@InjectModel(E.name)` -> entity class (`meta.db_entity`). String/symbol tokens (`@Inject('X')`) are not resolved.
- CALLS_EXTERNAL_API: calls whose callee package, or whose receiver type's package, is in the explicit list in `framework-extractor.ts` (`EXTERNAL_API_PACKAGES`): `@aws-sdk/*`, `aws-sdk`, `nodemailer`, `google-auth-library`, `apple-signin-auth`, `axios`, `@nestjs/axios`, `node-fetch`, `got`, `undici`, and global `fetch`. Constructors (`new S3Client`) are INSTANTIATES only.
- PUBLISHES_EVENT / CONSUMES_EVENT: `emit/emitAsync('literal')` on `@nestjs/event-emitter`/`eventemitter2`/`events` (or an `EventEmitter*`-named type: semantic_inferred) and `@OnEvent('literal')`. **The target repository contains no event emitters, so no event nodes/edges are produced there** (covered only by the fixture test).

## Coverage on the target (170 files = every `*.ts` under src/ and test/)
Validator counts facts with its own AST walks and compares them to what was captured.
| metric | value |
|---|---|
| files parsed | 170/170 (100%) |
| declared functions extracted | 211/211 (100%); 400 function-like nodes in total, the other 189 are anonymous callbacks attributed to their owner |
| call sites (CallExpression + NewExpression) | 1977 |
| resolved internal | 211 (10.7%): 209 with an edge, 2 are local closures called inside their owner (no node, no edge) |
| resolved external | 1754 (88.7%): 1508 external packages (532 are decorator calls), 246 TypeScript stdlib calls (counted resolved, no edge emitted on purpose: `Array.map`, `JSON.stringify`, ...) |
| unresolved | 12 (0.6%) |
| imports | 744/744 resolved |
| unresolved references (bare identifiers / type names) | 0 |
| unsupported syntax | none observed (tagged templates, generators, static blocks, non-literal `import()` are counted when present) |

Unresolved-call buckets (all 12): 8 are `body.find(...)` on supertest's `any` response body in `test/user/auth.e2e-spec.ts`; 3 are calls on `any` values in `src/utils/transformers/lower-case.transformer.ts` (2) and `src/utils/document-entity-helper.ts` (1); 1 is `connection.plugin(mongooseAutoPopulate)` (`connection` is `any`). These are genuinely untyped; no heuristic guess is made.
48 calls into typeorm/mongoose have no QUERIES_DATABASE edge: `TypeOrmModule.forFeature`, `queryRunner.query` in the migration, query modifiers, `In()/Not()`, `SchemaFactory.createForClass`.
Verification split: ~93.6% static_verified, ~6.2% framework_inferred, 0.15% unknown, no ambiguous (every abstract repository has bound implementations).
Build time ~2.4 s (program creation dominates); two builds produce the same hash.

## Known unsupported / limitations
- Dispatch only for abstract/interface members (not virtual overrides in subclasses); factory/`useFactory`/`useExisting`/string-token providers are not bound.
- Calls to nested/local functions and object-literal methods have no node (counted internal, no edge). Function values passed as callbacks are not CALLS.
- No flow analysis: implicit "false" branch of an `if` without else is not a node; short-circuit inside larger expressions (`return a && b()`) is not a condition; `finally`, labeled break/continue, generators, `await` ordering are not modelled; `try` region effects are flagged via `meta.caught_by` only.
- Destructuring assignments are not WRITES; reads of getters are not READS; enum member access is REFERENCES to the enum only.
- RECURSES_TO is direct recursion only.
- Route `path` excludes global prefix/versioning (recorded as raw expressions); no `@Controller` host/array-path expansion beyond first literal.
- QUERIES_DATABASE ops are name-based; entity detection depends on type arguments surviving to the receiver (`Repository<E>`, `Model<E>`, hydrated documents).
- `external_dependency` is per npm package, so THROWS of `NotFoundException` and `UnauthorizedException` share a target node; the class is in `edge.meta.exception_class`.
- `build()` returns an extra `diagnostics` field (call-site log) used by the validator; it is not persisted.
