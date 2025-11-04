const DATA_QUOTES = ['USDT', 'BUSD', 'USDC', 'BTC', 'ETH'];

export function resolveDataSymbol(symbol: string, override?: string): string {
  if (override) return override;
  if (symbol.includes('/')) return symbol;
  const upper = symbol.toUpperCase();
  for (const quote of DATA_QUOTES) {
    if (upper.endsWith(quote)) {
      const base = upper.slice(0, -quote.length);
      return `${base}/${quote}`;
    }
  }
  return upper;
}
