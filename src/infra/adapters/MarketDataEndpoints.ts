export type MarketDataAccessMode = 'public' | 'market';

export interface MarketDataEndpointDescriptor {
  readonly accessMode: MarketDataAccessMode;
}

export const PUBLIC: MarketDataEndpointDescriptor = { accessMode: 'public' };
export const MARKET: MarketDataEndpointDescriptor = { accessMode: 'market' };

export interface MarketDataEndpointConfig {
  baseUrl: string;
}

const ENDPOINTS: Record<'production' | 'testnet', MarketDataEndpointConfig> = {
  production: { baseUrl: 'wss://fstream.binance.com' },
  testnet: { baseUrl: 'wss://stream.binancefuture.com' },
};

export function resolveMarketDataEndpoint(isTestnet: boolean): MarketDataEndpointConfig {
  return ENDPOINTS[isTestnet ? 'testnet' : 'production'];
}

export function streamWebSocketUrl(
  endpoint: MarketDataEndpointConfig,
  stream: string,
  _descriptor: MarketDataEndpointDescriptor,
): string {
  return `${endpoint.baseUrl}/ws/${stream}`;
}

export function combinedStreamWebSocketUrl(
  endpoint: MarketDataEndpointConfig,
  streams: string[],
  _descriptor: MarketDataEndpointDescriptor,
): string {
  return `${endpoint.baseUrl}/stream?streams=${streams.join('/')}`;
}
