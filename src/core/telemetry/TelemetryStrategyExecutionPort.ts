import type {
  StrategyExecutionIntent,
  StrategyExecutionPort,
  StrategyExecutionResult,
} from '../strategy/StrategyExecution';
import type { StrategyTelemetryBus } from './StrategyTelemetryBus';

export class TelemetryStrategyExecutionPort implements StrategyExecutionPort {
  constructor(
    private readonly inner: StrategyExecutionPort,
    private readonly telemetry: StrategyTelemetryBus,
    private readonly now: () => number = Date.now,
  ) {}

  async execute(intent: StrategyExecutionIntent): Promise<StrategyExecutionResult> {
    await this.telemetry.publish({
      eventType: 'EXECUTION_INTENT',
      strategyId: intent.identity.strategyId,
      identity: intent.identity,
      symbol: intent.symbol,
      occurredAtMs: intent.requestedAt,
      signalId: intent.signalId,
      tradeId: intent.tradeId,
      side: intent.side,
      status: 'REQUESTED',
      details: {
        leverage: intent.leverage,
        positionFraction: intent.positionFraction,
        stopRoe: intent.stopRoe,
        takeProfitRoe: intent.takeProfitRoe,
        structuralStopPrice: intent.structuralStopPrice,
        destinationPrice: intent.destinationPrice,
        protection: intent.protection,
        metadata: intent.metadata,
      },
    });

    const result = await this.inner.execute(intent);
    await this.telemetry.publish({
      eventType: 'EXECUTION_RESULT',
      strategyId: result.identity.strategyId,
      identity: result.identity,
      symbol: result.symbol,
      occurredAtMs: result.status === 'OPENED' ? result.openedAt : this.now(),
      signalId: intent.signalId,
      tradeId: result.tradeId,
      side: intent.side,
      status: result.status,
      reason: result.status === 'OPENED' ? 'POSITION_OPENED' : result.reason,
      details:
        result.status === 'OPENED'
          ? {
              orderId: result.orderId,
              entryPrice: result.entryPrice,
              quantity: result.quantity,
              leverage: result.leverage,
              positionFraction: result.positionFraction,
              metadata: result.metadata,
            }
          : { metadata: result.metadata },
    });
    return result;
  }
}
