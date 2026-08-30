import type { AegisMarketContextV1 } from './AegisMarketContext';

export type AegisMarketContextProvider = (symbol: string) => AegisMarketContextV1 | null;

let currentProvider: AegisMarketContextProvider | null = null;

/**
 * Application-local bridge between the shared WebSocket market runtime and the
 * Aegis ML client. Registration is lifecycle-scoped and safe to release.
 */
export function registerAegisMarketContextProvider(
  provider: AegisMarketContextProvider,
): () => void {
  currentProvider = provider;
  return () => {
    if (currentProvider === provider) currentProvider = null;
  };
}

export function readAegisMarketContext(symbol: string): AegisMarketContextV1 | null {
  return currentProvider?.(symbol.trim().toUpperCase()) ?? null;
}
