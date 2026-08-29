import { CONFIG } from '../../infra/config/environment';
import { createApplicationInfrastructure } from './ApplicationInfrastructure';
import { createCommandListener } from './CommandComposition';
import { composeStrategyRuntime } from './StrategyComposition';

export interface TradingApplicationSummary {
  runtimeMode: string;
  symbols: readonly string[];
  tickIntervalMs: number;
}

export interface TradingApplication {
  readonly summary: TradingApplicationSummary;
  start(): Promise<void>;
  stop(signal: 'SIGINT' | 'SIGTERM'): Promise<boolean>;
}

/** Application composition root: infrastructure -> strategies -> commands -> lifecycle. */
export function createTradingApplication(): TradingApplication {
  const infrastructure = createApplicationInfrastructure();
  const runtime = composeStrategyRuntime(infrastructure);
  const commands = createCommandListener(infrastructure, runtime);
  let shutdownStarted = false;

  return {
    summary: Object.freeze({
      runtimeMode: CONFIG.TRADING_MODE,
      symbols: Object.freeze([...runtime.config.symbols]),
      tickIntervalMs: runtime.config.tickIntervalMs,
    }),

    async start(): Promise<void> {
      commands?.start();
      await runtime.service.start();
    },

    async stop(signal: 'SIGINT' | 'SIGTERM'): Promise<boolean> {
      if (shutdownStarted) {
        infrastructure.logger.warn('shutdown_already_in_progress', { signal });
        return false;
      }
      shutdownStarted = true;
      commands?.stop();
      return stopWithTimeout(runtime.service.stop(), infrastructure.logger, signal);
    },
  };
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
