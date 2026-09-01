import { CONFIG } from './infra/config/environment';
import { createApplicationInfrastructure } from './app/bootstrap/ApplicationInfrastructure';
import { createCommandListener } from './app/bootstrap/CommandComposition';
import { composeStrategyRuntime } from './app/bootstrap/StrategyComposition';
import { MarketDataDiagnosticsServer } from './app/diagnostics/MarketDataDiagnosticsServer';

/** Process entry point and application composition root. */
async function main(): Promise<void> {
  console.log('Trading System');
  console.log('==============');

  const infrastructure = createApplicationInfrastructure();
  const runtime = composeStrategyRuntime(infrastructure);
  const commands = createCommandListener(infrastructure, runtime);
  const diagnostics = new MarketDataDiagnosticsServer({
    getDiagnostics: () => runtime.service.getMarketDataDiagnostics(),
    logger: infrastructure.logger,
  });
  diagnostics.start();

  console.log(`Runtime mode: ${CONFIG.TRADING_MODE}`);
  console.log(`Active symbols: ${runtime.config.symbols.join(', ')}`);
  console.log(`Tick interval: ${runtime.config.tickIntervalMs}ms`);

  let shutdownStarted = false;
  const shutdown = async (signal: 'SIGINT' | 'SIGTERM'): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    commands?.stop();
    const completed = await stopWithTimeout(runtime.service.stop(), infrastructure.logger, signal);
    await diagnostics
      .stop()
      .catch((error) =>
        infrastructure.logger.error('market_data_diagnostics_stop_failed', {
          error: String(error),
        }),
      );
    process.exit(completed ? 0 : 1);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    commands?.start();
    await runtime.service.start();
  } catch (error) {
    console.error('Fatal startup error:', error);
    process.exitCode = 1;
  }
}

async function stopWithTimeout(
  stop: Promise<void>,
  logger: {
    info(message: string, context?: unknown): void;
    error(message: string, context?: unknown): void;
  },
  signal: 'SIGINT' | 'SIGTERM',
): Promise<boolean> {
  const timeoutMs = 15_000;
  logger.info('shutdown_started', { signal, timeoutMs });
  try {
    const completed = await Promise.race([
      stop.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
    if (!completed) logger.error('shutdown_timeout', { signal, timeoutMs });
    else logger.info('shutdown_completed', { signal });
    return completed;
  } catch (error) {
    logger.error('shutdown_failed', { signal, error: String(error) });
    return false;
  }
}

void main();
