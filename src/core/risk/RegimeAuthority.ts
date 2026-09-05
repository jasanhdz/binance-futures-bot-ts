/**
 * Regime Authority Contract
 *
 * Explicit authority mapping for regime classification:
 * - Legacy (AegisRegimeGuard): Runtime authority for Aegis entry decisions.
 *   Uses hybrid heuristic with BTC/ETH alignment, tail risk, event risk.
 *   Supports OFF/SHADOW/ENFORCE modes with root reason tracking.
 * - RegimeEngineV2: Isolated OHLCV-first momentum environment detector.
 *   Offline/analysis only. Should be used for future Momentum Ride regime
 *   validation before any live migration.
 *
 * INVARIANTS:
 * 1. Heuristic confidence is NOT a calibrated probability. It reflects
 *    heuristic agreement strength, not statistical certainty.
 * 2. OFF mode disables regime entry blocking but does NOT disable
 *    position protection. Existing positions remain supervised.
 * 3. SHADOW mode evaluates but does not block; decisions are logged.
 * 4. ENFORCE mode blocks entries when regime conditions are not met.
 * 5. A stale snapshot (exceeding maxSnapshotAgeSeconds) is treated as
 *    UNKNOWN and blocked in ENFORCE mode.
 * 6. regime_context metadata is informational; it does not by itself
 *    authorize or deny entries. Authority comes from regime guard mode.
 * 7. BTC/ETH alignment is required for alt symbols unless explicitly
 *    overridden via allowAltLongWhenBtcShort/allowAltShortWhenBtcLong.
 */

/** Authority source for regime classification. */
export type RegimeAuthoritySource = 'LEGACY' | 'ENGINE_V2';

/** Whether regime data is authoritative or informational only. */
export type RegimeAuthorityRole = 'AUTHORITATIVE' | 'INFORMATIONAL';

export interface RegimeAuthorityMapping {
  source: RegimeAuthoritySource;
  role: RegimeAuthorityRole;
  description: string;
}

/** Static authority mapping. */
export const REGIME_AUTHORITY: Record<RegimeAuthoritySource, RegimeAuthorityMapping> = {
  LEGACY: {
    source: 'LEGACY',
    role: 'AUTHORITATIVE',
    description: 'AegisRegimeGuard: hybrid heuristic runtime authority for entry decisions.',
  },
  ENGINE_V2: {
    source: 'ENGINE_V2',
    role: 'INFORMATIONAL',
    description: 'RegimeEngineV2: OHLCV-first momentum environment detector. Offline/analysis only.',
  },
};

/** Map mode to authority role. */
export function modeAuthorityRole(mode: 'OFF' | 'SHADOW' | 'ENFORCE'): RegimeAuthorityRole {
  if (mode === 'OFF') return 'INFORMATIONAL';
  if (mode === 'SHADOW') return 'INFORMATIONAL'; // Observes, does not block.
  return 'AUTHORITATIVE'; // ENFORCE blocks entries.
}

/**
 * Assert that a confidence value is heuristic, not probability.
 * This is a documentation guard; the value is always clamped to [0, 1].
 */
export function isHeuristicConfidence(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Validate that regime context metadata is present but does not
 * independently authorize entries. Context is informational; authority
 * comes from the regime guard decision.
 */
export function regimeContextIsInformational(
  decision: { allowed: boolean; metadata: { mode?: string } },
): boolean {
  // In OFF/SHADOW, context is informational.
  return decision.metadata.mode === 'OFF' || decision.metadata.mode === 'SHADOW' || !decision.allowed;
}

/**
 * Determine whether regime data from RegimeEngineV2 should be used
 * for entry decisions (currently never, until live migration).
 */
export function engineV2HasAuthority(): boolean {
  // V2 is always informational until live migration is approved.
  return false;
}
