export type MomentumEntryEvaluator = (symbol: string) => Promise<boolean>;

/** Application boundary for standalone Momentum entry evaluation. */
export class MomentumEntryCoordinator {
  constructor(private readonly evaluator: MomentumEntryEvaluator) {}

  evaluate(symbol: string): Promise<boolean> {
    return this.evaluator(symbol);
  }
}
