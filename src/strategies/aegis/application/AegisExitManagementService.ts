import type { Side } from '../../../core/types';

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
  constructor(private readonly evaluator: AegisExitManagementEvaluator) {}

  evaluate(input: AegisExitManagementInput): Promise<boolean> {
    return this.evaluator(input);
  }
}
