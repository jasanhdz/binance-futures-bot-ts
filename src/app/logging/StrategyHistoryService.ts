import { Side } from '../../core/types';
import { StrategyIdentity } from '../../core/strategy/StrategyIdentity';
import { Logger } from '../ports/Logger';
import { AegisTradingSignal } from '../../strategies/aegis/domain/AegisStrategy';
import { AegisMicroLiveGateDecision } from '../../strategies/aegis/domain/services/AegisMicroLiveGate';
import {
  AegisResearchStrategy,
  AegisTurboHistoryLogger,
  generateSignalId,
  getPortfolioSessionId,
} from '../../infra/logging/AegisTurboHistoryLogger';

export interface StrategyHistoryServiceDeps {
  logger: Logger;
  historyLogger: AegisTurboHistoryLogger;
  tradingMode(): string;
  strategyIdentity(strategy: AegisResearchStrategy): StrategyIdentity;
  strategyForSymbol(symbol: string, tradeId?: string): AegisResearchStrategy;
  tradesToday(): number;
  consecutiveLosses(): number;
}

export interface HistoryTradeEventInput {
  tradeId?: string;
  price?: number;
  roe?: number;
  oldStop?: number;
  newStop?: number;
  oldTp?: number;
  newTp?: number;
  reason?: string;
  strategy?: AegisResearchStrategy;
  identity?: StrategyIdentity;
  metadata?: Record<string, unknown>;
}

export interface HistoryAccountSnapshotInput {
  symbol?: string;
  walletBalance?: number;
  availableBalance?: number;
  unrealizedPnl?: number;
  dailyPnlPct?: number;
  positionOpen?: boolean;
  side?: Side;
  entryPrice?: number;
  markPrice?: number;
  roe?: number;
  marginUsed?: number;
  quantity?: number;
  leverage?: number;
  metadata?: Record<string, unknown>;
}

export class StrategyHistoryService {
  constructor(private readonly deps: StrategyHistoryServiceDeps) {}

  logScan(symbol: string, signal: AegisTradingSignal): void {
    const aegis = signal.metadata?.aegis ?? signal.aegis;
    this.deps.logger.info('aegis_scan', {
      symbol,
      mode: this.deps.tradingMode(),
      safeAction: aegis?.shadow?.action,
      safeReason: aegis?.shadow?.reason,
      turboRawAction: aegis?.turbo?.raw?.action,
      turboRawScore: aegis?.turbo?.raw?.turbo_score,
      turboRawWouldExecute: aegis?.turbo?.raw?.would_execute,
      turboGatedAction: aegis?.turbo?.gated?.action,
      turboGatedReason: aegis?.turbo?.gated?.reason,
      turboBlockedBy: aegis?.turbo?.gated?.blocked_by,
      execute: aegis?.turbo?.execute,
      smartLeverage: signal.smart_leverage ?? 0,
      prodExecute: aegis?.prod?.execute,
    });
  }

  async logTurboSignal(
    symbol: string,
    signal: AegisTradingSignal,
    extras: {
      signalId?: string;
      tradeId?: string;
      price?: number;
      gate?: AegisMicroLiveGateDecision;
      executed?: boolean;
      strategy?: AegisResearchStrategy;
      identity?: StrategyIdentity;
      metadata?: Record<string, unknown>;
    } = {},
  ): Promise<void> {
    const aegis = signal.metadata?.aegis ?? signal.aegis;
    const turbo = aegis?.turbo as any;
    const raw = turbo?.raw;
    const gated = turbo?.gated;
    const inferredMomentum = signal.metadata?.momentum_stacking_replica === true;
    const strategy = extras.strategy ?? (inferredMomentum ? 'MOMENTUM_RIDE' : 'AEGIS_TURBO');
    const identity = extras.identity ?? this.deps.strategyIdentity(strategy);
    await this.deps.historyLogger.logSignal({
      signal_id: extras.signalId ?? generateSignalId(symbol),
      portfolio_session_id: getPortfolioSessionId(),
      symbol,
      strategy,
      strategy_version: identity.strategyVersion,
      strategy_hash: identity.strategyHash,
      config_hash: identity.configHash,
      code_commit_sha: identity.codeCommitSha,
      mode: this.deps.tradingMode(),
      price: extras.price,
      raw_action: raw?.action,
      gated_action: gated?.action,
      final_action: turbo?.action ?? gated?.action ?? raw?.action,
      reason: turbo?.reason ?? gated?.reason ?? raw?.reason,
      turbo_score: raw?.turbo_score ?? turbo?.turbo_score ?? extras.gate?.turboScore,
      confidence: typeof signal.confidence === 'number' ? `${signal.confidence}` : undefined,
      votes: raw?.votes ?? extras.gate?.votes,
      recent_scores: raw?.recent_scores ?? turbo?.recent_scores,
      freshness: raw?.freshness ?? turbo?.freshness,
      gate_allowed: extras.gate?.allowed,
      gate_reason: extras.gate?.reason,
      gated_blocked_by: extras.gate?.gatedBlockedBy,
      executed: extras.executed ?? false,
      trade_id: extras.tradeId,
      leverage: extras.gate?.leverage,
      position_fraction: extras.gate?.positionFraction,
      stop_roe: extras.gate?.stopRoe,
      take_profit_roe: extras.gate?.takeProfitRoe,
      trailing_activation_roe: extras.gate?.trailingActivationRoe,
      trailing_callback_roe: extras.gate?.trailingCallbackRoe,
      metadata: {
        source: signal.source,
        safe_action: aegis?.shadow?.action,
        safe_reason: aegis?.shadow?.reason,
        prod_execute: aegis?.prod?.execute,
        ...extras.metadata,
      },
    });
  }

  async logTradeEvent(symbol: string, event: string, input: HistoryTradeEventInput = {}): Promise<void> {
    const strategy = input.strategy ?? this.deps.strategyForSymbol(symbol, input.tradeId);
    const identity = input.identity ?? this.deps.strategyIdentity(strategy);
    await this.deps.historyLogger.logTradeEvent({
      trade_id: input.tradeId,
      portfolio_session_id: getPortfolioSessionId(),
      symbol,
      strategy,
      strategy_version: identity.strategyVersion,
      strategy_hash: identity.strategyHash,
      config_hash: identity.configHash,
      code_commit_sha: identity.codeCommitSha,
      mode: this.deps.tradingMode(),
      event,
      price: input.price,
      roe: input.roe,
      old_stop: input.oldStop,
      new_stop: input.newStop,
      old_tp: input.oldTp,
      new_tp: input.newTp,
      reason: input.reason,
      metadata: input.metadata,
    });
  }

  async logAccountSnapshot(input: HistoryAccountSnapshotInput = {}): Promise<void> {
    const notional = input.entryPrice && input.quantity ? input.entryPrice * input.quantity : undefined;
    await this.deps.historyLogger.logAccountSnapshot({
      portfolio_session_id: getPortfolioSessionId(),
      mode: this.deps.tradingMode(),
      wallet_balance: input.walletBalance,
      available_balance: input.availableBalance ?? input.walletBalance,
      unrealized_pnl: input.unrealizedPnl,
      daily_pnl_pct: input.dailyPnlPct,
      trades_today: this.deps.tradesToday(),
      consecutive_losses: this.deps.consecutiveLosses(),
      open_positions_count: input.positionOpen ? 1 : 0,
      total_margin_used: input.marginUsed,
      total_notional: notional,
      symbols: input.symbol
        ? [{
            symbol: input.symbol,
            position_open: input.positionOpen,
            side: input.side,
            entry_price: input.entryPrice,
            mark_price: input.markPrice,
            roe: input.roe,
            unrealized_pnl: input.unrealizedPnl,
            margin_used: input.marginUsed,
            notional,
          }]
        : undefined,
      portfolio_exposure: {
        long_symbols: input.positionOpen && input.side === 'LONG' ? 1 : 0,
        short_symbols: input.positionOpen && input.side === 'SHORT' ? 1 : 0,
        total_symbols: input.positionOpen ? 1 : 0,
        total_margin_used: input.marginUsed,
        total_notional: notional,
      },
      metadata: input.metadata,
    });
  }
}
