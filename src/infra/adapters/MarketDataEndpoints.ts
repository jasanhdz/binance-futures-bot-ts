export type WebSocketAccessMode = 'public' | 'market' | 'private';

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
  accessMode: WebSocketAccessMode = 'public',
): string {
  return `${endpoint.baseUrl}/${accessMode}/ws/${stream}`;
}

export function combinedStreamWebSocketUrl(
  endpoint: MarketDataEndpointConfig,
  streams: string[],
  accessMode: WebSocketAccessMode = 'public',
): string {
  return `${endpoint.baseUrl}/${accessMode}/stream?streams=${streams.join('/')}`;
}
