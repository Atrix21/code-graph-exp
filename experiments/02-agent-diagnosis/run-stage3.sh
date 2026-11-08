#!/usr/bin/env bash
# Stage 3 (main run, test split; protocol Amendment A). Strictly sequential: one claude process at a time.
# Stops at the first halt (e.g. a usage limit) or error; re-running resumes every step (finished runs are skipped).
set -u
cd "$(dirname "$0")/../.."
C=baseline,embeddings,hybrid,graphify,crg
run() { echo "=== $(date -Is) $*"; claude-account run personal env AGENT_EVAL_BILLABLE=1 npx tsx src/agent-eval/cli.ts "$@" || { echo "STOPPED (exit $?) at: $*"; exit 1; }; }
run agentic --split test --conditions $C --repeats 3 --prompt p2 --account personal --run-usd 1 --max-usd 75 --parallel 1 --run stage3-agentic-test-p2
for b in 2000 8000; do
  run single --backend claude-code --split test --budget $b --repeats 3 --account personal --run-usd 0.25 --max-usd 75 --run stage3-single-test-$b
done
run agentic --split test --conditions $C --repeats 3 --prompt p1 --account personal --run-usd 1 --max-usd 75 --parallel 1 --run stage3-agentic-test-p1
echo "=== $(date -Is) STAGE 3 DONE"
