// src/strategies/composite.ts
import { Strategy, StrategyContext } from './types';

type Entry = {
  name: string;
  strategy: Strategy;
  enabled?: (config: StrategyContext['config']) => boolean;
};

export function composeStrategies(entries: Entry[]): Strategy {
  if (entries.length === 0) {
    throw new Error('composeStrategies requires at least one strategy');
  }

  return {
    name: 'composite',
    timeframe: entries[0]?.strategy.timeframe ?? '5m',

    async evaluate(ctx: StrategyContext) {
      const { logger, config } = ctx;
      const diagnostics: string[] = [];

      for (const entry of entries) {
        if (entry.enabled && !entry.enabled(config)) {
          diagnostics.push(`${entry.name}:disabled`);
          continue;
        }

        const sig = await entry.strategy.evaluate(ctx);
        if (sig.action !== 'IDLE') {
          const reason =
            sig.reason && sig.reason.length > 0
              ? `${entry.name}:${sig.reason}`
              : `${entry.name}`;
          return { ...sig, reason };
        }
        diagnostics.push(`${entry.name}:idle`);
      }

      if (logger) {
        logger.debug('composite_idle', { diagnostics });
      }
      return { action: 'IDLE', reason: diagnostics.join('|') };
    },
  };
}
