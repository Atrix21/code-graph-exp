# Claude Code backend: isolation, command, verified behaviour

Code: `src/agent-eval/backends/claude-code.ts` (command builder, gate, stream parser), `agentic.ts` (runner / CLI),
`mock-anthropic/server.ts` (mock API), `verify-isolation.ts` (non-billable verification). Evidence:
`results/isolation-report.{md,json}` and raw request bodies / transcripts in `results/isolation-report-raw/`.
Tests: `tests/agent-eval/claude-code.test.ts`. Claude Code 2.1.319. **No billable call was made at any point.**

## 0. Zero-billing safeguards (all verified)

- Every invocation sets `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`, `ANTHROPIC_API_KEY=sk-ant-dummy-not-a-real-key`, and the
  child env is a whitelist (`PATH HOME USER LANG ... CLAUDE_CONFIG_DIR`), so `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`,
  `CLAUDECODE`, `CLAUDE_CODE_*` of the calling session never reach the child. `BillableGuard.assertAllowed` re-checks the final
  child env before spawning (localhost + dummy key + no tokens, else the real-API gate).
- Base-URL proof: `claude -p hi --bare --tools ""` against the mock: stdout was the mock's `OK`; mock saw
  `HEAD /api/hello` and `POST /v1/messages`. (A real call would have printed a model answer or a 401.)
- Request headers are never stored; only bodies (`MockRequestRecord` has no header field; tested).
- Real-API gate: `APPROVAL.json` + `AGENT_EVAL_BILLABLE=1` + cumulative cap (ledger `spend-ledger.jsonl`, persists across
  invocations; parallel runs can overshoot by the runs in flight). Tested, including "refuses before spawning".
  APPROVAL.json format: `{"approvals":[{"protocol":"agentic","conditions":["baseline","hybrid"]|"*","model":"claude-sonnet-5-5"|"*","split":"dev"|"test"|"all","max_total_usd":50}]}`
  (a single object or an array also works). The request's `max_total_usd` (CLI `--max-usd`, default: the largest approved cap)
  must be <= the approved one. The model string must match the approval literally (alias vs full id are different strings).
  Billable runs additionally require: profile `restricted-oauth` (F-01), a pinned model id such as `claude-sonnet-5-5` (aliases refused), and `--run-usd`.

## 1. Recommended commands

Build with `buildClaudeCommand` (cwd = workspace `/tmp/work/<opaque>/app`, prompt on stdin). Agentic, profile `restricted-oauth`:

```
claude -p --output-format stream-json --verbose --no-session-persistence --model claude-sonnet-5-5 \
  --restricted --disable-slash-commands --strict-mcp-config --mcp-config /tmp/agent-eval-mcp/<id>.json \
  --settings '{"permissions":{"blockReadsOutsideWorkingDirectories":true}}' \
  --system-prompt "$AGENT_SYSTEM_PROMPT" --system-prompt-snapshot off --json-schema "$DIAGNOSIS_SCHEMA" \
  --max-turns 40 [--max-budget-usd N] [--effort E] --permission-mode dontAsk --permission-prompts none \
  --tools Read,Grep,Glob --allowedTools "Read,Grep,Glob,mcp__<server>__*" \
  --disallowedTools "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,Task,Agent,Skill,TodoWrite,mcp__<server>__<denied tool>..." \
  < prompt
env: CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 CLAUDE_CODE_SKIP_PROMPT_HISTORY=1
     CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 NO_COLOR=1 ENABLE_CLAUDEAI_MCP_SERVERS=false
     MCP_TIMEOUT=180000 MCP_TOOL_TIMEOUT=120000 CLAUDE_CONFIG_DIR=<login dir> (no ANTHROPIC_* variables)
```
- Baseline: the same, with `{"mcpServers":{}}` and no `mcp__` entries. Conditions differ ONLY in the MCP server.
- Single-shot: same flags with `--tools ""` (no `--allowedTools`), `SINGLE_SHOT_SYSTEM_PROMPT`, `--max-turns 3`.
- Profile `bare` (API key only, `ANTHROPIC_API_KEY` required) and `safe-mode` are NOT suitable for the agentic protocol, see 2.
- Pins (F-11): model `claude-sonnet-5-5` (default; aliases refused when billable), `--effort high` (default, always passed, recorded per run;
  without it the mock saw `medium`), `--max-turns 40`, `DISABLE_AUTOUPDATER=1`. The Claude Code version is read once at start (`claude --version`) and every
  run's `system/init.claude_code_version` must equal it, else the experiment halts. User settings (`effortLevel`) are ignored under `--restricted`.
- MCP read-only policy (per lead): denied everywhere, absent from the offered tool list (verified):
  crg: `apply_refactor_tool generate_wiki_tool build_or_update_graph_tool embed_graph_tool run_postprocess_tool cross_repo_search_tool list_repos_tool`;
  graphify: `list_prs get_pr_impact triage_prs`. Allowed per server: `mcp__<server>__*` (server names: `retrieval`, `graphify`,
  `code-review-graph`). The exact allowed/denied lists per condition are in each run's `meta.json` (`tool_policy`).

## 2. Verified behaviour (mock API; evidence = recorded request bodies)

| Question | bare | restricted-oauth | safe-mode |
|---|---|---|---|
| User CLAUDE.md text in any request | no | no | no |
| Positive control (no isolation flags): CLAUDE.md email / "any input to knowledge graph" / skill listing / memory | found | n/a | n/a |
| Skill listing / Skill tool offered | no / no | no / no | no / no |
| Tools offered (agentic) | **Read only (+StructuredOutput): no Grep, no Glob** | Glob, Grep, Read, StructuredOutput (+`DeferredToolPlaceholder`) | Glob, Grep, Read, StructuredOutput (+placeholder) |
| `--mcp-config` servers load | yes (connected) | yes (connected) | **no** (`mcp_servers: []`, tools "No such tool") |
| Bash / WebFetch / Agent / Skill | not offered; call -> "No such tool available ... disabled" | same | same |
| cwd visible | no | yes (environment block, `/tmp/work/<opaque>/app`) | yes |
| Out-of-workspace Read (absolute and `../..`) | denied: "... is outside <ws>, /tmp; the permissions.blockReadsOutsideWorkingDirectories setting blocks reads ..." (note `/tmp` is also allowed as a working dir, which is why the dataset in /home is blocked but `/tmp/...` would not be) | denied: "... is outside <ws>; --restricted confines the file tools to the working directory." (Grep path outside too) | same as bare |
| `--max-turns 2` | `error_max_turns`, is_error true, num_turns 3, no structured_output | same | same |
| `structured_output` in result event | present | present | present |
| Result usage / cost (scripted 12-turn mock run) | ~33 in / ~520 out / ~54k cache_read / ~6.7k cache_write, $0.027 | ~33 / ~520 / ~70k / ~6.9k, $0.029 | same as restricted |
| Files written under `~/.claude*`, `~/.config/claude-accounts` | one tiny state file, see below | same | same |
| Writes into the workspace | none | none | none |

Other facts:
- `--restricted` ignores user settings (the user's `swift-lsp` plugin is absent from `init.plugins` there but listed under
  `--bare` and `--safe-mode`; it contributed no tool or prompt text).
- `--bare` runs in SIMPLE mode: `--tools Read,Grep,Glob` yields only `Read`. Grep/Glob are not available, so `bare` cannot run
  the same agent as the other profiles. `bare` also shows different MCP tool-schema sizes (crg: 4816 vs 6245 tokens, same 23 tools).
- All children write `~/.claude/plugins/store/cc-plugin-agents-md_builtin-*.json` (92 bytes, a queued usage row with a session id,
  all 18 isolated scenarios). Nothing else attributable (no `projects/`, `.claude.json`, transcripts, memory). The no-isolation
  control additionally wrote the account's `.claude.json` and a plugins/synced marker. A write-nothing guarantee would need a
  scratch `CLAUDE_CONFIG_DIR`, which cannot hold the OAuth login.
- With `--json-schema` the request carries a `StructuredOutput` tool; the mock calling it ends the run with `structured_output`.
  `--system-prompt` replaces the default prompt; the request system is: billing-header block, "You are a Claude agent, built on
  Anthropic's Claude Agent SDK.", then `AGENT_SYSTEM_PROMPT` (108 proxy tokens). The environment block (cwd, platform, date, model
  name) arrives as a `system`-role message.
- Tool-schema tokens per turn (proxy tokenizer, request `tools` array): baseline 1666 (Glob 157, Grep 776, Read 466, StructuredOutput 225,
  placeholder 41); +68 for `search_code`; graphify 945 with 3 PR tools denied (1410 without); crg 6245 with 7 tools denied (**8482 without**,
  30 tools, consistent with the 8.2k measured by the MCP layer).
- MCP status: `system/init.mcp_servers[].status == "connected"` for ours, graphify and crg. A run whose server is not connected is
  written to `excluded.jsonl` (`excluded: mcp_not_connected`), not `runs.jsonl`. (Its cost, if billable, is still counted.)
- Parallelism: `--parallel N` (default 1; mock runs are sequential by default); at most 2 embedding-backed servers (hybrid, embeddings) at
  once; with `--parallel > 1`, each snapshot's custom-graph cache is warmed once first. Workspaces are built BEFORE
  `competitorServerSpec` (it needs `/tmp/work/<opaque>/`). Process groups are killed after each run (no orphaned embed servers).
- Run records: `ScoredRun` plus `profile, workspace_modified, permission_denials, api_duration_ms, usage_result_event, mcp_status`.
  `usage` = sum of `modelUsage` (all models), `usage_result_event` = `result.usage` (identical in all mock runs); cache tokens
  separate; `cost_usd` = `total_cost_usd`; `stop_reason`: `success`+diagnosis -> submitted, `error_max_turns` -> max_turns,
  `error_max_budget_usd` -> budget, our kill -> timeout, else error. Diagnosis: `structured_output`, else lenient parse of `result`,
  else the last `StructuredOutput` call in the stream.

## 3. Could not be verified without billing

- The OAuth path itself. Mock mode necessarily uses the API-key path (dummy key). Request bodies under a subscription login may differ
  (billing-header block, beta flags, system prefix). `ENABLE_CLAUDEAI_MCP_SERVERS=false` is set to keep account-level claude.ai
  connectors out; in mock mode Claude Code printed that connectors are skipped because an API key is set, so with a real login this is
  unobserved. Check `system/init` (`mcp_servers`, `tools`) of the first real run before continuing.
- Real model behaviour: StructuredOutput validation/retry loops against a real model, how often the real model hits `--max-turns`,
  real cache-token split and `total_cost_usd`, `--max-budget-usd` enforcement (`error_max_budget_usd` mapping is from the docs),
  rate limits / 529s, whether the agent tries paths like `/tmp/...` (a `/tmp` working dir is added by Claude Code under
  `blockReadsOutsideWorkingDirectories` for bare/safe-mode, not for `--restricted`).
- Whether the real default model changes effort/thinking settings between conditions (identical flags make it equal across conditions).
- Latency and `duration_api_ms` (mock values are meaningless).

## 4. Issues found in other code (not modified)

- `src/cli/commands.ts` `selectTasks` reads the global `--tasks` flag as the tasks DIRECTORY, which collides with `--tasks id,..`
  of `single` and `agentic`. `agentic.ts` and the single-shot gate avoid it (they use `loadTasks`); `runSingleShot` in `runner.ts`
  still calls `selectTasks` and therefore breaks with `--tasks id`.
- `tsc` currently reports an error in `backends/single-shot.ts` (`localQwen`, `let r = spawnSync('true')` typed as Buffer), from a
  concurrent edit of that file.

## 5. Audit fixes (F-01, F-03 .. F-05, F-07 .. F-09, F-11, F-15, F-16)

All verified with the mock API and fake `claude` binaries (`tests/agent-eval/{claude-code,agentic-harness,audit-harness}.test.ts`).

- **F-03 init fingerprint.** `checkInit` compares every run's `system/init` with the condition's expected set: exactly Read, Grep, Glob, StructuredOutput plus the
  condition's allowed MCP tools (exact names in `EXPECTED_MCP_TOOLS`: ours 1, graphify 7, crg 23), no denied MCP tool, `skills=[]`, plugins all `builtin`,
  slash commands only the server's own MCP prompts (`mcp__<server>__*`; CRG ships five, they are not tools), `mcp_servers` = exactly the condition's server and
  `connected`, `model` = pinned id, version = start version, `permissionMode=dontAsk`, and (real mode) `apiKeySource` not an API key. The init is stored per run
  (`init`). On a mismatch the process group is killed at once (demo: injected `Bash` -> 0 API requests reached the mock), the run goes to `excluded.jsonl`
  (`init_mismatch:<categories>`, not retryable, never scored); 2 consecutive exclusions with the same reason halt the experiment; a version change halts at once.
  `mcp_not_connected` is a retryable exclusion. Real-run caveat: in the isolation report `bare` and `safe-mode` fail this check (missing Grep/Glob, user plugin), which is
  one more reason billable mode accepts only `restricted-oauth`.
- **F-04 outcomes.** `submitted`, `max_turns`, `budget`, `no_structured_output` are scored (the last two as invalid/failed). `infra_error` (kinds `auth limit api_error crash
  no_result timeout spawn harness`; an `is_error` result with `subtype: success` is how Claude Code reports API and limit errors) is never scored: it goes to
  `excluded.jsonl` and is retried once with a fresh workspace. Halt after 3 consecutive infra errors, at once on `auth` or `limit`. Mock demos: HTTP 401 ->
  `infra_error:auth`; HTTP 429 "usage limit" -> immediate halt (`results/validate-agentic-mock-infra-limit`); injected Bash -> halt after 2 (`...-extra-tool`).
- **F-05 resume/orphans.** Nothing is deleted. `plan.json` (seeded shuffle + config) is written once; re-running a `--run` resumes (config must match). Each run is appended at
  once to `raw-runs.jsonl`, then scored into `runs.jsonl` (or `excluded.jsonl`), plus a `ledger.jsonl` line (cost reported/list/ledger, tokens, status). Finished run_ids
  and finally excluded ones are skipped; unscored raw records are scored on start. A worker error becomes an infra exclusion, other workers continue.
  `claude` runs in its own process group; the CLI installs SIGINT/SIGTERM/exit/uncaught handlers that write `aborted`/`crashed` ledger lines (charging each in-flight run's
  reservation to the spend ledger when billable) and kill every child group. Halting also kills in-flight runs (recorded as `aborted`, re-run on resume, not an attempt).
- **F-07/F-08 cost.** `--run-usd` is required when billable; it is the per-run `--max-budget-usd` and the reservation. Before each run:
  `spent + in_flight x run_usd + run_usd <= max_total_usd` (the spend ledger is shared across invocations). Ledger cost = max(Claude Code's `total_cost_usd`, our
  list-price recomputation from usage per model: Sonnet 2/10/0.20/2.50, Haiku 0.10/0.50/0.01/0.125, Opus 4/20/0.20/5, unknown = Opus). Both are recorded
  (`cost_reported_usd`, `cost_list_usd`, `cost_ledger_usd`). A run that dies without a result event is charged from the per-message usage in the stream, or the full reservation if it
  timed out or was aborted with no usage seen. In the mock runs the list price is 7-10% above Claude Code's number (cache-read $0.10 vs $0.20).
- **F-09 latency.** Per run: `wall_ms` (= `latency_ms`, spawn to result event), `duration_ms`, `api_duration_ms`, `init_ms`, `mcp_startup_ms` (= `init_ms` when an MCP server is
  attached: an upper-bound estimate that includes Claude Code's own start-up of ~0.2 s, compare with the baseline's `init_ms`), `index_build_ms` (competitor `build_ms`; for
  hybrid/custom_graph the shared custom-graph cache warm-up, done once per snapshot always, not only with `--parallel`; null for embeddings/bm25 whose server prepares inside
  the MCP process and logs it only to stderr). Note `wall_ms` of hybrid/embeddings still contains the ~5 s embedding-model load inside the first tool call.
- **F-15** the CRG arm is labelled `crg-default-fts` (`condition_label`, `meta.condition_labels`); condition id stays `agentic:crg`.
- **F-16** run order = one seeded shuffle (seed 20261108) of all (task, condition, repeat) items, in `plan.json` and `meta.json`; each run records `position`.
- **Not done here:** moving `WORK_ROOT` out of /tmp (F-01 second half; `workspace.ts` is not mine; moot under `restricted-oauth`, which denies /tmp),  and scorer changes (F-02, lead). `runAgentic` calls `scoreDiagnosis(index, task, bugs, diagnosis)` unchanged.
- **F-06 (fixed).** Mock mode is never inferred from the environment. `BillableGuard` accepts a child as mock only if its `ANTHROPIC_BASE_URL` is `http://127.0.0.1:<port>` of a mock server started by this process (`isOwnMockUrl`, registry in `mock-anthropic/server.ts`), with the dummy key and no tokens; anything else with a base URL is refused. `buildClaudeCommand` takes an explicit `mockUrl` and sets the base URL itself; non-mock child envs are whitelists and never inherit `ANTHROPIC_BASE_URL` (no gateway support). `claudeSingleShot` takes `opts.mockUrl` instead of reading `process.env`.
