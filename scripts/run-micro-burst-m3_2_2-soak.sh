#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
seconds="${SOAK_SECONDS:-300}"
env_file="${SOAK_ENV_FILE:-}"
log_dir="$root_dir/logs/micro-burst/m3_2_2-soak"
log_file="$log_dir/soak-$(date -u +%Y%m%dT%H%M%SZ).log"

[[ -n "$env_file" && -f "$env_file" ]] || { printf 'Set SOAK_ENV_FILE to a local env file based on config/m3_2_2_soak.env.example.\n' >&2; exit 2; }
set -a
source "$env_file"
set +a

export SOAK_ROOT_DIR="$root_dir"
export SOAK_SECONDS="$seconds"
export SOAK_CONFIG_FILE="$root_dir/config/micro-burst-m3_2_2-soak.yaml"
export SOAK_DIST_FILE="$root_dir/dist/main.js"
export SOAK_LOG_FILE="$log_file"

source "$root_dir/scripts/lib/micro-burst-m3_2_2-soak.sh"
soak_preflight

export REGIME_CONFIG="$SOAK_CONFIG_FILE"
export TRADING_MODE='AEGIS_SHADOW'
export AEGIS_LIVE_ENABLED='0'
export TELEGRAM_COMMANDS_ENABLED='0'
export LOG_PRETTY='0'
mkdir -p "$log_dir"

set +e
timeout --signal=INT --kill-after=30s "$SOAK_SECONDS" node "$SOAK_DIST_FILE" 2>&1 | tee "$SOAK_LOG_FILE"
status=${PIPESTATUS[0]}
set -e

printf '\nRequested runtime health output:\n'
grep -E 'MICRO_BURST_SHADOW_HEALTH|micro_burst_runtime_(started|stopped|startup_failed)|MICRO_BURST_PROSPECTIVE_COHORT_' "$SOAK_LOG_FILE" || true
[[ "$status" -eq 0 || "$status" -eq 124 ]] || { printf 'Main-path soak failed with status %s. Inspect %s.\n' "$status" "$SOAK_LOG_FILE" >&2; exit "$status"; }
soak_verify_final_health
printf 'M3.2.2 soak finished; retain the preflight and final health evidence with %s.\n' "$SOAK_LOG_FILE"
