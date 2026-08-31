import type { Side } from '../../../core/types';
import type {
  AegisExitConfigPort,
  AegisExitExecutionPort,
  AegisExitNotificationPort,
  AegisExitStatePort,
  AegisExitTelemetryPort,
} from './AegisExitManagementPorts';

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

/** Application boundary for Aegis position-exit decisions. */
export class AegisExitManagementService {
  constructor(
    private readonly evaluator: AegisExitManagementEvaluator,
    readonly ports: AegisExitManagementPorts = {},
  ) {}

  evaluate(input: AegisExitManagementInput): Promise<boolean> {
    return this.evaluator(input);
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
}
