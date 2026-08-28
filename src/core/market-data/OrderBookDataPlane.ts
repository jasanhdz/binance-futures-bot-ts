import { OrderBookPort } from '../../app/ports/MarketData';

export interface OrderBookLease<T extends OrderBookPort> {
  readonly book: T;
  release(): void;
}

type BookEntry<T extends OrderBookPort> = {
  book: T;
  references: number;
};

/** Owns one synchronized, read-only order book per symbol. */
export class OrderBookDataPlane<T extends OrderBookPort = OrderBookPort> {
  private readonly books = new Map<string, BookEntry<T>>();

  constructor(private readonly createBook: (symbol: string) => T) {}

  acquire(symbol: string): OrderBookLease<T> {
    const normalizedSymbol = symbol.toUpperCase();
    let entry = this.books.get(normalizedSymbol);
    if (!entry) {
      const book = this.createBook(normalizedSymbol);
      entry = { book, references: 0 };
      this.books.set(normalizedSymbol, entry);
      book.start();
    }
    entry.references++;

    let released = false;
    return {
      book: entry.book,
      release: () => {
        if (released) return;
        released = true;
        const current = this.books.get(normalizedSymbol);
        if (!current || current.book !== entry!.book) return;
        current.references--;
        if (current.references === 0) {
          current.book.stop();
          this.books.delete(normalizedSymbol);
        }
      },
    };
  }

  get(symbol: string): T | undefined {
    return this.books.get(symbol.toUpperCase())?.book;
  }

  getReferenceCount(symbol: string): number {
    return this.books.get(symbol.toUpperCase())?.references ?? 0;
  }

  close(): void {
    for (const entry of this.books.values()) entry.book.stop();
    this.books.clear();
  }
}
