#!/usr/bin/env bash
# Stage 2 (dev pilot): strictly sequential, one claude process at a time; stops at the first halt or error.
# Re-running resumes each step (finished runs are skipped).
set -u
cd "$(dirname "$0")/../.."
T4=auth_reset_link_reuse_01,auth_social_link_01,auth_update_email_dup_01,users_update_noop_01
T6=auth_refresh_expiry_01,session_refresh_replay_01,$T4
C=baseline,embeddings,hybrid,graphify,crg
run() { echo "=== $(date -Is) $*"; claude-account run personal env AGENT_EVAL_BILLABLE=1 npx tsx src/agent-eval/cli.ts "$@" || { echo "STOPPED (exit $?) at: $*"; exit 1; }; }
run agentic --split dev --conditions $C --task-ids $T4 --repeats 1 --prompt p1 --account personal --run-usd 1 --max-usd 15 --parallel 1 --run stage2-agentic-dev-p1
run agentic --split dev --conditions $C --task-ids $T6 --repeats 1 --prompt p2 --account personal --run-usd 1 --max-usd 15 --parallel 1 --run stage2-agentic-dev-p2
for b in 2000 8000; do
  run single --backend claude-code --split dev --budget $b --repeats 1 --task-ids $T4 --account personal --run-usd 0.25 --max-usd 15 --run stage2-single-dev-$b
done
echo "=== $(date -Is) STAGE 2 DONE"
