# Experiment 2: decision log

- **E2-D01** · Two protocols. *Agentic* (primary): a coding agent explores with tools. *Single-shot* (secondary): a model gets one method's retrieved context. · Agentic answers "does it help an agent"; single-shot isolates the value of the context itself and is cheap. · Single-shot only (wouldn't measure tool-use efficiency).
- **E2-D02** · The agent is Claude Code headless (`claude -p`), not a custom loop. · It is a real coding agent with native Read/Grep/Glob, so the baseline is how agents actually work today. There is no API key for a custom Messages loop.
- **E2-D03** · Isolation profile `restricted-oauth`: `--restricted`, `--strict-mcp-config`, `--tools Read,Grep,Glob`, `dontAsk`, `--disable-slash-commands`, CLAUDE.md/auto-memory disabled, custom system prompt. · Verified from recorded request bodies. `--bare` offers only Read (and requires an API key). `--safe-mode` drops `--mcp-config` servers.
- **E2-D04** · Zero-cost validation through a local mock of the Messages API (`ANTHROPIC_BASE_URL` + dummy key, so an ignored base URL means a 401, which is not billed). It records exactly what the model would receive and replays scripted tool calls. · The guide-suggested "start then interrupt" check risked partial billing.
- **E2-D05** · Workspaces: a `git archive` export of one single-bug snapshot, re-initialised as a single neutral commit, at `/tmp/work/<HMAC(task)>/app`. Node modules sit above the cwd. · Prevents history, branch and path leakage; CRG needs `.git`.
- **E2-D06** · Competitors through their **native** MCP servers, defaults, read-only. Write- and network-capable tools are denied in every condition (CRG refactor/wiki/embed, Graphify PR tools). · Their intended agent-driven use, which experiment 1 could not test. The tool-count asymmetry is reported, not equalised.
- **E2-D07** · Our methods are exposed as one `search_code` tool (same name, description, 4k budget for hybrid, custom_graph, embeddings and bm25), using the frozen experiment-1 configs. Query embeddings come from a persistent server (cosine ≥ 0.99999 vs experiment 1).
- **E2-D08** · Primary metric RC+line@1 (right function and pointing at the mutated lines ±2, with a range-width cap). Automatic and LLM-free; tested on all 20 tasks. · An LLM judge would add cost and judge bias.
- **E2-D09** · The unit of analysis is the task. Primary analysis on the 14 test tasks with 3 repeats. Confirmatory family H1a, H1b, H1c×2 and H2×2 with Holm correction.
- **E2-D10** · Independent audit before any approval request (READY-WITH-FIXES; 4 blockers, all fixed). Highlights:
  - absolute-path answers scored 0 (would have penalised CRG);
  - no init-fingerprint exclusion;
  - infrastructure errors scored as wrong;
  - no resume or orphan cleanup;
  - mock detection inferred from the environment (gateway bypass).
- **E2-D11** · Explicit billing mode (`subscription` | `api-key`), named in the approval and enforced by the child env, the approval check and the init `apiKeySource`. · The user's subscription hit its weekly limit during development, so API-key billing must be possible, but never by accident.
- **E2-D12** · Privacy fix. The isolation verifier's positive control (deliberately run without isolation) had stored raw request bodies containing the user's CLAUDE.md, memory and email, and the verifier hardcoded the email. Now: needles are read at runtime and reported only as hashes, control recordings are deleted after analysis, and the affected local, unpushed commit was amended and purged. No commit contains the data.
