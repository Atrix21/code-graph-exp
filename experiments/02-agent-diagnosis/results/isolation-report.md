# Claude Code isolation report (mock API, no billable calls)

Claude Code 2.1.319 (Claude Code); generated 2026-11-08T14:02:29.737Z. Every call used ANTHROPIC_BASE_URL=http://127.0.0.1:<port> with a dummy API key. All findings are read from the recorded request bodies and the stream-json output. Raw material: `results/isolation-report-raw/`.

## Per scenario (agentic protocol)

| profile | condition | ran | tools offered | tool-schema tokens | MCP tools | MCP as expected | CLAUDE.md text in request | skill listing | cwd visible | banned tools offered |
|---|---|---|---|---:|---|---|---|---|---|---|
| control | baseline | yes | Read, DeferredToolPlaceholder | 3720 | 25: mcp__android__adb_shell, mcp__android__clear_logs, mcp__android__doubl… | no | YES any input to knowledge graph; user's private global instructions; invoke the Skill tool with | YES claude-md-line#2c36ca3471 | yes | none |
| bare | baseline | yes | Read, StructuredOutput | 485 | none | yes | no | no | no | none |
| bare | bm25 | yes | Read, StructuredOutput | 551 | 1: mcp__retrieval__search_code | yes | no | no | no | none |
| bare | graphify | yes | Read, StructuredOutput | 1428 | 7: mcp__graphify__get_community, mcp__graphify__get_neighbors, mcp__graph… | yes | no | no | no | none |
| bare | crg | yes | Read, StructuredOutput | 5299 | 23: mcp__code-review-graph__detect_changes_tool, mcp__code-review-graph__f… | yes | no | no | no | none |
| restricted-oauth | baseline | yes | Glob, Grep, Read, DeferredToolPlaceholder, StructuredOutput | 1672 | none | yes | no | no | yes | none |
| restricted-oauth | bm25 | yes | Glob, Grep, Read, StructuredOutput, DeferredToolPlaceholder | 1738 | 1: mcp__retrieval__search_code | yes | no | no | yes | none |
| restricted-oauth | graphify | yes | Glob, Grep, Read, StructuredOutput, DeferredToolPlaceholder | 2615 | 7: mcp__graphify__get_community, mcp__graphify__get_neighbors, mcp__graph… | yes | no | no | yes | none |
| restricted-oauth | crg | yes | Glob, Grep, Read, StructuredOutput, DeferredToolPlaceholder | 7915 | 23: mcp__code-review-graph__detect_changes_tool, mcp__code-review-graph__f… | yes | no | no | yes | none |
| safe-mode | baseline | yes | Glob, Grep, Read, DeferredToolPlaceholder, StructuredOutput | 1672 | none | yes | no | no | yes | none |
| safe-mode | bm25 | yes | Glob, Grep, Read, DeferredToolPlaceholder, StructuredOutput | 1672 | none | no | no | no | yes | none |
| safe-mode | graphify | yes | Glob, Grep, Read, DeferredToolPlaceholder, StructuredOutput | 1672 | none | no | no | no | yes | none |
| safe-mode | crg | yes | Glob, Grep, Read, DeferredToolPlaceholder, StructuredOutput | 1672 | none | no | no | no | yes | none |

Positive control (no isolation flags, `--tools Read`, same mock API): CLAUDE.md strings found: any input to knowledge graph; user's private global instructions; invoke the Skill tool with; userEmail in messages[0:user]; skill listing hits: claude-md-line#2c36ca3471; memory hits: yes; tools offered: 27 (Read, mcp__android__adb_shell, mcp__android__clear_logs, mcp__android__double_tap, mcp__android__get_current_activity, mcp__android__get_device_info, mcp__android__get_logs, mcp__android__get_ui_tree, mcp__android__install_apk, mcp__android__launch_app, mcp__android__list_avds, mcp__android__list_devices...); system+tools tokens: 1320 + 3720.

## Init-fingerprint check (`checkInit`, applied to every run; a mismatch kills the run and excludes it)

| profile | condition | mismatch categories |
|---|---|---|
| bare | baseline | **missing_tool, plugins** |
| bare | bm25 | **missing_tool, plugins** |
| bare | graphify | **missing_tool, plugins** |
| bare | crg | **missing_tool, plugins** |
| restricted-oauth | baseline | none (matches expected set) |
| restricted-oauth | bm25 | none (matches expected set) |
| restricted-oauth | graphify | none (matches expected set) |
| restricted-oauth | crg | none (matches expected set) |
| safe-mode | baseline | **plugins** |
| safe-mode | bm25 | **mcp_servers, missing_tool, plugins** |
| safe-mode | graphify | **mcp_servers, missing_tool, plugins** |
| safe-mode | crg | **mcp_servers, missing_tool, plugins** |

### Exclusion demonstrations (restricted-oauth, baseline)

- `demo:inject-extra-tool`: outcome `init_mismatch` (extra_tool); init check: extra_tool - unexpected tool: Bash; tools in init: Bash, Glob, Grep, Read, StructuredOutput; API requests received by the mock: 0
- `demo:infra-401`: outcome `infra_error:auth` (error result: Invalid API key · Fix external API key); init check: none; tools in init: Glob, Grep, Read, DeferredToolPlaceholder, StructuredOutput; API requests received by the mock: 1

## MCP tool surface (read-only policy)

| profile | condition | MCP status | MCP tools offered | tokens of MCP tool schemas per turn | denied tools expected | denied tools offered | attempt to call a denied tool |
|---|---|---|---:|---:|---:|---|---|
| bare | bm25 | connected | 1 | 68 | 0 | none (absent) | - |
| bare | graphify | connected | 7 | 945 | 3 | none (absent) | `<tool_use_error>Error: No such tool available: mcp__graphify__list_prs</tool_use_error>` |
| bare | crg | connected | 23 | 4816 | 7 | none (absent) | `<tool_use_error>Error: No such tool available: mcp__code-review-graph__apply_refactor_tool</tool_use_error>` |
| restricted-oauth | bm25 | connected | 1 | 68 | 0 | none (absent) | - |
| restricted-oauth | graphify | connected | 7 | 945 | 3 | none (absent) | `<tool_use_error>Error: No such tool available: mcp__graphify__list_prs</tool_use_error>` |
| restricted-oauth | crg | connected | 23 | 6245 | 7 | none (absent) | `<tool_use_error>Error: No such tool available: mcp__code-review-graph__apply_refactor_tool</tool_use_error>` |
| restricted-oauth | graphify(no-deny) | connected | 10 | 1410 | 0 | none (absent) | - |
| restricted-oauth | crg(no-deny) | connected | 30 | 8482 | 0 | none (absent) | - |
| safe-mode | bm25 | NOT connected | 0 | 1 | 0 | none (absent) | - |
| safe-mode | graphify | NOT connected | 0 | 1 | 3 | none (absent) | `<tool_use_error>Error: No such tool available: mcp__graphify__list_prs</tool_use_error>` |
| safe-mode | crg | NOT connected | 0 | 1 | 7 | none (absent) | `<tool_use_error>Error: No such tool available: mcp__code-review-graph__apply_refactor_tool</tool_use_error>` |

## Result event of the scripted mock run (baseline condition)

| profile | subtype | is_error | num_turns | structured_output | total_cost_usd | usage (input / output / cache_read / cache_write) | permission_denials |
|---|---|---|---:|---|---:|---|---:|
| bare | success | false | 12 | present | 0.027539800000000007 | 33 / 525 / 54363 / 6715 | 2 |
| restricted-oauth | success | false | 12 | present | 0.029427599999999998 | 33 / 521 / 69916 / 6864 | 3 |
| safe-mode | success | false | 12 | present | 0.029631699999999997 | 33 / 521 / 70407 / 6926 | 3 |

## Out-of-workspace reads and banned tool attempts (baseline condition)

### bare

- Forbidden dataset read (absolute path): denied=true; tool_result: `/home/adityareddy/dev/experiments/code-graphs/evaluation/dataset/tasks/auth_jwt_secret_01.json is outside /tmp/work/87ba94e5b0/app, /tmp; the permissions.blockReadsOutsideWorkingDirectories setting blocks reads outside the working directories. Ask the user to add the directory with /add-dir, or to r…`
- Other outside access {"file_path":"../../../../etc/hostname"}: denied=true; `/etc/hostname is outside /tmp/work/87ba94e5b0/app, /tmp; the permissions.blockReadsOutsideWorkingDirectories setting blocks reads outside the working directories. Ask the user to add the directory with /add-dir, or to remove that setting.`
- Other outside access {"pattern":"x","path":"/etc"}: denied=true; `<tool_use_error>Error: No such tool available: Grep. Grep is not among the tools available here. Continue with the tools you have.</tool_use_error>`
- Attempted Bash: `[error] <tool_use_error>Error: No such tool available: Bash. Bash is disabled for this session, in subagents as well as here.</tool_use_error>`
- Attempted WebFetch: `[error] <tool_use_error>Error: No such tool available: WebFetch. WebFetch is disabled for this session, in subagents as well as here.</tool_use_error>`
- Attempted Agent: `[error] <tool_use_error>Error: No such tool available: Agent. Agent is disabled for this session, in subagents as well as here.</tool_use_error>`
- Attempted Skill: `[error] <tool_use_error>Error: No such tool available: Skill. Skill is disabled for this session, in subagents as well as here.</tool_use_error>`
- Workspace file changes during the run: +0 ~0 -0
- Files written under ~/.claude*, ~/.config/claude-accounts attributable to this run: `/home/adityareddy/.claude/plugins/store/cc-plugin-agents-md_builtin-b049b47b3618.json` (0 other changed files from concurrent sessions)
- cwd visible in: nowhere
- Init: skills=[] slash_commands=[] agents=["claude","Explore","general-purpose","Plan","statusline-setup"] plugins=["swift-lsp","cc-plugin-agents-md","cc-plugin-privacy","cc-plugin-plugin-authoring"] permissionMode=dontAsk
- System prompt (108 proxy tokens): `x-anthropic-billing-header: cc_version=2.1.319.3d1; cc_entrypoint=sdk-cli; You are a Claude agent, built on Anthropic's Claude Agent SDK. You are a senior software engineer diagnosing a bug in the codebase in your current working directory. You can read and search files but you cannot run code, run tests, use git, or modify files. Investigate until you are confident, then give your diagnosis. Be efficient: do not read files you do not need.`

### restricted-oauth

- Forbidden dataset read (absolute path): denied=true; tool_result: `/home/adityareddy/dev/experiments/code-graphs/evaluation/dataset/tasks/auth_jwt_secret_01.json is outside /tmp/work/87ba94e5b0/app; --restricted confines the file tools to the working directory.`
- Other outside access {"file_path":"../../../../etc/hostname"}: denied=true; `/etc/hostname is outside /tmp/work/87ba94e5b0/app; --restricted confines the file tools to the working directory.`
- Other outside access {"pattern":"x","path":"/etc"}: denied=true; `/etc is outside /tmp/work/87ba94e5b0/app; --restricted confines the file tools to the working directory.`
- Attempted Bash: `[error] <tool_use_error>Error: No such tool available: Bash. Bash is disabled for this session, in subagents as well as here.</tool_use_error>`
- Attempted WebFetch: `[error] <tool_use_error>Error: No such tool available: WebFetch. WebFetch is disabled for this session, in subagents as well as here.</tool_use_error>`
- Attempted Agent: `[error] <tool_use_error>Error: No such tool available: Agent. Agent is disabled for this session, in subagents as well as here.</tool_use_error>`
- Attempted Skill: `[error] <tool_use_error>Error: No such tool available: Skill. Skill is disabled for this session, in subagents as well as here.</tool_use_error>`
- Workspace file changes during the run: +0 ~0 -0
- Files written under ~/.claude*, ~/.config/claude-accounts attributable to this run: none (1 other changed files from concurrent sessions)
- cwd visible in: messages[1:system]
- Init: skills=[] slash_commands=[] agents=["claude","Explore","general-purpose","Plan","statusline-setup"] plugins=["cc-plugin-agents-md","cc-plugin-privacy","cc-plugin-plugin-authoring"] permissionMode=dontAsk
- System prompt (108 proxy tokens): `x-anthropic-billing-header: cc_version=2.1.319.3d1; cc_entrypoint=sdk-cli; You are a Claude agent, built on Anthropic's Claude Agent SDK. You are a senior software engineer diagnosing a bug in the codebase in your current working directory. You can read and search files but you cannot run code, run tests, use git, or modify files. Investigate until you are confident, then give your diagnosis. Be efficient: do not read files you do not need.`

### safe-mode

- Forbidden dataset read (absolute path): denied=true; tool_result: `/home/adityareddy/dev/experiments/code-graphs/evaluation/dataset/tasks/auth_jwt_secret_01.json is outside /tmp/work/87ba94e5b0/app, /tmp; the permissions.blockReadsOutsideWorkingDirectories setting blocks reads outside the working directories. Ask the user to add the directory with /add-dir, or to r…`
- Other outside access {"file_path":"../../../../etc/hostname"}: denied=true; `/etc/hostname is outside /tmp/work/87ba94e5b0/app, /tmp; the permissions.blockReadsOutsideWorkingDirectories setting blocks reads outside the working directories. Ask the user to add the directory with /add-dir, or to remove that setting.`
- Other outside access {"pattern":"x","path":"/etc"}: denied=true; `/etc is outside /tmp/work/87ba94e5b0/app, /tmp; the permissions.blockReadsOutsideWorkingDirectories setting blocks reads outside the working directories. Ask the user to add the directory with /add-dir, or to remove that setting.`
- Attempted Bash: `[error] <tool_use_error>Error: No such tool available: Bash. Bash is disabled for this session, in subagents as well as here.</tool_use_error>`
- Attempted WebFetch: `[error] <tool_use_error>Error: No such tool available: WebFetch. WebFetch is disabled for this session, in subagents as well as here.</tool_use_error>`
- Attempted Agent: `[error] <tool_use_error>Error: No such tool available: Agent. Agent is disabled for this session, in subagents as well as here.</tool_use_error>`
- Attempted Skill: `[error] <tool_use_error>Error: No such tool available: Skill. Skill is disabled for this session, in subagents as well as here.</tool_use_error>`
- Workspace file changes during the run: +0 ~0 -0
- Files written under ~/.claude*, ~/.config/claude-accounts attributable to this run: `/home/adityareddy/.claude/plugins/store/cc-plugin-agents-md_builtin-b049b47b3618.json` (0 other changed files from concurrent sessions)
- cwd visible in: messages[1:system]
- Init: skills=[] slash_commands=[] agents=["claude","Explore","general-purpose","Plan"] plugins=["swift-lsp","cc-plugin-agents-md","cc-plugin-privacy","cc-plugin-plugin-authoring"] permissionMode=dontAsk
- System prompt (108 proxy tokens): `x-anthropic-billing-header: cc_version=2.1.319.3d1; cc_entrypoint=sdk-cli; You are a Claude agent, built on Anthropic's Claude Agent SDK. You are a senior software engineer diagnosing a bug in the codebase in your current working directory. You can read and search files but you cannot run code, run tests, use git, or modify files. Investigate until you are confident, then give your diagnosis. Be efficient: do not read files you do not need.`

## --max-turns 2 (12-step script)

| profile | subtype | is_error | num_turns | structured_output | stop_reason(mapped by our parser) |
|---|---|---|---:|---|---|
| bare | error_max_turns | true | 3 | absent | max_turns |
| restricted-oauth | error_max_turns | true | 3 | absent | max_turns |
| safe-mode | error_max_turns | true | 3 | absent | max_turns |

## Single-shot (`--tools ""`, json-schema)

| profile | tools offered | structured_output | num_turns | cost_usd | tool-schema tokens | system prompt tokens |
|---|---|---|---:|---:|---:|---:|
| bare | StructuredOutput | present | 2 | 0.0008557000000000001 | 208 | 65 |
| restricted-oauth | DeferredToolPlaceholder, StructuredOutput | present | 2 | 0.0014206 | 273 | 65 |
| safe-mode | DeferredToolPlaceholder, StructuredOutput | present | 2 | 0.0014681 | 273 | 65 |

## Files written outside the workspace

Per-scenario before/after listings (changed paths seen by 22 isolated scenarios; a path seen in nearly all of them is written by the children, a path seen once is another live session): `~/.claude/plugins/store/cc-plugin-agents-md_builtin-b049b47b3618.json` x22; `~/.claude/projects/-home-adityareddy-dev-experiments-code-graphs/23e3bc90-9e59-4b21-8b1a-a3b8f2648e0b.jsonl` x4; `~/.claude/plugins/store/cc-plugin-diff_builtin-3903e77c01b1.json` x1.
The no-isolation control additionally wrote: `~/.claude/plugins/store/cc-plugin-agents-md_builtin-b049b47b3618.json`, `~/.claude/backups/.claude.json.backup.1794146507487`, `~/.claude/plugins/synced/844d688b-1262-461a-bbee-85143f6da0ca_1443505e-7930-4a5b-96c2-54a90b3e8e67/.last-complete-round`, `~/.claude/skills/synced/844d688b-1262-461a-bbee-85143f6da0ca_1443505e-7930-4a5b-96c2-54a90b3e8e67/.last-complete-round`, `~/.claude/skills/synced/844d688b-1262-461a-bbee-85143f6da0ca_1443505e-7930-4a5b-96c2-54a90b3e8e67/manifest.json`, `~/.claude.json`.

Listing of /home/adityareddy/.claude, /home/adityareddy/.claude.json, /home/adityareddy/.config/claude-accounts before/after the whole run: 6839 -> 6839 files; added 1, changed 8, removed 1.

- Attributable to the verify children (mention a child session id or the workspace path): **2**
  - `/home/adityareddy/.claude/plugins/store/cc-plugin-agents-md_builtin-b049b47b3618.json`
  - `/home/adityareddy/.claude/projects/-home-adityareddy-dev-experiments-code-graphs/23e3bc90-9e59-4b21-8b1a-a3b8f2648e0b.jsonl`
- Unattributed changes (other live sessions): 7. Unattributed changes come from OTHER live Claude Code sessions (including the one running this script); they mention neither a verify child session id nor the verify workspace path.

Tool schema tokens per tool (baseline, restricted-oauth):

- Glob: 157
- Grep: 776
- Read: 466
- DeferredToolPlaceholder: 41
- StructuredOutput: 231
