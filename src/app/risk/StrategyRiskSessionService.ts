import { StrategyRiskLedger, StrategyRiskSnapshot } from '../../core/risk/StrategyRiskLedger';
import { StrategyId } from '../../core/strategy/StrategyIdentity';
import {
  ClosedTradeOutcome,
  ConsecutiveLossTracker,
} from '../../domain/services/ConsecutiveLossTracker';
import type {
  StrategyLossStateStorePort,
  StrategyLossStateWrite,
} from '../../infra/state/StrategyLossStateStore';
import { Logger } from '../ports/Logger';
import { StateStore } from '../ports/StateStore';

export interface StrategyRiskSessionServiceDeps {
  state: StateStore;
  logger: Logger;
  getTradingMode(): string;
  readClosedOutcomes(): Promise<{
    aegisOutcomes: ClosedTradeOutcome[];
    strategyOutcomes: ClosedTradeOutcome[];
  }>;
  consecutiveLossStateStore?: StrategyLossStateStorePort;
  now?: () => number;
}

export interface StrategyRiskSessionSnapshot {
  tradesToday: number;
  phaseOShortTradesToday: number;
  consecutiveLosses: number;
  dailyStartBalance: number | null;
  dailyPnlPct?: number;
  lastTradeDayReset: number;
}

export interface ConfirmedStrategyOpen {
  strategyId: StrategyId;
  openedAt: number;
  phaseOShortLive?: boolean;
}

export interface StrategyCloseOutcome {
  strategyId: StrategyId;
  symbol: string;
  tradeId: string;
  pnlUsdt: number;
  closedAt: number;
  reason: string;
}

/** Owns process-session risk state and its durable daily/legacy recovery. */
export class StrategyRiskSessionService {
  private tradesToday = 0;
  private phaseOShortTradesToday = 0;
  private lastTradeDayReset = 0;
  private dailyStartBalance: number | null = null;
  private dailyPnlPct: number | undefined;
  private readonly consecutiveLossTracker = new ConsecutiveLossTracker();
  private readonly strategyRiskLedger = new StrategyRiskLedger();
  private readonly now: () => number;

  constructor(private readonly deps: StrategyRiskSessionServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  snapshot(): StrategyRiskSessionSnapshot {
    return {
      tradesToday: this.tradesToday,
      phaseOShortTradesToday: this.phaseOShortTradesToday,
      consecutiveLosses: this.consecutiveLossTracker.value,
      dailyStartBalance: this.dailyStartBalance,
      dailyPnlPct: this.dailyPnlPct,
      lastTradeDayReset: this.lastTradeDayReset,
    };
  }

  strategySnapshot(strategyId: StrategyId, now = this.now()): StrategyRiskSnapshot {
    return this.strategyRiskLedger.snapshot(strategyId, now);
  }

  timeSinceLastExitMs(strategyId: StrategyId, now = this.now()): number {
    return this.strategyRiskLedger.timeSinceLastExitMs(strategyId, now);
  }

  timeSinceLastLossMs(strategyId: StrategyId, now = this.now()): number {
    return this.strategyRiskLedger.timeSinceLastLossMs(strategyId, now);
  }

  initializeDailyStartBalance(balance: number, now = this.now()): void {
    if (this.dailyStartBalance !== null && this.dailyStartBalance > 0) return;
    this.dailyStartBalance = balance;
    this.persistDailyRiskState(now);
  }

  setDailyPnlPct(value: number | undefined): void {
    this.dailyPnlPct = value;
  }

  setPhaseOShortTradesToday(value: number): void {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error('PHASE_O_SHORT_TRADES_TODAY_INVALID');
    }
    this.phaseOShortTradesToday = value;
  }

  recordConfirmedOpen(input: ConfirmedStrategyOpen): StrategyRiskSnapshot {
    this.tradesToday += 1;
    const snapshot = this.strategyRiskLedger.recordOpen(input.strategyId, input.openedAt);
    this.persistDailyRiskState(input.openedAt);
    if (input.phaseOShortLive) this.phaseOShortTradesToday += 1;
    return snapshot;
  }

  recordStrategyClose(input: StrategyCloseOutcome): StrategyRiskSnapshot {
    return this.strategyRiskLedger.recordClose(
      input.strategyId,
      input.tradeId,
      input.pnlUsdt,
      input.closedAt,
    );
  }

  async recordAegisLossOutcome(input: StrategyCloseOutcome): Promise<void> {
    if (input.strategyId !== 'AEGIS_TURBO') return;
    const streakUpdate = this.consecutiveLossTracker.record(input.tradeId, input.pnlUsdt);
    if (streakUpdate.applied) {
      await this.persistConsecutiveLossState(input.tradeId);
      this.deps.logger.info('aegis_consecutive_loss_streak_updated', {
        symbol: input.symbol,
        tradeId: input.tradeId,
        reason: input.reason,
        outcome: input.pnlUsdt < 0 ? 'LOSS' : 'NON_LOSS',
        previous: streakUpdate.previous,
        current: streakUpdate.current,
      });
    }
  }

  checkDailyReset(now = this.now()): void {
    const today = Math.floor(now / 86_400_000);
    if (today > this.lastTradeDayReset) {
      this.tradesToday = 0;
      this.phaseOShortTradesToday = 0;
      this.dailyStartBalance = null;
      this.dailyPnlPct = undefined;
      this.lastTradeDayReset = today;
      this.strategyRiskLedger.resetDaily(now);
      this.persistDailyRiskState(now);
    }
  }

  async restore(): Promise<void> {
    try {
      const { aegisOutcomes, strategyOutcomes } = await this.deps.readClosedOutcomes();
      this.consecutiveLossTracker.restore(
        aegisOutcomes.filter((outcome) => !outcome.tradeId.startsWith('MOMENTUM-RIDE-')),
      );
      this.strategyRiskLedger.restoreClosedOutcomes(strategyOutcomes);
      const now = this.now();
      const dailyRisk = this.deps.state.get().dailyRisk;
      this.lastTradeDayReset = Math.floor(now / 86_400_000);
      if (dailyRisk?.dayKey === this.lastTradeDayReset) {
        this.tradesToday = dailyRisk.tradesToday;
        this.dailyStartBalance = dailyRisk.dailyStartBalance ?? null;
        this.strategyRiskLedger.restoreDailyState(dailyRisk, now);
      }
      this.deps.logger.info('aegis_consecutive_loss_streak_restored', {
        consecutiveLosses: this.consecutiveLossTracker.value,
        processedClosedTrades: this.consecutiveLossTracker.processedCount,
        source: 'CLOSED_TRADE_HISTORY',
      });
    } catch (error) {
      this.deps.logger.error('aegis_consecutive_loss_streak_recovery_failed', {
        error: String(error),
      });
      throw new Error('AEGIS_CONSECUTIVE_LOSS_RECOVERY_FAILED');
    }
  }

  private persistDailyRiskState(now = this.now()): void {
    this.deps.state.set({
      dailyRisk: {
        ...this.strategyRiskLedger.dailyState(now),
        tradesToday: this.tradesToday,
        dailyStartBalance: this.dailyStartBalance,
      },
    });
  }

  private async persistConsecutiveLossState(lastTradeId: string): Promise<void> {
    const store = this.deps.consecutiveLossStateStore;
    if (!store) return;
    const previous = await store.read(this.deps.getTradingMode());
    const now = new Date(this.now()).toISOString();
    const state: StrategyLossStateWrite = {
      schema_id: 'strategy-loss-state-v2',
      mode: this.deps.getTradingMode(),
      consecutive_losses: this.consecutiveLossTracker.value,
      updated_at: now,
      last_trade_id: lastTradeId,
      reset_authority: previous?.reset_authority ?? 'SYSTEM_INITIALIZED_FROM_CLOSED_TRADE_HISTORY',
      reset_at: previous?.reset_at ?? now,
    };
    await store.write(state);
  }
}
