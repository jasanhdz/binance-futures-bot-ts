import { request } from 'node:http';
import { describe, expect, it } from 'vitest';
import { MarketDataDiagnosticsServer } from './MarketDataDiagnosticsServer';

describe('MarketDataDiagnosticsServer', () => {
  it('serves only the local read-only diagnostic route', async () => {
    let reads = 0;
    const server = new MarketDataDiagnosticsServer({
      port: 0,
      getDiagnostics: () => {
        reads++;
        return { version: 'MARKET_DATA_DIAGNOSTICS_V1', symbols: [] };
      },
      logger: { info: () => {}, error: () => {} },
    });
    server.start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const port = server.getPort();
    expect(port).toBeTypeOf('number');

    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path: '/diagnostics/market-data', method: 'GET' },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });
    await server.stop();

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).version).toBe('MARKET_DATA_DIAGNOSTICS_V1');
    expect(reads).toBe(1);
  });
});
