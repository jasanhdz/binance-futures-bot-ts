#!/usr/bin/env bash

soak_die() {
  printf 'M3.2.2 preflight failed: %s\n' "$1" >&2
  return 2
}

soak_validate_seconds() {
  [[ "$1" =~ ^[0-9]+$ ]] && (( "$1" >= 180 )) || soak_die 'SOAK_SECONDS must be an integer of at least 180 seconds.'
}

soak_resolve_sha() {
  if [[ -n "${GIT_COMMIT_SHA:-}" ]]; then
    [[ "$GIT_COMMIT_SHA" =~ ^[0-9a-fA-F]{40}$ ]] || soak_die 'GIT_COMMIT_SHA must be an explicit 40-character hexadecimal SHA.' || return
    SOAK_CODE_SHA="${GIT_COMMIT_SHA,,}"
    SOAK_SHA_SOURCE='explicit'
    return
  fi

  [[ -z "$(git -C "$SOAK_ROOT_DIR" status --porcelain)" ]] || soak_die 'git worktree must be clean when GIT_COMMIT_SHA is not supplied.' || return
  SOAK_CODE_SHA="$(git -C "$SOAK_ROOT_DIR" rev-parse HEAD)" || soak_die 'cannot resolve HEAD SHA.' || return
  [[ "$SOAK_CODE_SHA" =~ ^[0-9a-f]{40}$ ]] || soak_die 'HEAD is not a 40-character hexadecimal SHA.' || return
  SOAK_SHA_SOURCE='clean_git'
}

soak_validate_config() {
  [[ -f "$SOAK_CONFIG_FILE" ]] || soak_die "config does not exist: $SOAK_CONFIG_FILE" || return
  grep -qE '^  mode: SHADOW$' "$SOAK_CONFIG_FILE" || soak_die 'config must set micro_burst.mode: SHADOW.' || return
  grep -qE '^  enabled: true$' "$SOAK_CONFIG_FILE" || soak_die 'config must enable micro_burst.' || return
  grep -qE '^    root_dir: data/micro-burst/m3_2_2-soak/' "$SOAK_CONFIG_FILE" || soak_die 'config archive root must be isolated under data/micro-burst/m3_2_2-soak/.' || return
  grep -qE '^    sqlite_path: data/micro-burst/m3_2_2-soak/' "$SOAK_CONFIG_FILE" || soak_die 'config SQLite path must be isolated under data/micro-burst/m3_2_2-soak/.' || return
  ! grep -qE 'regime_config\.live\.yaml|data/micro-burst/live|mode: LIVE' "$SOAK_CONFIG_FILE" || soak_die 'config references a live strategy or archive path.' || return
}

soak_preflight() {
  soak_validate_seconds "$SOAK_SECONDS" || return
  command -v node >/dev/null || soak_die 'node is required.' || return
  node -e "require('ws')" >/dev/null 2>&1 || soak_die 'the ws module is required for WebSocket capability.' || return
  [[ -f "$SOAK_DIST_FILE" ]] || soak_die "compiled runtime does not exist: $SOAK_DIST_FILE" || return
  soak_validate_config || return
  [[ "${REGIME_CONFIG:-}" != *'regime_config.live.yaml'* ]] || soak_die 'environment must not reference regime_config.live.yaml.' || return
  [[ "${TRADING_MODE:-}" == 'AEGIS_SHADOW' && "${AEGIS_LIVE_ENABLED:-}" == '0' ]] || soak_die 'environment must set TRADING_MODE=AEGIS_SHADOW and AEGIS_LIVE_ENABLED=0.' || return
  soak_resolve_sha || return

  printf 'M3.2.2 preflight evidence:\n'
  printf '  node_version=%s\n' "$(node --version)"
  printf '  websocket_capability=ws_module_available\n'
  printf '  seconds=%s\n' "$SOAK_SECONDS"
  printf '  code_sha=%s\n' "$SOAK_CODE_SHA"
  printf '  sha_source=%s\n' "$SOAK_SHA_SOURCE"
  printf '  config=%s\n' "$SOAK_CONFIG_FILE"
  printf '  dist=%s\n' "$SOAK_DIST_FILE"
  printf '  archive_root=data/micro-burst/m3_2_2-soak/market-data\n'
  printf '  archive_sqlite=data/micro-burst/m3_2_2-soak/micro_burst_research.sqlite\n'
  printf '  trading_mode=%s\n  aegis_live_enabled=%s\n' "$TRADING_MODE" "$AEGIS_LIVE_ENABLED"
}

soak_verify_final_health() {
  local final_health
  final_health="$(grep -E 'MICRO_BURST_SHADOW_HEALTH.*"phase":"graceful_shutdown"' "$SOAK_LOG_FILE" | tail -n 1 || true)"
  [[ -n "$final_health" ]] || soak_die 'no graceful_shutdown MICRO_BURST_SHADOW_HEALTH record was emitted.' || return
  [[ "$final_health" == *'"archiveQueueDepth":0'* ]] || soak_die 'graceful shutdown archive queue did not drain to zero.' || return
  [[ "$final_health" == *'"archiveOverflowRecords":0'* ]] || soak_die 'graceful shutdown reports archive queue overflow.' || return
  local queued_pattern='"archiveQueuedRecords":([0-9]+)'
  local written_pattern='"archiveWrittenRecords":([0-9]+)'
  [[ "$final_health" =~ $queued_pattern ]] || soak_die 'graceful shutdown health omitted archiveQueuedRecords.' || return
  local queued="${BASH_REMATCH[1]}"
  [[ "$final_health" =~ $written_pattern ]] || soak_die 'graceful shutdown health omitted archiveWrittenRecords.' || return
  local written="${BASH_REMATCH[1]}"
  [[ "$queued" == "$written" ]] || soak_die "archive queue discrepancy: queuedRecords=$queued writtenRecords=$written." || return
  printf 'Final health evidence: graceful_shutdown queueDepth=0 queuedRecords=%s writtenRecords=%s\n' "$queued" "$written"
}
