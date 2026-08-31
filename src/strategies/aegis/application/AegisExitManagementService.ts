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

/** Application boundary for Aegis position-exit decisions. */
export class AegisExitManagementService {
  constructor(
    private readonly evaluator: AegisExitManagementEvaluator,
    readonly ports: AegisExitManagementPorts = {},
  ) {}

  evaluate(input: AegisExitManagementInput): Promise<boolean> {
    return this.evaluator(input);
  }
}
