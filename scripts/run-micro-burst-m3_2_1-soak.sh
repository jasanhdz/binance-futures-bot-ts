#!/usr/bin/env bash
set -euo pipefail

seconds="${SOAK_SECONDS:-300}"
env_file="${SOAK_ENV_FILE:-}"
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
config_file="${root_dir}/config/micro-burst-m3_2_1-soak.yaml"
log_dir="${root_dir}/logs/micro-burst/m3_2_1-soak"
log_file="${log_dir}/soak-$(date -u +%Y%m%dT%H%M%SZ).log"

if [[ ! "${seconds}" =~ ^[0-9]+$ ]] || (( seconds < 180 )); then
  printf 'SOAK_SECONDS must be an integer of at least 180 seconds.\n' >&2
  exit 2
fi

if [[ -z "${env_file}" ]]; then
  printf 'Set SOAK_ENV_FILE to a local env file based on config/m3_2_1_soak.env.example.\n' >&2
  exit 2
fi

if [[ ! -f "${env_file}" ]]; then
  printf 'SOAK_ENV_FILE does not exist: %s\n' "${env_file}" >&2
  exit 2
fi

# The checked-in config has isolated archive paths. Refuse caller overrides.
if [[ "${REGIME_CONFIG:-}" == *"regime_config.live.yaml"* ]]; then
  printf 'Refusing a tracked live archive configuration.\n' >&2
  exit 2
fi

set -a
source "${env_file}"
set +a

if [[ "${TRADING_MODE:-}" != "AEGIS_SHADOW" ]] || [[ "${AEGIS_LIVE_ENABLED:-}" == "1" ]]; then
  printf 'Soak environment must set TRADING_MODE=AEGIS_SHADOW and AEGIS_LIVE_ENABLED=0.\n' >&2
  exit 2
fi

export REGIME_CONFIG="${config_file}"
export TRADING_MODE="AEGIS_SHADOW"
export AEGIS_LIVE_ENABLED="0"
export TELEGRAM_COMMANDS_ENABLED="0"

mkdir -p "${log_dir}"
printf 'M3.2.1 main-path soak: duration=%ss config=%s log=%s\n' "${seconds}" "${REGIME_CONFIG}" "${log_file}"
printf 'Safety: SHADOW only; Micro Burst archives are isolated under data/micro-burst/m3_2_1-soak.\n'

set +e
timeout --signal=INT --kill-after=30s "${seconds}" node "${root_dir}/dist/main.js" 2>&1 | tee "${log_file}"
status=${PIPESTATUS[0]}
set -e

printf '\nRequested runtime health output:\n'
rg 'MICRO_BURST_SHADOW_HEALTH|micro_burst_runtime_(started|stopped|startup_failed)|MICRO_BURST_PROSPECTIVE_COHORT_' "${log_file}" || true

# timeout returns 124 after delivering the planned SIGINT. The main process
# handles SIGINT by stopping the runtime, which invokes the archive flush path.
if [[ "${status}" -ne 0 && "${status}" -ne 124 ]]; then
  printf 'Main-path soak failed with status %s. Inspect %s.\n' "${status}" "${log_file}" >&2
  exit "${status}"
fi

printf 'M3.2.1 soak finished; retain the health output and log as operational evidence.\n'
