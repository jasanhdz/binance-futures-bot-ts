import type { PositionInfo, SymbolFilters } from '../../../app/ports/Exchange';
import type { Logger } from '../../../app/ports/Logger';
import type { Notifier } from '../../../app/ports/Notifier';
import type { StateStore } from '../../../app/ports/StateStore';
import type {
  SafeStopMoveInput,
  SafeStopMoveResult,
} from '../../../app/position/StrategyPositionLifecycleCore';
import type { BotState, Side } from '../../../core/types';
import type { AegisProfitProtectionRuntimeConfig } from '../../../infra/config/ConfigLoader';
import type { AegisExitEyeDecision } from '../domain/services/AegisExitEye';

export interface AegisProfitProtectionInput {
  symbol: string;
  side: Side;
  botState: BotState;
  symbolState: StateStore;
  position: PositionInfo;
  markPrice: number;
  currentRoe: number;
  peakRoe: number;
  decision: AegisExitEyeDecision;
}

export interface AegisProfitProtectionDeps {
  logger: Logger;
  notifier: Notifier;
  now(): number;
  getConfig(): AegisProfitProtectionRuntimeConfig;
  getFallbackLeverage(symbol: string): number;
  getSymbolFilters(symbol: string, leverage: number): Promise<SymbolFilters>;
  roundPrice(price: number, filters: SymbolFilters): number;
  useClosePosition(state: BotState): boolean;
  moveCloseStop(input: SafeStopMoveInput): Promise<SafeStopMoveResult>;
  logTradeEvent(
    symbol: string,
    event: string,
    payload: Record<string, unknown>,
  ): Promise<void>;
  formatRoe(value: number): string;
}

/** Owns Aegis profit-protection policy while execution stays behind a port. */
export class AegisProfitProtectionService {
  constructor(private readonly deps: AegisProfitProtectionDeps) {}

  async execute(input: AegisProfitProtectionInput): Promise<SafeStopMoveResult> {
    const config = this.deps.getConfig();
    const entryPrice = input.botState.lastEntryPrice || input.position.entryPrice || 0;
    const leverage =
      input.botState.lastLeverage ||
      input.position.leverage ||
      this.deps.getFallbackLeverage(input.symbol);
    const filters = await this.deps.getSymbolFilters(input.symbol, leverage);
    const tradeId = input.botState.lastTradeId;

    if (
      !config.enabled ||
      !config.protect_profit_enabled ||
      input.peakRoe < config.min_peak_roe_to_protect
    ) {
      const result: SafeStopMoveResult = {
        moved: false,
        reason: 'stop_not_improved',
        newStopPrice: input.botState.lastStopPrice || 0,
      };
      await this.deps.logTradeEvent(input.symbol, 'PROTECT_PROFIT_SKIPPED', {
        tradeId,
        price: input.markPrice,
        roe: input.currentRoe,
        reason: 'profit_protection_disabled_or_peak_too_low',
        metadata: {
          symbol: input.symbol,
          side: input.side,
          currentRoe: input.currentRoe,
          peakRoe: input.peakRoe,
          enabled: config.enabled,
          protectProfitEnabled: config.protect_profit_enabled,
          minPeakRoeToProtect: config.min_peak_roe_to_protect,
        },
      });
      return result;
    }

    const protectedStop = this.protectedStopPrice({
      side: input.side,
      entryPrice,
      leverage,
      currentRoe: input.currentRoe,
      peakRoe: input.peakRoe,
      minLockedRoe: config.min_locked_roe,
      protectGivebackRoe: config.protect_giveback_roe,
      immediateTriggerBufferPct: config.immediate_trigger_buffer_pct,
    });
    let newStopPrice = this.deps.roundPrice(protectedStop.stopPrice, filters);
    const buffer = config.immediate_trigger_buffer_pct;
    const tickSize = filters.tickSize > 0 ? filters.tickSize : 10 ** -filters.pricePrecision;
    if (input.side === 'LONG') {
      const maxSafeStop = input.markPrice * (1 - buffer);
      if (newStopPrice >= maxSafeStop) {
        newStopPrice = this.deps.roundPrice(maxSafeStop - tickSize, filters);
      }
    } else {
      const minSafeStop = input.markPrice * (1 + buffer);
      if (newStopPrice <= minSafeStop) {
        newStopPrice = this.deps.roundPrice(minSafeStop + tickSize, filters);
      }
    }
    const actualProtectedRoe =
      input.side === 'LONG'
        ? ((newStopPrice - entryPrice) / entryPrice) * leverage
        : ((entryPrice - newStopPrice) / entryPrice) * leverage;
    const result = await this.deps.moveCloseStop({
      symbol: input.symbol,
      side: input.side,
      tradeId,
      entryPrice,
      markPrice: input.markPrice,
      leverage,
      quantity: input.position.qtyAbs,
      position: input.position,
      newStopPrice,
      currentRoe: input.currentRoe,
      peakRoe: input.peakRoe,
      protectedRoe: actualProtectedRoe,
      reason: 'PROTECT_PROFIT',
      useClosePosition: this.deps.useClosePosition(input.botState),
    });

    if (result.moved) {
      input.symbolState.set({
        lastTrailStop: result.newStopPrice,
        lastStopPrice: result.newStopPrice,
        lastExitEyeAction: input.decision.action,
        lastExitEyeReason: input.decision.reason,
        lastExitEyeAt: this.deps.now(),
      });
      const metadata = {
        protectedRoe: actualProtectedRoe,
        peakRoe: input.peakRoe,
        currentRoe: input.currentRoe,
        oldStopPrice: result.oldStopPrice,
        newStopPrice: result.newStopPrice,
      };
      await this.deps.logTradeEvent(
        input.symbol,
        'AEGIS_EXIT_EYE_PROTECT_PROFIT_EXECUTED',
        {
          tradeId,
          price: input.markPrice,
          roe: input.currentRoe,
          oldStop: result.oldStopPrice,
          newStop: result.newStopPrice,
          reason: input.decision.reason,
          metadata,
        },
      );
      await this.deps.logTradeEvent(input.symbol, 'PROTECT_PROFIT_EXECUTED', {
        tradeId,
        price: input.markPrice,
        roe: input.currentRoe,
        oldStop: result.oldStopPrice,
        newStop: result.newStopPrice,
        reason: input.decision.reason,
        metadata,
      });
      await this.deps.logTradeEvent(input.symbol, 'PROTECT_PROFIT_STOP_MOVED', {
        tradeId,
        price: input.markPrice,
        roe: input.currentRoe,
        oldStop: result.oldStopPrice,
        newStop: result.newStopPrice,
        reason: 'PROTECT_PROFIT',
        metadata: {
          protectedRoe: actualProtectedRoe,
          peakRoe: input.peakRoe,
          currentRoe: input.currentRoe,
        },
      });
      await this.deps.notifier.sendMessage(
        `🛡️ **Ganancia protegida**\n` +
          `${input.symbol} ${input.side}\n` +
          `Peak: ${this.deps.formatRoe(input.peakRoe)}\n` +
          `Actual: ${this.deps.formatRoe(input.currentRoe)}\n` +
          `SL movido a: $${result.newStopPrice}\n` +
          `Ganancia protegida aprox: ${this.deps.formatRoe(actualProtectedRoe)}`,
      );
      return result;
    }

    const metadata = {
      protectedRoe: actualProtectedRoe,
      peakRoe: input.peakRoe,
      currentRoe: input.currentRoe,
      error: result.error,
    };
    await this.deps.logTradeEvent(input.symbol, 'AEGIS_EXIT_EYE_PROTECT_PROFIT_SKIPPED', {
      tradeId,
      price: input.markPrice,
      roe: input.currentRoe,
      oldStop: result.oldStopPrice,
      newStop: result.newStopPrice,
      reason: result.reason,
      metadata,
    });
    await this.deps.logTradeEvent(input.symbol, 'PROTECT_PROFIT_SKIPPED', {
      tradeId,
      price: input.markPrice,
      roe: input.currentRoe,
      oldStop: result.oldStopPrice,
      newStop: result.newStopPrice,
      reason: result.reason,
      metadata,
    });
    if (result.reason === 'exchange_error') {
      await this.deps.notifier.sendAlert(
        'AEGIS PROTECT PROFIT FAILED',
        `${input.symbol} ${input.side}\nSL protegido: ${result.newStopPrice}\n${String(result.error || '').slice(0, 180)}`,
      );
    }
    return result;
  }

  private protectedStopPrice(input: {
    side: Side;
    entryPrice: number;
    leverage: number;
    currentRoe: number;
    peakRoe: number;
    minLockedRoe: number;
    protectGivebackRoe: number;
    immediateTriggerBufferPct: number;
  }): { protectedRoe: number; stopPrice: number } {
    const targetProtectedRoe = Math.max(
      input.minLockedRoe,
      input.peakRoe - input.protectGivebackRoe,
    );
    const maxSafeRoeAtCurrentPrice =
      input.currentRoe - input.immediateTriggerBufferPct * input.leverage;
    const protectedRoe = Math.max(
      input.minLockedRoe,
      Math.min(targetProtectedRoe, maxSafeRoeAtCurrentPrice),
    );
    const move = protectedRoe / input.leverage;
    const stopPrice =
      input.side === 'LONG'
        ? input.entryPrice * (1 + move)
        : input.entryPrice * (1 - move);
    return { protectedRoe, stopPrice };
  }
}
