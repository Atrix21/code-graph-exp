# Independent audit of experiment 2 (agent diagnosis): harness, protocol and billing safety

Auditor: independent Sonnet agent, did not build the harness. Date 2026-11-08. Claude Code 2.1.319 on this machine.
**No billable call was made.** Everything below was run with: the unit tests, the local mock Anthropic API (real `claude`
binary, scripted tool calls), a fake `claude` executable that prints canned stream-json, the MCP client SDK against the
real Graphify / CRG servers (graph builds only), and direct calls to the scorer. `AGENT_EVAL_BILLABLE` was never set and
`APPROVAL.json` was never created.

## Verdict: READY-WITH-FIXES

The leakage and isolation work is good and I could not break it under the `restricted-oauth` profile. The pre-registration,
scorer, accounting and prompt equality are mostly sound. But five defects would corrupt data or waste money on the first
real run, and the protocol promises two safeguards (init-event exclusion, retrieval-cost reporting) that the code does not
implement. All five blockers are small, local code changes. Do not ask the owner to approve billable runs until B1-B5 are
fixed and the `it.fails` audit tests are flipped to `it`; then one smoke pilot (see the checklist at the end) is a reasonable
first spend. Majors should be fixed or disclosed before the 14-task main run.

Test status: `npx vitest run` = 198 pass (140 existing + 58 audit tests). The audit tests live in
`tests/agent-eval/audit-{scoring,harness,leakage}.test.ts`. `it.fails(...)` marks a *defect* (the assertion states the
behaviour we want and passes only while the defect exists), `it(...)` marks verified behaviour. Finding ids F-xx match the
test titles.

## Findings

### Blockers (fix before any billable run)

**F-02 Scorer gives 0 to any answer that uses an absolute path.** `scoring.ts:73-81, 89` and `evaluation/normalise.ts:43-49`.
`normaliseFile` resolves an absolute path against the *scoring* workspace (`/tmp/work/<hmac(task|score)>/app`), but the agent's
files live in a different opaque directory (`.../<hmac(task|runId|cond|repeat)>/app`), so the path becomes `../<other>/app/...`
and is "unresolved". Claude Code's `Read` requires absolute paths, CRG's tool output is entirely absolute
(`/tmp/work/<opaque>/app/src/...`, verified in my leak scan), and models routinely copy such paths even when the schema says
"repository-relative". Result: a correct answer scores `rc=0, line=0, file=0`. Measured on all 20 tasks: canonical form 111,
`./`-prefixed 111, **absolute path 000 (20/20)**, `path:line` in the file field 000. This biases against any condition whose
tool output is absolute (CRG) and adds noise everywhere. Evidence: 20 `it.fails` cases in `audit-scoring.test.ts` plus
`path:line`. Fix: before scoring, relativise the file with the *agent's* workspace root (known to the harness), and as a
fallback strip any `^.*/app/` prefix and `:\d+(-\d+)?$` suffix, then require the result to be in `index.byFile`. Do it in
`scoring.ts` (leave `normalise.ts` alone: it is shared with exp. 1). Also fix `file_at_1` and `lineHit` to use the same
normalised file. Because rescoring from `raw-runs.jsonl` is offline this is recoverable, but a post-hoc scorer change after
data exists is an analytic deviation, so fix it before freezing.

**F-03 The protocol's isolation-drift exclusion is not implemented.** `protocol.md:75` says every run records the `system/init`
tool list and a run whose tool set differs "is excluded and reported". Code: the only check is that the condition's own MCP
server is `connected` (`agentic.ts:224-228`). `init_tools` is parsed (`claude-code.ts:419`) but never compared and never
written to the run record. Nothing checks model, extra MCP servers (e.g. account-level claude.ai connectors under OAuth),
skills, plugins, slash commands, agents, `apiKeySource`, or Claude Code version. This is the *only* mechanism by which the
first real run can detect the OAuth-path risks the isolation report cannot cover (Q2). Demonstrated with a fake `claude`
whose init lists `Bash`, another model and a skill: the run is scored and kept (`audit-harness.test.ts`, F-03).
Fix: persist `init` (tools, mcp_servers, model, skills, plugins, slash_commands, agents, apiKeySource, claude_code_version,
permissionMode) in every run record; define the expected fingerprint per condition (exactly the tool list in
`audit-leakage.test.ts`, `skills=[]`, `slash_commands=[]`, `plugins` all `path:"builtin"`, `mcp_servers` = exactly the
condition's server, `model` = the pinned id); any mismatch goes to `excluded.jsonl` with the reason and **halts the run
after the first occurrence** (a systematic OAuth difference would otherwise burn the whole budget before anyone looks).

**F-04 Infrastructure failures are scored as wrong diagnoses, and nothing stops the run.** `agentic.ts:229-231` keeps every run
that is not `mcp_not_connected`; `claude-code.ts:351-359` maps a crash, a missing result event, a 529, or an
`is_error` result with `subtype:"success"` (how Claude Code reports a usage/rate limit) to `stop_reason:'error'` with a null
diagnosis, which the scorer turns into `valid=0, rc=0`. Under a subscription login, hitting the usage limit mid-run would
turn every remaining item into an instant "failure" that is scored 0 and counted against whichever conditions happened to
run last; the harness keeps spawning. Demonstrated with a fake `claude` (exit 1 / limit text): the run lands in `runs.jsonl`
(`audit-harness.test.ts`, F-04, two cases). Fix: classify results into {agent outcome: submitted, max_turns, budget, timeout}
(scored; timeouts and max_turns are legitimate failures of the agent) vs {infrastructure: no result event, non-zero exit
without result, `is_error` with api/limit/overloaded text, spawn error} (never scored; retried once with a fresh workspace,
then excluded and reported per condition). Add a circuit breaker: stop the whole run after 2 consecutive infrastructure
failures or any limit message.

**F-05 A crash or Ctrl-C loses paid results and orphans billable processes; there is no resume.**
- `agentic.ts:170` `fs.rmSync(dir, {recursive:true})` runs on *every* start, so re-running the same run id deletes
  `raw-runs.jsonl` (the only incremental record) and all transcripts. There is no `--resume` and no skip of completed items.
  A restart re-spends every completed run (the ledger keeps counting, the data is gone). Demonstrated:
  `audit-harness.test.ts` F-05 (a pre-existing `raw-runs.jsonl` is deleted).
- `runs.jsonl`, `excluded.jsonl`, `meta.json` and the report are written only at the very end (`agentic.ts:260-269`); a thrown
  error in one worker (`agentic.ts:245` rethrows anything that is not `BillableRefused`, e.g. a CRG graph-build failure or a
  workspace-isolation violation) rejects `Promise.all`, so no final files are written and the other workers' in-flight
  runs are abandoned. The single-shot path has the same shape (`claudeSingleShot` rethrows `BillableRefused` out of
  `Promise.all`; `runSingleShot` writes `runs.jsonl` only after all items).
- `runClaude` spawns `claude` with `detached: true` (`claude-code.ts:446`) and the harness installs no SIGINT/SIGTERM handler.
  Ctrl-C or a crash of the parent leaves the detached `claude` processes running to completion on the owner's account; their
  cost is never recorded in the ledger (the parent is gone).
  Fix: never delete an existing run dir (refuse unless `--fresh`), skip items whose `run_id` is already in `raw-runs.jsonl`,
  append each completed run (and each excluded run) as it finishes, make scoring a separate offline step over
  `raw-runs.jsonl`, catch per-item errors (record as infrastructure failure) and install SIGINT/SIGTERM handlers that
  `process.kill(-pid)` every live child group, write the partial cost to the ledger and exit.

### Major (fix, or disclose in the report, before the main run; F-11 before the pilot)

**F-01 Only `restricted-oauth` is leak-safe, but billable runs may use `bare` / `safe-mode`.** Under those profiles `/tmp` is an
allowed working directory (isolation report, "Out-of-workspace Read" row). I reproduced it (`safe-mode`, mock API):
`Glob /tmp/work/*/app/src/auth/*.ts` lists every sibling workspace; `Grep secret /tmp/work` finds
`/tmp/work/<id>/idx/graphify-out/graph.json`; the workspace root `..` is readable. `/tmp/work` also contains the pristine
`base` snapshot (from `mcp-inspect`) and the `score` snapshots, so the base-vs-buggy diff is one `Read` away. `runAgentic`
accepts any profile for a billable run (`agentic.ts:157-158`), and `APPROVAL.json` does not bind the profile.
Under `restricted-oauth` all of these are denied (`audit-leakage.test.ts`, passes). Fix: reject non-`restricted-oauth`
profiles in `runAgentic` unless `--mock-api`, and move `WORK_ROOT` out of `/tmp` (e.g. `$HOME/.cache/agent-work`) so the `/tmp`
working-dir exception cannot matter; also delete the stale `/tmp/work/*` (including `score`, `mcp-inspect` and `base`) before a billable run.

**F-07 The cost cap is advisory under parallelism and has no per-run ceiling.** `claude-code.ts:439-443`: the per-run
`--max-budget-usd` is `min(--run-usd, remaining)`; `--run-usd` is optional (`agentic.ts:215`), so by default one run may spend
the entire remaining cap. With `--parallel N` every worker gets the full remaining budget and the ledger is updated only at
completion, so overshoot is up to N x the remaining budget (`audit-harness.test.ts` F-07: four workers started, `remaining()` still
= the full cap). A run that is killed/timeouts without a result event is ledgered as $0 (`claude-code.ts:461`; test shows
`cost_usd:null`, `remaining()` unchanged), so its real spend is invisible. Claude Code also only checks the budget between turns.
Fix: required `--run-usd` (set from the pilot, e.g. 3x the median), reserve `run-usd` in the ledger at spawn and release it on
completion, and for runs without a result event add the per-message `usage` from the stream (or charge the reservation).

**F-08 `total_cost_usd` is not billing-grade, and the pre-approval estimate has wrong inputs.** From the recorded mock
result events I solved Claude Code's price table for `claude-sonnet-5-5`: input $2, output $10, **cache read $0.10**, cache
write $2.50 per MTok (exact fit on 3 runs). The claude-api reference lists cache reads for Sonnet 5.5 at **$0.20** and
`cost.ts:321` uses $0.20. In cache-heavy agent loops (about 70% of tokens are cache reads in the mock runs) the ledger and
`--max-budget-usd` therefore under-count by roughly 20-30% if the list price is the billed price. Also `cost.ts:61` looks up
`s.name` but `mcp-inspection.json` has `server`, so the estimate always uses its hard-coded defaults (150 / 2,500 / 9,000
tokens) instead of the measured 62 / 1,350 / 8,242. Fix: compute `cost_list_usd` yourself from the four token classes at
list price (keep Claude Code's number as a second column), enforce the cap on the larger of the two, and repair the key.
(Under an OAuth subscription the dollar figure is nominal and the real constraint is the plan's usage window; see F-04.)

**F-09 Retrieval start-up / index-build cost is not captured, and latency is asymmetric.** `protocol.md` promises "index build
time per workspace and MCP server start-up time, reported separately". `grep build_ms src/agent-eval/agentic.ts` = no match:
`conditionServer` drops `ServerSpec.build_ms`, our servers' `prepare_ms` goes to the MCP child's stderr, which Claude Code
swallows. Meanwhile "latency" (spawn to exit) includes our server's embedding-model load for `hybrid`/`embeddings` (5-7 s,
inside the first tool call) but excludes Graphify/CRG graph builds (done in `competitorServerSpec` before spawn). The mock run
shows it: p50 latency baseline 585 ms, graphify 1,168, crg 1,421, **embeddings 5,417, hybrid 5,643**
(`results/validate-agentic-mock-dev/report.md`). CRG's lazy 6 s torch import on first call is inside latency. Fix: record per run
`build_ms` (competitors), `server_ready_ms` (parse `[ready] prepare_ms` by having the server also append it to its `--log`), and
report `api_duration_ms` next to wall-clock; pre-warm our servers (or build competitor graphs inside timing) so both are treated alike.
Also persist `init` (see F-03).

**F-10 The analysis code does not implement the pre-registered confirmatory analysis.** `analysis.ts` prints every condition vs
one reference (`agentic:baseline`, hard-wired at `agentic.ts:269,297`). Missing relative to `protocol.md`: H1b (needs
`--reference agentic:embeddings`, run by hand), H1c (single-shot, hybrid vs embeddings per budget), H2 (only mean deltas of tokens
and cost, no paired CI; NaN if any run lacks cost), "efficiency restricted to tasks where both are correct", repeat agreement
(`perTask` computes it, `report` never prints it), tokens per correct diagnosis, exclusion counts per condition, tool-schema
overhead decomposition (CRG's 6.2k-token schema is re-read as cache tokens every turn, so "total tokens" mixes schema, context and
output), and any statement of the decision rule or multiplicity (4 hypotheses, 5 tests counting both single-shot budgets, plus
7 exploratory arms printed with identical formatting). Fix: a `confirmatory.ts` that runs exactly the 4-5 pre-registered contrasts
with paired bootstrap CIs (also for tokens and cost), prints both-correct restricted efficiency, labels everything else
"exploratory", reports a sign-test/permutation p as a sensitivity check, and pre-registers the rule ("CI excludes 0"; no
correction, or Holm).
Power statement: "roughly >= 0.25" is the optimistic end. My simulation (14 tasks, percentile paired bootstrap, 95% CI excludes 0,
normal per-task differences) gives power 0.96 / 0.79 / 0.61 for a true difference of 0.25 when the SD of the per-task difference
is 0.25 / 0.35 / 0.45. Binary outcomes averaged over 3 repeats typically sit at SD 0.3-0.45, so 0.25 is roughly 60-80% power;
80% needs about 0.25-0.35. Say so ("detects effects of about 0.3 or larger with ~80% power") and keep the "no effect large
enough to detect" wording.

**F-11 Reproducibility pins are missing or inconsistent.** (a) Protocol says turn cap 30; code defaults to 40
(`claude-code.ts:166`, `agentic.ts:265`; notes also say 40). (b) The CLI default model is the alias `sonnet`
(`agentic.ts:292`, `cli.ts:34`); the protocol never names the model, and `APPROVAL.json` matches the string literally. (c) Claude
Code's version is recorded in `meta.json` but not enforced (`DISABLE_AUTOUPDATER=1` only helps the self-updater);
(d) `--effort` is unset, so the effort/thinking level is whatever Claude Code defaults to (mock saw `medium`; the claude-api
reference says the model default is `high`; plan-dependent defaults under OAuth are unobservable here); (e) the date line in the
system block changes with the run day (cache and a tiny prompt difference across days). Fix: default `--model claude-sonnet-5-5`,
pin `--effort` explicitly, refuse to run if `claude --version` != the version in `APPROVAL.json`, assert `init.model` equals the
pinned id, set `--max-turns` per the protocol (or change the protocol and justify from the pilot), add model, version, effort and
max_turns to `FROZEN.json` (which does not exist yet; `protocol.md` and `prompt.ts` refer to it, `cost.ts` refers to a
non-existent `approval.ts`).

**F-15 Competitor configuration is not symmetric, and the report must say so.** The read-only policy denies CRG's
`embed_graph_tool` (and the other 6 mutating/multi-repo tools) and Graphify's three `gh`-based tools (`agentic.ts:40-43`).
Denial is applied by the same mechanism to both, and the denied tools are absent from the offered list (isolation report, MCP
table), so that part is consistent and cheap. But CRG's best configuration (experiment 1: embeddings lift Recall@10 from 0.11 to
0.27) is thereby unavailable to the agent, while our `hybrid`/`embeddings` arms ship with pre-built document embeddings.
Label the arm "CRG (default FTS-only)" in every table, and either pre-build CRG embeddings at graph-build time (the analogue of our
cached vectors) as an extra arm or state that RQ3 compares *defaults as shipped*. Also: CRG's server injects 335 characters of
`instructions` into the system block ("Persistent incremental knowledge graph for token-efficient, context-aware code
reviews...", request system message 1,192 vs 857 characters for every other condition, from the recorded requests), and the tool
counts are 1 / 7 / 23 offered (schema 68 / 945 / 6,245 tokens per turn). The protocol states the asymmetry; report cost and
turns with and without the schema share.

**F-17 The isolation evidence covers the API-key path only; the OAuth path is unobserved.** Every recorded request used
`apiKeySource: ANTHROPIC_API_KEY` with a dummy key (`results/.../init`), so the real login path is untested: account-level
claude.ai connectors (this account has at least a Docs connector), organisation/managed policy, plan feature flags, the
"You are Claude Code" system prefix and the three builtin `cc-plugin-*` plugins' behaviour are unobserved. `restricted-oauth`
did ignore the owner's `swift-lsp` plugin, settings, CLAUDE.md, skills and memory in the mock runs, and the positive control
(no flags) did find the CLAUDE.md email, "any input to knowledge graph", the skill listing and memory, so the detectors work.
Mitigation is F-03 plus the first-run checks below. A cheap extra pre-approval check I did not run: repeat
`verify-isolation.ts` with `CLAUDE_CODE_OAUTH_TOKEN=<dummy>` and no API key against the mock to exercise the OAuth code path
without billing (the connectors fetch would fail harmlessly).

### Minor

- **F-06** Mock detection is "any loopback URL + the dummy key" (`claude-code.ts:249,476`). `isLocalUrl` itself is correct (I tested userinfo, suffix, IPv4-mapped and `0.0.0.0`
  tricks, all rejected; `audit-harness.test.ts`). But a local LLM gateway or ssh tunnel on localhost that injects a real key would
  bypass the approval gate, and `claudeSingleShot` takes the mock URL from the *process environment*. Fix: treat a URL as mock
  only if it is the port of the mock server this process started (pass it explicitly, never read `ANTHROPIC_BASE_URL` from the environment for that decision).
- **F-12** Line credit is lenient: a range covering the whole file earns the line half of RC+line@1 if the symbol is right
  (verified, all 20 tasks). Cap the credited range (e.g. <= the symbol span + 10 lines), or report the range length.
- **F-13** `normaliseName` strips `(...)` but leaves the space before it: a symbol like `X.y (page offset)` with no line numbers
  does not resolve (falls back to line overlap only if lines are present).
- **F-14** `start_line`/`end_line` are optional in `DIAGNOSIS_SCHEMA` while the primary metric needs them (right symbol, no lines = `rc=1, rc_line=0`).
  Make them required in the schema (the prompt already asks for them) so the metric measures diagnosis, not format compliance.
- **F-16** Cost depends on prompt-cache state: the order is task > condition > repeat, so each condition's tools+system prefix is
  usually cold on the first repeat and warm on 2-3, and with `--parallel` it varies. Cost comparisons between conditions
  therefore contain scheduling noise proportional to tool-schema size. Report tokens by class and recompute cost uniformly at list price (F-08).
- **F-18** Single-shot CRG contexts (from experiment 1) contain the string `/tmp/cgbench/w/...` (a hint that this is a "cg bench"); nothing
  about the task. No host path, task id or dataset path appears in any of the four contexts files (checked by regex).
  The workspace's `package.json` names the upstream project, so memorisation is possible, as the protocol already states.
- **F-19** `claude --version` returning nothing crashes `runAgentic` with `undefined.trim()` (`agentic.ts:174`). Stale
  `/tmp/work/<hash>` directories from scoring (`score`) are never cleaned. The scorer's `snapshotIndex` rebuilds a workspace at a
  fixed path, so two concurrent scoring processes race.
- **F-20** Pure-deletion bug (`auth_reset_sessions_01`): the defect is recorded as the line *after* the removed block (415); credit is given for a start line in 413-417
  and not for 412 or 418 (verified). Defensible, but an answer pointing at the line that validates the reset token (410) is a miss; note it in the protocol.

## Answers to the audit questions

**1. Leakage.** I could not make the agent learn the root cause from anything but the code under `restricted-oauth`.
- Workspace: `git archive` of one branch, `git init` + one commit; `.git/logs/HEAD` shows one entry, `dev <dev@localhost>`, fixed date (read via the tool).
  The branch differs from `base` by the single bug patch only (`git diff --stat base..task/*`: 1 file each). `.gitignore` hides nothing relevant
  from Grep/Glob (`rg --files` = 213 of 214 tracked files, the missing one is `.gitignore` itself).
- Paths: cwd `/tmp/work/<hmac>/app` (opaque). Graphify's `Graph: <path>` line now points at `/tmp/work/<opaque>/idx/graphify-out/graph.json`. My scan of
  every non-denied tool of both native servers (CRG 23, Graphify 7, with plausible arguments) matched none of `code-graphs|experiments|adityareddy|.cache|/home/|evaluation|targets|bench|dataset|root_cause|task/|_01`.
  CRG shows `/tmp/work/<opaque>/app/...` only. Tool descriptions carry no task information.
- Mock-driven attacks (`audit-leakage.test.ts`, passes): `Read ../idx/graphify-out/graph.json` (relative and absolute), `../../node_modules/...` and
  `/tmp/work/node_modules/...` (the symlink), `~/.claude/CLAUDE.md`, `$CLAUDE_CONFIG_DIR/CLAUDE.md`, the dataset patch by absolute path, `Grep ..`, `Grep /tmp/work`, `Glob /tmp/work/*/app/...`,
  a planted symlink to the dataset (Read, Grep and Glob) all fail with "outside ... --restricted confines the file tools" / "resolves through a symlink to ...";
  `Glob ../../**` and `Glob link_out/**` return "No files found". `.git/` is readable but holds one commit. The first request contains no owner text.
- Test files in the corpus are the upstream repo's own e2e tests (e.g. "should reset password only once per link"); they are identical across conditions, describe correct behaviour
  not the location, and are what a developer would have. Experiment-1 outputs are not reachable (outside the cwd). MCP logs go to `results/.../retrieval-logs` and `.cache`, outside the cwd.
- The leak that does exist is F-01 (other profiles) and the stale `/tmp/work` contents it exposes.

**2. User-environment isolation.** In mock mode: yes, convincingly. Positive control found the CLAUDE.md email/text, the skill listing and memory; every isolated profile did not;
`init` shows `skills=[]`, `slash_commands=[]`, only the three builtin plugins, tools exactly Glob/Grep/Read/StructuredOutput (+MCP), no Skill/Bash/Agent tool; `swift-lsp` absent. Residual risks (F-17): the OAuth path itself
(claude.ai connectors, org/managed policy, plan-dependent defaults such as effort, the system prefix), builtin plugin behaviour, the single 92-byte
`~/.claude/plugins/store/cc-plugin-agents-md_builtin-*.json` the children write, and sharing the owner's live config dir with their interactive sessions (concurrent state writes, shared rate limits). The `system/init` check is **partially implemented
(MCP `connected` only) and a mismatch excludes the run only for that one case** (F-03). Detection on the first real run is only as good as F-03; see the checklist.

**3. Fairness.** Prompts: system and task prompt are byte-identical across conditions (one `AGENT_SYSTEM_PROMPT`, one `agentTaskPrompt`; request `system` 612 chars in all four recorded conditions I inspected (baseline, bm25, graphify, crg)); the only request-level difference is CRG's server `instructions` (+335 chars) and the tool schemas.
Budgets: turn cap, timeout, budget flag identical (but see F-07, F-11); tool-output budgets are 4,000 for ours and native defaults for competitors (documented, not equalised). Read-only denial is applied symmetrically by the same mechanism and verified absent from the offered list (F-15 for the embedding consequence). Pre-warming: competitors' graph builds are outside
timing, ours includes model load inside timing, CRG's torch import is inside (F-09), so latency is not comparable until fixed; accuracy is not affected. Tool-count asymmetry (1 / 7 / 23 tools; 68 / 945 / 6,245 schema tokens) is intended and documented but not decomposed in the analysis (F-10). The baseline (Read/Grep/Glob, no Bash, no subagents, custom system prompt, forced structured output) is a fair, reasonably strong "grep and read" agent but not "Claude Code as users run it"; say that.
Our `search_code` description ("natural-language description, error message or identifier") matches what the retrievers were tuned on and is not what Graphify/CRG's lexical seeding likes; this affects RQ3 and H1a but not H1b (identical descriptions for `embeddings` and `hybrid`).

**4. Scoring validity.** `scoring.ts` is correct for all 20 tasks for canonical, `./`, `()`, last-segment, symbol-range and whole-file forms (47 audit cases pass). Pure deletion: ok within +-2 lines (F-20). `files_photo_url_01`: `FileType.path` / `path` resolve to the property, the class name alone gives RC=0 (strict, same as exp. 1), a free-text symbol with right lines is rescued by the line fallback. `roles_admin_guard_01`: `RolesGuard.canActivate` = 1, the class `RolesGuard` = RC 0 / line 1 (strict by design; `line_at_1` and `file_at_1` still credit it). Multi-line patches (`auth_jwt_secret_01` 14-16, `users_update_noop_01` 114-115) fine.
Relational/document twins are separated by file (right class in the document twin = RC 0). The real risk is path format (F-02, blocker), then F-12/F-13/F-14.

**5. Accounting.** Usage = sum of `modelUsage` over all models with input/output/cache-read/cache-write separate; `result.usage` is stored beside it; `cost_usd` = `total_cost_usd`; `api_duration_ms` stored; tool calls are de-duplicated by id and counted per tool; mcp calls = retrieval calls (verified with a canned stream). Latency is spawn to close (includes `claude` start-up and MCP start-up; see F-09). Runs without a result event have null usage/cost (never invented) which makes the task NaN in token/cost tables and records $0 in the ledger (F-07). Excluded runs go to `excluded.jsonl` and `meta.n_excluded`, but only the MCP-not-connected reason exists, and `report.md` does not mention them (F-03, F-10).

**6. Billing safety.** The approval gate cannot be bypassed accidentally: both `APPROVAL.json` (matching protocol, conditions, model string, split, cap) and `AGENT_EVAL_BILLABLE=1` are needed, refusal happens before spawn (tested), the child env is a whitelist (no stray `ANTHROPIC_*`, no `CLAUDECODE`), the default `agentic` command without `--mock-api` is the gated path, and no test or default command contacts the real API (the e2e tests use the real binary only against the local mock; `claudeSingleShot` refuses without approval). Weaknesses: F-06 (any loopback URL counts as mock), F-07 (cap is advisory under parallel, no per-run ceiling, killed runs ledgered as $0), F-08 (client-side price differs from list), F-05 (crash recovery re-spends and orphans paid children), F-01 (approval does not bind the profile). The cumulative ledger is global across stages (good: pilot spend counts toward the main cap).

**7. Statistics.** Unit = task, repeats averaged first, seeded paired bootstrap (5,000 resamples, seed 4321) with W/L/T: sound and as registered. Not sound/complete: the confirmatory set is not implemented as a set (F-10), the power statement is optimistic (F-10), `protocol.md` and code disagree on turn cap (F-11), on exclusion rules (F-03), on retrieval-cost reporting (F-09), on both-correct efficiency and repeat agreement (F-10), and `FROZEN.json` does not exist yet. Hybrid configs were tuned on the 6 dev tasks only and frozen before the exp. 1 test run; the agent run re-uses those 14 test tasks a second time with no further tuning (acceptable, state it).

**8. Other.** Model/version/effort pinning (F-11); prompt-cache state (F-16); subscription usage windows and rate limits (F-04: detect and halt); concurrency: at most about 3 GPU embedding servers fit a 6 GB GPU (the harness caps at 2); `--parallel` also multiplies F-07 and shares the owner's rate limit; the "Be efficient: do not read files you do not need" sentence in the system prompt biases turns/tokens downward for every condition equally (it is part of the frozen prompt; mention in the report).

## What I verified works (so you need not re-check)

Zero-billing safeguards; the whitelist env; refusal before spawn; workspace is a single-snapshot repo; no host/task/dataset strings in any MCP output of either competitor; read-only tool denial; strict MCP config actually removes other servers; out-of-workspace reads blocked under `restricted-oauth`; stream-json parsing, usage and cost extraction, stop-reason mapping, max-turns handling; scorer on all 20 tasks; the scoring of mock runs; 198 tests.

## Checks to perform on the first real (approved) run

Run the smoke pilot with one task and `baseline` only first (about $0.1-0.3), inspect, then widen. Stop on any failure.
1. `init` of that run (stored transcript, line 1): `apiKeySource` is not `ANTHROPIC_API_KEY` and is what you expect for the login; `model` = `claude-sonnet-5-5`; `claude_code_version` = 2.1.319; `tools` = `[Glob, Grep, Read, StructuredOutput]` plus exactly the condition's MCP tools (1 / 7 / 23); `mcp_servers` = `[]` for baseline, exactly one `connected` server otherwise, **no claude.ai connector**; `skills` = `[]`; `slash_commands` = `[]`; `plugins` = the three `builtin` ones; `permissionMode` = `dontAsk`; `agents` = the builtin five.
2. First-turn size fingerprint: the first assistant message's `input + cache_creation + cache_read` tokens should match the mock-recorded request size for the same condition (baseline about 3.0-3.4k real tokens; +68 / +945 / +6,245 for the MCP arms) within about 10%. Any excess is leaked context (the owner's CLAUDE.md alone is several hundred tokens).
3. Behavioural canary: grep the transcript's assistant text for the owner's email, "graphify", "knowledge graph", "CLAUDE.md", "skill", "memory"; none should appear. `permission_denials` = 0 and no tool call with a path outside the cwd or to `.git`.
4. Cost: compare `total_cost_usd` with the list-price recomputation from the four token classes (F-08); check `usage.cache_creation` for 1-hour (2x) cache entries; compare the ledger sum with the plan/console usage after the pilot and calibrate a multiplier for the cap.
5. Outcome plumbing: every run has a `structured_output`; `stop_reason` mix (target: submitted >= 90%; note max_turns rate and the turn distribution to choose the cap); count candidates whose `file` starts with `/` (F-02) and rescore offline.
6. Per condition: `retrieval_calls` > 0 for MCP arms; the tool names called; Graphify/CRG results contain no host path; `server_ready_ms` / `build_ms` captured (F-09).
7. Hygiene: `pgrep -fa 'claude|retrieval-server|embed_server|graphify-mcp|code-review-graph'` is empty afterwards; `git status` clean in kept workspaces; `~/.claude*` changes limited to the known plugin-store file; `/tmp/work` has no leftovers.
8. Rate/limit behaviour: run the first widened batch with `--parallel 1`; confirm that a forced early stop (set a tiny `--run-usd`) produces `stop_reason: budget` and that nothing is orphaned; only then raise parallelism (<= 2).
9. After the pilot: re-score from `raw-runs.jsonl` with the fixed scorer, run the confirmatory script on the dev pilot as a dry run (no conclusions), freeze prompts/schema/config in `FROZEN.json` (hash), then request the main-run approval with the measured cost per run and an explicit per-run ceiling.

## Files added by this audit

`experiments/02-agent-diagnosis/AUDIT.md` (this file), `tests/agent-eval/audit-scoring.test.ts`,
`tests/agent-eval/audit-harness.test.ts`, `tests/agent-eval/audit-leakage.test.ts`. No other file in the project was modified
(the audit runs wrote only to `/tmp`, the existing `.cache`, and the scratchpad).
