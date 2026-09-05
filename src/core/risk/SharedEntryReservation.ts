export type SharedEntryReservationResult =
  | {
      acquired: true;
      symbol: string;
      release: () => void;
    }
  | {
      acquired: false;
      reason: 'ACCOUNT_BUSY' | 'SYMBOL_BUSY';
    };

/** Process-local account reservation for one in-flight entry intent. */
export class SharedEntryReservation {
  private activeSymbol: string | undefined;
  private released = false;

  tryAcquire(symbol: string): SharedEntryReservationResult {
    if (this.activeSymbol !== undefined) {
      return {
        acquired: false,
        reason: this.activeSymbol === symbol ? 'SYMBOL_BUSY' : 'ACCOUNT_BUSY',
      };
    }

    this.activeSymbol = symbol;
    this.released = false;
    return {
      acquired: true,
      symbol,
      release: () => {
        if (this.released) return;
        this.released = true;
        this.activeSymbol = undefined;
      },
    };
  }
}
