import { evaluateMicroBurstExit } from './MicroBurstExitPolicy';
import { MicroBurstConfig, MicroBurstExitContext } from './MicroBurstTypes';
import {
  ShadowManagementObservation,
  ShadowPolicyDecision,
  ShadowPosition,
  ShadowStrategyPolicy,
} from '../../../core/shadow/ShadowTradingTypes';

/** Adapts the existing Micro Burst exit policy without moving its thresholds into the engine. */
export class MicroBurstShadowPolicyAdapter implements ShadowStrategyPolicy {
  readonly strategyId = 'MICRO_BURST_V1' as const;

  constructor(private readonly config: MicroBurstConfig) {}

  evaluateLifecycle(
    position: ShadowPosition,
    observation: ShadowManagementObservation,
  ): ShadowPolicyDecision {
    const context = observation.strategyContext as
      | {
          currentBookPressure?: MicroBurstExitContext['currentBookPressure'];
          currentBtcContext?: MicroBurstExitContext['currentBtcContext'];
          anomalyExitFlag?: boolean;
        }
      | undefined;
    const stopTouched =
      position.stop !== undefined &&
      (position.side === 'LONG'
        ? observation.currentPrice <= position.stop
        : observation.currentPrice >= position.stop);
    if (stopTouched)
      return {
        action: 'CLOSE',
        reason: position.stop === position.entryPrice ? 'BREAK_EVEN' : 'HARD_INVALIDATION',
      };
    const decision = evaluateMicroBurstExit(
      {
        unrealizedRoe: 0,
        priceReturn: (observation.currentPrice - position.entryPrice) / position.entryPrice,
        currentPrice: observation.currentPrice,
        entryPrice: position.entryPrice,
        peakPrice: position.peakPrice,
        troughPrice: position.troughPrice,
        structuralInvalidationPrice: position.stop ?? 0,
        destinationPrice: position.destination ?? 0,
        currentStopPrice: position.stop ?? null,
        timeInTradeMs: Math.max(0, observation.exchangeTimeMs - position.openedAtMs),
        momentumDecayFlag: false,
        anomalyExitFlag: context?.anomalyExitFlag ?? false,
        currentBookPressure: context?.currentBookPressure ?? null,
        currentBtcContext: context?.currentBtcContext ?? null,
        leverage: position.leverage ?? 0,
      },
      this.config,
      position.side,
    );
    if (decision.action === 'MOVE_STOP' && decision.requestedStopPrice !== undefined)
      return {
        action: 'MOVE_STOP',
        stop: decision.requestedStopPrice,
        reason: decision.reason,
        diagnostics: decision.diagnostics,
      };
    if (decision.action === 'CLOSE_MARKET')
      return { action: 'CLOSE', reason: decision.reason, diagnostics: decision.diagnostics };
    return { action: 'HOLD', reason: decision.reason, diagnostics: decision.diagnostics };
  }
}
