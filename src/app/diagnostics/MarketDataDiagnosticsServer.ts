import { createServer, type Server } from 'node:http';
import type { Logger } from '../ports/Logger';

export interface MarketDataDiagnosticsServerOptions {
  readonly port?: number;
  readonly getDiagnostics: () => Record<string, unknown>;
  readonly logger: Pick<Logger, 'info' | 'error'>;
}

export class MarketDataDiagnosticsServer {
  private readonly server: Server;

  constructor(private readonly options: MarketDataDiagnosticsServerOptions) {
    this.server = createServer((request, response) => {
      if (request.method !== 'GET' || request.url !== '/diagnostics/market-data') {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'NOT_FOUND' }));
        return;
      }
      try {
        const body = JSON.stringify(options.getDiagnostics());
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        response.end(body);
      } catch (error) {
        options.logger.error('market_data_diagnostics_failed', { error: String(error) });
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'DIAGNOSTICS_UNAVAILABLE' }));
      }
    });
  }

  start(): void {
    const port = this.options.port ?? Number(process.env.BOT_DIAGNOSTICS_PORT ?? 8010);
    this.server.on('error', (error) =>
      this.options.logger.error('market_data_diagnostics_server_error', { error: String(error) }),
    );
    this.server.listen(port, '127.0.0.1', () => {
      this.options.logger.info('market_data_diagnostics_started', { host: '127.0.0.1', port });
    });
  }

  getPort(): number | undefined {
    const address = this.server.address();
    return address && typeof address === 'object' ? address.port : undefined;
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server.listening) {
        resolve();
        return;
      }
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
