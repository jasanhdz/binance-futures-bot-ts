import { MicroBurstExitEngine } from './MicroBurstExitPolicy';
import { MicroBurstConfig, MicroBurstExitContext } from './MicroBurstTypes';
import {
  ShadowManagementObservation,
  ShadowPolicyDecision,
  ShadowPosition,
  ShadowStrategyPolicy,
} from '../../../core/shadow/ShadowTradingTypes';

/** Adapts the shared Micro Burst exit engine to the generic SHADOW lifecycle. */
export class MicroBurstShadowPolicyAdapter implements ShadowStrategyPolicy {
  readonly strategyId = 'MICRO_BURST_V1' as const;
  private readonly exitEngine = new MicroBurstExitEngine();
  private readonly activeTradeBySymbol = new Map<string, string>();

  constructor(private readonly config: MicroBurstConfig) {}

  evaluateLifecycle(
    position: ShadowPosition,
    observation: ShadowManagementObservation,
  ): ShadowPolicyDecision {
    const previousTradeId = this.activeTradeBySymbol.get(position.symbol);
    if (previousTradeId && previousTradeId !== position.tradeId) {
      this.exitEngine.forget(previousTradeId);
    }
    this.activeTradeBySymbol.set(position.symbol, position.tradeId);
    const context = observation.strategyContext as
      | {
          currentBookPressure?: MicroBurstExitContext['currentBookPressure'];
          currentBtcContext?: MicroBurstExitContext['currentBtcContext'];
          anomalyExitFlag?: boolean;
          marketEvidence?: MicroBurstExitContext['marketEvidence'];
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
    const decision = this.exitEngine.evaluate(
      position.tradeId,
      {
        unrealizedRoe: 0,
        priceReturn:
          position.side === 'LONG'
            ? (observation.currentPrice - position.entryPrice) / position.entryPrice
            : (position.entryPrice - observation.currentPrice) / position.entryPrice,
        currentPrice: observation.currentPrice,
        entryPrice: position.entryPrice,
        peakPrice: position.peakPrice,
        troughPrice: position.troughPrice,
        structuralInvalidationPrice: position.stop ?? 0,
        destinationPrice: position.destination ?? 0,
        currentStopPrice: position.stop ?? null,
        timeInTradeMs: Math.max(0, observation.receivedAtMs - position.openedReceivedAtMs),
        observedAtMs: observation.receivedAtMs,
        momentumDecayFlag: false,
        anomalyExitFlag: context?.anomalyExitFlag ?? false,
        currentBookPressure: context?.currentBookPressure ?? null,
        currentBtcContext: context?.currentBtcContext ?? null,
        marketEvidence: context?.marketEvidence ?? null,
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
