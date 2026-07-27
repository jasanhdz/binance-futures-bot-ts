export type AegisClosedTradeOutcome = {
  tradeId: string;
  closedAt: string;
  pnlUsdt: number;
};

export type AegisConsecutiveLossUpdate = {
  applied: boolean;
  previous: number;
  current: number;
};

export class AegisConsecutiveLossTracker {
  private consecutiveLosses = 0;
  private readonly processedTradeIds = new Set<string>();

  get value(): number {
    return this.consecutiveLosses;
  }

  get processedCount(): number {
    return this.processedTradeIds.size;
  }

  restore(outcomes: AegisClosedTradeOutcome[]): void {
    this.consecutiveLosses = 0;
    this.processedTradeIds.clear();

    const ordered = [...outcomes].sort((left, right) => {
      const timeDifference = Date.parse(left.closedAt) - Date.parse(right.closedAt);
      return timeDifference !== 0 ? timeDifference : left.tradeId.localeCompare(right.tradeId);
    });
    for (const outcome of ordered) {
      this.record(outcome.tradeId, outcome.pnlUsdt);
    }
  }

  record(tradeId: string, pnlUsdt: number): AegisConsecutiveLossUpdate {
    const previous = this.consecutiveLosses;
    if (!tradeId || !Number.isFinite(pnlUsdt) || this.processedTradeIds.has(tradeId)) {
      return { applied: false, previous, current: previous };
    }

    this.processedTradeIds.add(tradeId);
    this.consecutiveLosses = pnlUsdt < 0 ? previous + 1 : 0;
    return { applied: true, previous, current: this.consecutiveLosses };
  }
}
