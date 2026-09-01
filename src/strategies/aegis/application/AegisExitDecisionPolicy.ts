import type { AegisExitEyeDecision } from '../domain/services/AegisExitEye';

export type AegisExitDecisionEffect = 'PROTECT_PROFIT' | 'CLOSE_POSITION' | 'NOTIFY_ONLY';

/**
 * Classifies the operational effect of an ExitEye decision without performing
 * any exchange, state, telemetry, or notification side effects.
 *
 * The ordering intentionally mirrors TradingService's historical behavior:
 * protection is considered first, a close is executable only for profitable
 * positions, and every other decision remains notification-only.
 */
export function classifyAegisExitDecision(
  decision: AegisExitEyeDecision,
  currentRoe: number,
): AegisExitDecisionEffect {
  if (decision.action === 'PROTECT_PROFIT' && decision.shouldProtect) {
    return 'PROTECT_PROFIT';
  }
  if (decision.action === 'CLOSE_POSITION' && decision.shouldClose && currentRoe > 0) {
    return 'CLOSE_POSITION';
  }
  return 'NOTIFY_ONLY';
}
