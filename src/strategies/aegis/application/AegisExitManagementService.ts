import type { PositionInfo } from '../../../app/ports/Exchange';
import type { Logger } from '../../../app/ports/Logger';
import type { Notifier } from '../../../app/ports/Notifier';
import type { StateStore } from '../../../app/ports/StateStore';
import type { BotState, Side } from '../../../core/types';
import type { AegisExitEyeYamlConfig } from '../../../infra/config/ConfigLoader';
import type { AegisTradingSignal } from '../domain/AegisStrategy';
import { inspectCurrentBrainCanonicalDecision } from '../domain/CurrentBrainCanonicalDecision';
import { evaluateAegisExitEye, type AegisExitEyeDecision } from '../domain/services/AegisExitEye';
import { evaluateAegisExitEyeV2Shadow } from '../domain/services/AegisExitEyeV2Shadow';
import { classifyAegisExitDecision, type AegisExitDecisionEffect } from './AegisExitDecisionPolicy';
import type { AegisProfitProtectionInput } from './AegisProfitProtectionService';

const EXIT_EYE_SIGNAL_TTL_MS = 15_000;
const EXIT_EYE_SHADOW_ALERT_COOLDOWN_MS = 5 * 60 * 1000;

export interface AegisExitManagementInput {
  symbol: string;
  side: Side;
  botState: BotState;
  symbolState: StateStore;
  position: PositionInfo;
  markPrice: number;
  currentRoe: number;
  peakRoe: number;
  lowestRoe: number;
  tradeDurationMs: number;
}

export interface ClosePositionInput {
  symbol: string;
  side: Side;
  qtyAbs: number;
  sideMode: 'BOTH' | 'LONG' | 'SHORT';
  reason: string;
}

export interface AegisExitDecisionContext
  extends Omit<AegisExitManagementInput, 'tradeDurationMs' | 'lowestRoe'> {
  decision: AegisExitEyeDecision;
}

export interface AegisExitDecisionEffects {
  protectProfit(context: AegisExitDecisionContext): Promise<void>;
  closePosition(context: AegisExitDecisionContext, reason: string): Promise<void>;
  notify(context: AegisExitDecisionContext, force: boolean): Promise<void>;
}

export type AegisExitDecisionResult = 'PROTECTED' | 'CLOSED' | 'NOTIFIED';

export interface AegisExitEyeSignal {
  currentTurboAction?: string;
  rawAction?: string;
  gatedAction?: string;
  turboScore?: number;
  votes?: Record<string, number | undefined>;
  reason?: string;
}

export interface AegisExitManagementDeps {
  logger: Logger;
  notifier: Notifier;
  now(): number;
  getSignal(symbol: string): Promise<AegisTradingSignal>;
  getExitEyeConfig(): AegisExitEyeYamlConfig;
  getEntryThreshold(symbol: string): number;
  logTradeEvent(symbol: string, event: string, payload: Record<string, unknown>): Promise<void>;
  protectProfit(input: AegisProfitProtectionInput): Promise<unknown>;
  executePositionClose(input: ClosePositionInput): Promise<void>;
  notifyExit(
    symbol: string,
    side: Side,
    reason: string,
    state: BotState,
    exit: { exitPrice?: number; finalRoe?: number; pnl?: number },
  ): Promise<void>;
  formatRoe(value: number): string;
}

/** Owns Aegis ExitEye signal, policy, effects, and operator notification flow. */
export class AegisExitManagementService {
  private readonly signalCache = new Map<string, { at: number; signal: AegisTradingSignal }>();

  constructor(private readonly deps: AegisExitManagementDeps) {}

  async evaluate(input: AegisExitManagementInput): Promise<boolean> {
    const config = this.deps.getExitEyeConfig();
    const signal = await this.getSignal(input.symbol);
    const exitSignal = this.extractSignal(signal);
    const signalAegis = signal?.metadata?.aegis ?? signal?.aegis;
    const canonicalDecision = inspectCurrentBrainCanonicalDecision(signalAegis, input.symbol);
    const exitEyeV2Shadow = evaluateAegisExitEyeV2Shadow({
      symbol: input.symbol,
      positionSide: input.side,
      currentRoe: input.currentRoe,
      peakRoe: input.peakRoe,
      canonical: canonicalDecision,
      minimumPeakRoeToStudyProtection: config.min_peak_roe_to_protect,
      minimumGivebackRoeToStudyProtection: config.min_giveback_from_peak_roe,
    });
    try {
      await this.deps.logTradeEvent(input.symbol, 'EXIT_EYE_V2_SHADOW_OBSERVATION', {
        tradeId: input.botState.lastTradeId,
        price: input.markPrice,
        roe: input.currentRoe,
        reason: exitEyeV2Shadow.reason,
        metadata: {
          ...exitEyeV2Shadow,
          trailingChanged: false,
          callbackChanged: false,
          bracketChanged: false,
        },
      });
    } catch (error) {
      this.deps.logger.warn('aegis_exit_eye_v2_shadow_log_failed', {
        symbol: input.symbol,
        error: String(error),
      });
    }
    if (!config.enabled || config.mode === 'OFF') return false;

    const counters = this.updateCounters(
      input.side,
      input.botState,
      (patch) => input.symbolState.set(patch),
      exitSignal,
      config,
    );
    const decision = evaluateAegisExitEye({
      enabled: config.enabled,
      mode: config.mode,
      symbol: input.symbol,
      positionSide: input.side,
      currentRoe: input.currentRoe,
      peakRoe: input.peakRoe,
      lowestRoe: input.lowestRoe,
      minutesInTrade: input.tradeDurationMs / 60000,
      currentTurboAction: exitSignal.currentTurboAction,
      rawAction: exitSignal.rawAction,
      gatedAction: exitSignal.gatedAction,
      turboScore: exitSignal.turboScore,
      votes: exitSignal.votes,
      entryThreshold: this.deps.getEntryThreshold(input.symbol),
      currentReason: exitSignal.reason,
      minRoeToProtect: config.min_roe_to_protect,
      minPeakRoeToProtect: config.min_peak_roe_to_protect,
      minGivebackFromPeakRoe: config.min_giveback_from_peak_roe,
      neutralVotesToProtect: config.neutral_votes_to_protect,
      oppositeVotesToClose: config.opposite_votes_to_close,
      minRoeToCloseOnOpposite: config.min_roe_to_close_on_opposite,
      minPeakRoeToCloseOnOpposite: config.min_peak_roe_to_close_on_opposite,
      closeOnNeutralDecay: config.close_on_neutral_decay,
      neutralCloseVotes: config.neutral_close_votes,
      minRoeToCloseOnNeutral: config.min_roe_to_close_on_neutral,
      minPeakRoeToCloseOnNeutral: config.min_peak_roe_to_close_on_neutral,
      minGivebackToCloseOnNeutral: config.min_giveback_to_close_on_neutral,
      requireConsecutiveNeutralClose: config.require_consecutive_neutral_close,
      requireConsecutiveNeutral: config.require_consecutive_neutral,
      requireConsecutiveOpposite: config.require_consecutive_opposite,
      consecutiveNeutralCount: counters.neutralCount,
      consecutiveNeutralCloseCount: counters.neutralCloseCount,
      consecutiveOppositeCount: counters.oppositeCount,
      minMinutesInTrade: config.min_minutes_in_trade,
    });
    if (decision.action === 'NONE') return false;

    await this.handleDecision(input, decision);
    return decision.action === 'CLOSE_POSITION' && decision.shouldClose;
  }

  classifyDecision(decision: AegisExitEyeDecision, currentRoe: number): AegisExitDecisionEffect {
    return classifyAegisExitDecision(decision, currentRoe);
  }

  closePosition(input: ClosePositionInput): Promise<void> {
    return this.deps.executePositionClose(input);
  }

  async applyDecision(
    context: AegisExitDecisionContext,
    effects: AegisExitDecisionEffects,
  ): Promise<AegisExitDecisionResult> {
    const effect = this.classifyDecision(context.decision, context.currentRoe);
    if (effect === 'PROTECT_PROFIT') {
      await effects.protectProfit(context);
      return 'PROTECTED';
    }
    if (effect === 'CLOSE_POSITION') {
      const reason =
        context.decision.reason === 'neutral_momentum_decay_profit_exit'
          ? 'AEGIS_EXIT_EYE_NEUTRAL_DECAY'
          : 'AEGIS_EXIT_EYE_OPPOSITE_SIGNAL';
      await effects.closePosition(context, reason);
      return 'CLOSED';
    }
    await effects.notify(context, false);
    return 'NOTIFIED';
  }

  extractSignal(signal: AegisTradingSignal | null): AegisExitEyeSignal {
    const aegis = signal?.metadata?.aegis ?? signal?.aegis;
    const turbo = aegis?.turbo as any;
    const raw = turbo?.raw;
    const gated = turbo?.gated;
    return {
      currentTurboAction: turbo?.action ?? gated?.action ?? raw?.action,
      rawAction: raw?.action,
      gatedAction: gated?.action,
      turboScore: raw?.turbo_score ?? turbo?.turbo_score,
      votes: raw?.votes ?? turbo?.votes,
      reason: gated?.reason ?? raw?.reason ?? turbo?.reason,
    };
  }

  updateCounters(
    side: Side,
    botState: BotState,
    writeState: (patch: Partial<BotState>) => void,
    signal: AegisExitEyeSignal,
    config: AegisExitEyeYamlConfig,
  ): { neutralCount: number; neutralCloseCount: number; oppositeCount: number } {
    const action = String(signal.currentTurboAction || '').toUpperCase();
    const rawAction = String(signal.rawAction || '').toUpperCase();
    const gatedAction = String(signal.gatedAction || '').toUpperCase();
    const votes = signal.votes || {};
    const neutralCondition =
      action !== side && Number(votes.neutral ?? 0) >= config.neutral_votes_to_protect;
    const neutralCloseCondition =
      action !== side && Number(votes.neutral ?? 0) >= config.neutral_close_votes;
    const oppositeAction = side === 'LONG' ? 'SHORT' : 'LONG';
    const oppositeVotes = side === 'LONG' ? Number(votes.short ?? 0) : Number(votes.long ?? 0);
    const oppositeCondition =
      (action === oppositeAction ||
        rawAction === oppositeAction ||
        gatedAction === oppositeAction) &&
      oppositeVotes >= config.opposite_votes_to_close;
    const neutralCount = neutralCondition ? (botState.exitEyeNeutralCount || 0) + 1 : 0;
    const neutralCloseCount = neutralCloseCondition
      ? (botState.exitEyeNeutralCloseCount || 0) + 1
      : 0;
    const oppositeCount = oppositeCondition ? (botState.exitEyeOppositeCount || 0) + 1 : 0;
    writeState({
      exitEyeNeutralCount: neutralCount,
      exitEyeNeutralCloseCount: neutralCloseCount,
      exitEyeOppositeCount: oppositeCount,
    });
    return { neutralCount, neutralCloseCount, oppositeCount };
  }

  private async getSignal(symbol: string): Promise<AegisTradingSignal | null> {
    const cached = this.signalCache.get(symbol);
    const now = this.deps.now();
    if (cached && now - cached.at < EXIT_EYE_SIGNAL_TTL_MS) return cached.signal;
    try {
      const signal = await this.deps.getSignal(symbol);
      this.signalCache.set(symbol, { at: now, signal });
      return signal;
    } catch (error) {
      this.deps.logger.warn('aegis_exit_eye_signal_unavailable', {
        symbol,
        error: String(error),
      });
      return null;
    }
  }

  private async handleDecision(
    input: AegisExitManagementInput,
    decision: AegisExitEyeDecision,
  ): Promise<void> {
    const event = `AEGIS_EXIT_EYE_${decision.action}`;
    const metadata = {
      decision,
      currentRoe: input.currentRoe,
      peakRoe: input.peakRoe,
      givebackRoe: decision.metadata.givebackRoe,
      currentTurboAction: decision.metadata.currentTurboAction,
      rawAction: decision.metadata.rawAction,
      gatedAction: decision.metadata.gatedAction,
      turboScore: decision.metadata.turboScore,
      votes: decision.metadata.votes,
      reason: decision.reason,
    };
    input.symbolState.set({
      lastExitEyeAction: decision.action,
      lastExitEyeReason: decision.reason,
      lastExitEyeAt: this.deps.now(),
    });
    await this.deps.logTradeEvent(input.symbol, event, {
      tradeId: input.botState.lastTradeId,
      price: input.markPrice,
      roe: input.currentRoe,
      reason: decision.reason,
      metadata,
    });
    const logPayload = {
      symbol: input.symbol,
      side: input.side,
      action: decision.action,
      shouldClose: decision.shouldClose,
      shouldProtect: decision.shouldProtect,
      reason: decision.reason,
      currentRoe: input.currentRoe,
      peakRoe: input.peakRoe,
      givebackRoe: decision.metadata.givebackRoe,
      mode: this.deps.getExitEyeConfig().mode,
    };
    if (decision.action === 'CLOSE_POSITION') {
      this.deps.logger.warn('aegis_exit_eye_decision', logPayload);
    } else {
      this.deps.logger.info('aegis_exit_eye_decision', logPayload);
    }

    const context: AegisExitDecisionContext = { ...input, decision };
    await this.applyDecision(context, {
      protectProfit: async (value) => {
        await this.deps.protectProfit(value);
      },
      closePosition: async (value, exitReason) => {
        await this.closePosition({
          symbol: value.symbol,
          side: value.side,
          qtyAbs: value.position.qtyAbs,
          sideMode: value.position.sideMode,
          reason: exitReason,
        });
        value.symbolState.set({
          mode: 'IDLE',
          lastExitAt: this.deps.now(),
          lastExitReason: exitReason,
        });
        await this.deps.notifyExit(value.symbol, value.side, exitReason, value.botState, {
          exitPrice: value.markPrice,
          finalRoe: value.currentRoe,
        });
        await this.sendTelegram(value.symbol, value.side, value.decision, true);
      },
      notify: async (value, force) => {
        await this.sendTelegram(value.symbol, value.side, value.decision, force, value.symbolState);
      },
    });
  }

  private async sendTelegram(
    symbol: string,
    side: Side,
    decision: AegisExitEyeDecision,
    force: boolean,
    symbolState?: StateStore,
  ): Promise<void> {
    const state = symbolState?.get();
    const now = this.deps.now();
    if (
      !force &&
      state?.lastExitEyeTelegramAt &&
      now - state.lastExitEyeTelegramAt < EXIT_EYE_SHADOW_ALERT_COOLDOWN_MS
    ) {
      return;
    }
    if (symbolState) symbolState.set({ lastExitEyeTelegramAt: now });
    const votes = decision.metadata.votes || {};
    if (force && decision.reason === 'neutral_momentum_decay_profit_exit') {
      await this.deps.notifier.sendMessage(
        `👁️ **AEGIS EXIT EYE**\n` +
          `${symbol} ${side} ${side === 'LONG' ? '📈' : '📉'}\n` +
          `Cierre por pérdida de momentum\n` +
          `ROE: ${this.deps.formatRoe(decision.metadata.currentRoe)} | Peak: ${this.deps.formatRoe(decision.metadata.peakRoe)}\n` +
          `Señal actual: ${decision.metadata.currentTurboAction ?? 'N/D'} | Votes L=${votes.long ?? 0} S=${votes.short ?? 0} N=${votes.neutral ?? 0}\n` +
          `Motivo: neutralidad fuerte + devolución de profit`,
      );
      return;
    }
    const suggested = decision.action.includes('CLOSE') ? 'CERRAR' : 'PROTEGER GANANCIA';
    const modeLine = force
      ? 'CLOSE ejecutado'
      : `Modo: ${this.deps.getExitEyeConfig().mode}, no se cerró`;
    await this.deps.notifier.sendMessage(
      `👁️ **AEGIS EXIT EYE**\n` +
        `${symbol} ${side} ${side === 'LONG' ? '📈' : '📉'}\n` +
        `Acción sugerida: ${suggested}\n` +
        `ROE actual: ${this.deps.formatRoe(decision.metadata.currentRoe)} | Peak: ${this.deps.formatRoe(decision.metadata.peakRoe)}\n` +
        `Señal actual: ${decision.metadata.currentTurboAction ?? 'N/D'} | Votes L=${votes.long ?? 0} S=${votes.short ?? 0} N=${votes.neutral ?? 0}\n` +
        `Motivo: ${decision.reason}\n` +
        modeLine,
    );
  }
}
