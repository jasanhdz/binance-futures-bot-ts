import type { Side } from '../../../core/types';
import type {
  AegisExitConfigPort,
  AegisExitExecutionPort,
  AegisExitNotificationPort,
  AegisExitStatePort,
  AegisExitTelemetryPort,
} from './AegisExitManagementPorts';
import {
  classifyAegisExitDecision,
  type AegisExitDecisionEffect,
} from './AegisExitDecisionPolicy';
import type { AegisExitEyeDecision } from '../domain/services/AegisExitEye';

export interface AegisExitManagementPorts {
  config?: AegisExitConfigPort;
  state?: AegisExitStatePort;
  execution?: AegisExitExecutionPort;
  telemetry?: AegisExitTelemetryPort;
  notifications?: AegisExitNotificationPort;
}

export interface AegisExitManagementInput {
  symbol: string;
  side: Side;
  botState: unknown;
  symbolState: unknown;
  position: unknown;
  markPrice: number;
  currentRoe: number;
  peakRoe: number;
  lowestRoe: number;
  tradeDurationMs: number;
}

export type AegisExitManagementEvaluator = (input: AegisExitManagementInput) => Promise<boolean>;

export interface ProtectedStopInput {
  side: Side;
  entryPrice: number;
  leverage: number;
  currentRoe: number;
  peakRoe: number;
  minLockedRoe: number;
  protectGivebackRoe: number;
  immediateTriggerBufferPct: number;
}

export interface ClosePositionInput {
  symbol: string;
  side: Side;
  qtyAbs: number;
  sideMode: 'BOTH' | 'LONG' | 'SHORT';
  reason: string;
}

export interface AegisExitEyeSignal {
  currentTurboAction?: string;
  rawAction?: string;
  gatedAction?: string;
  turboScore?: number;
  votes?: Record<string, number | undefined>;
  reason?: string;
}

export interface AegisExitEyeCounterConfig {
  neutral_votes_to_protect: number;
  neutral_close_votes: number;
  opposite_votes_to_close: number;
}

/** Application boundary for Aegis position-exit decisions. */
export class AegisExitManagementService {
  constructor(
    private readonly evaluator: AegisExitManagementEvaluator,
    readonly ports: AegisExitManagementPorts = {},
  ) {}

  evaluate(input: AegisExitManagementInput): Promise<boolean> {
    return this.evaluator(input);
  }

  classifyDecision(decision: AegisExitEyeDecision, currentRoe: number): AegisExitDecisionEffect {
    return classifyAegisExitDecision(decision, currentRoe);
  }

  closePosition(input: ClosePositionInput): Promise<void> {
    if (!this.ports.execution?.closeSideMarketSafe) {
      return Promise.reject(new Error('AEGIS_EXIT_CLOSE_POSITION_PORT_UNAVAILABLE'));
    }
    return this.ports.execution.closeSideMarketSafe(
      input.symbol,
      input.side,
      input.qtyAbs,
      input.sideMode,
      input.reason,
    );
  }

  protectedStopPrice(input: ProtectedStopInput): { protectedRoe: number; stopPrice: number } {
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

  wouldStopTriggerImmediately(
    side: Side,
    stopPrice: number,
    markPrice: number,
    bufferPct: number,
  ): boolean {
    if (!Number.isFinite(stopPrice) || !Number.isFinite(markPrice) || markPrice <= 0) return true;
    return side === 'LONG'
      ? stopPrice >= markPrice * (1 - bufferPct)
      : stopPrice <= markPrice * (1 + bufferPct);
  }

  moveCloseStop<T>(params: unknown): Promise<T> {
    if (!this.ports.execution?.moveCloseStop) {
      return Promise.reject(new Error('AEGIS_EXIT_MOVE_STOP_PORT_UNAVAILABLE'));
    }
    return this.ports.execution.moveCloseStop(params) as Promise<T>;
  }

  extractSignal(signal: any | null): AegisExitEyeSignal {
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
    botState: any,
    writeState: (patch: Record<string, unknown>) => void,
    signal: AegisExitEyeSignal,
    config: AegisExitEyeCounterConfig,
  ): { neutralCount: number; neutralCloseCount: number; oppositeCount: number } {
    const action = String(signal.currentTurboAction || '').toUpperCase();
    const rawAction = String(signal.rawAction || '').toUpperCase();
    const gatedAction = String(signal.gatedAction || '').toUpperCase();
    const votes = signal.votes || {};
    const neutralCondition = action !== side && Number(votes.neutral ?? 0) >= config.neutral_votes_to_protect;
    const neutralCloseCondition = action !== side && Number(votes.neutral ?? 0) >= config.neutral_close_votes;
    const oppositeAction = side === 'LONG' ? 'SHORT' : 'LONG';
    const oppositeVotes = side === 'LONG' ? Number(votes.short ?? 0) : Number(votes.long ?? 0);
    const oppositeCondition =
      (action === oppositeAction || rawAction === oppositeAction || gatedAction === oppositeAction) &&
      oppositeVotes >= config.opposite_votes_to_close;
    const neutralCount = neutralCondition ? (botState.exitEyeNeutralCount || 0) + 1 : 0;
    const neutralCloseCount = neutralCloseCondition ? (botState.exitEyeNeutralCloseCount || 0) + 1 : 0;
    const oppositeCount = oppositeCondition ? (botState.exitEyeOppositeCount || 0) + 1 : 0;
    writeState({ exitEyeNeutralCount: neutralCount, exitEyeNeutralCloseCount: neutralCloseCount, exitEyeOppositeCount: oppositeCount });
    return { neutralCount, neutralCloseCount, oppositeCount };
  }
}
