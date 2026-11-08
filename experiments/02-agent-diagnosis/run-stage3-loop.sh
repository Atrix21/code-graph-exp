#!/usr/bin/env bash
# Auto-resume wrapper for stage 3 on a subscription login. Runs run-stage3.sh; when it halts on a plan usage limit
# ("You've hit your 5-hour limit · resets 12:30am"), sleeps until the stated reset (+3 min) and resumes. Any other halt
# or error stops the loop for inspection. To stop it: touch experiments/02-agent-diagnosis/STOP (checked between runs
# and every minute while sleeping), or kill this script (the harness kills its own children on SIGTERM).
set -u
cd "$(dirname "$0")/../.."
EXP=experiments/02-agent-diagnosis
LOG=$EXP/results/stage3.log
for i in $(seq 1 60); do
  [ -f $EXP/STOP ] && { echo "=== $(date -Is) STOP file present; exiting"; exit 0; }
  $EXP/run-stage3.sh >> "$LOG" 2>&1 && { echo "=== $(date -Is) stage 3 complete"; exit 0; }
  last=$(ls -t $EXP/results/stage3-*/excluded.jsonl $EXP/results/stage3-*/ss-raw.jsonl 2>/dev/null | head -1)
  msg=$(grep -h -oE "(hit your [^|\"]*limit[^|\"]*resets [^(|\"]*)" "$last" 2>/dev/null | tail -1)
  if ! tail -40 "$LOG" | grep -qiE "HALT: .*limit"; then echo "=== $(date -Is) halted for a reason other than a usage limit; stopping for inspection"; tail -5 "$LOG"; exit 1; fi
  when=$(echo "$msg" | sed -E 's/.*resets //; s/[·,]//g; s/ +$//')
  target=$(date -d "$when" +%s 2>/dev/null || echo 0)
  now=$(date +%s)
  if [ "$target" -le 0 ]; then target=$((now + 3600)); fi
  while [ "$target" -le "$now" ]; do target=$((target + 86400)); done
  target=$((target + 180))
  echo "=== $(date -Is) usage limit ('$msg'); sleeping until $(date -d @$target -Is)" | tee -a "$LOG"
  while [ "$(date +%s)" -lt "$target" ]; do [ -f $EXP/STOP ] && { echo "=== $(date -Is) STOP file present; exiting" | tee -a "$LOG"; exit 0; }; sleep 60; done
done
echo "=== $(date -Is) too many resume cycles; stopping"; exit 1
