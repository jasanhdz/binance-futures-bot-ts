#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$root_dir/scripts/lib/micro-burst-m3_2_2-soak.sh"

log_file="$(mktemp)"
trap 'rm -f "$log_file"' EXIT
export SOAK_LOG_FILE="$log_file"

printf '%s\n' '{"msg":"MICRO_BURST_SHADOW_HEALTH","ctx":{"phase":"graceful_shutdown","archiveQueueDepth":0,"archiveQueuedRecords":7,"archiveWrittenRecords":7,"archiveOverflowRecords":0}}' > "$log_file"
soak_verify_final_health >/dev/null

printf '%s\n' '{"msg":"MICRO_BURST_SHADOW_HEALTH","ctx":{"phase":"graceful_shutdown","archiveQueueDepth":0,"archiveQueuedRecords":7,"archiveWrittenRecords":6,"archiveOverflowRecords":0}}' > "$log_file"
if soak_verify_final_health >/dev/null 2>&1; then
  printf 'expected queue discrepancy to fail\n' >&2
  exit 1
fi

printf '%s\n' '{"msg":"MICRO_BURST_SHADOW_HEALTH","ctx":{"phase":"periodic","archiveQueueDepth":0,"archiveQueuedRecords":7,"archiveWrittenRecords":7,"archiveOverflowRecords":0}}' > "$log_file"
if soak_verify_final_health >/dev/null 2>&1; then
  printf 'expected missing graceful shutdown health to fail\n' >&2
  exit 1
fi

printf 'micro-burst M3.2.2 soak helper tests passed\n'
