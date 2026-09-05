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
  private activeToken: symbol | undefined;

  tryAcquire(symbol: string): SharedEntryReservationResult {
    if (this.activeSymbol !== undefined) {
      return {
        acquired: false,
        reason: this.activeSymbol === symbol ? 'SYMBOL_BUSY' : 'ACCOUNT_BUSY',
      };
    }

    this.activeSymbol = symbol;
    const token = Symbol(symbol);
    this.activeToken = token;
    let released = false;
    return {
      acquired: true,
      symbol,
      release: () => {
        if (released) return;
        released = true;
        if (this.activeToken !== token) return;
        this.activeToken = undefined;
        this.activeSymbol = undefined;
      },
    };
  }
}
