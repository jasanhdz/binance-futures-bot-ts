import cron from 'node-cron';
import { StrategyRunner } from './strategy-runner';
import { checkTakeProfit } from './guards/take-profit';
import { enforceProfitGuard } from './guards/profit-guard';
import { syncStateGuard } from './guards/sync-state';
import { bracketsGuard } from './guards/ensure-brackets';
import { pyramidGuard } from './guards/pyramid-guard';

export function startBot(deps: {
  runner: StrategyRunner;
  symbol: string;
  exchange: any;
  state: any;
  logger: any;
  intervalSec: number;
}) {
  const { runner, symbol, exchange, state, logger, intervalSec } = deps;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'system';
  let running = false;
  let seq = 0;

  const tick = async () => {
    if (running) return;
    running = true;

    try {
      // “heartbeat” de desfase con el server (1 vez cada 12 ticks aprox)
      if (seq % 12 === 1 && typeof exchange.getServerTime === 'function') {
        try {
          const server = await exchange.getServerTime();
          logger.debug('time_drift', { driftMs: server - Date.now() });
        } catch (e: any) {
          logger.warn('time_drift_fail', { err: e?.message || String(e) });
        }
      }

      await syncStateGuard(symbol, exchange, state, logger);
      await bracketsGuard(symbol, exchange, state, logger);

      await checkTakeProfit(symbol, exchange, state, logger);
      await enforceProfitGuard(symbol, exchange, state, logger);
      await pyramidGuard(symbol, exchange, state, logger);

      await runner.tick(symbol);
    } catch (e: any) {
      logger.error('tick_error', { err: e?.message || e });
    } finally {
      running = false;
    }
  };

  tick(); // primer tick inmediato
  cron.schedule(`*/${intervalSec} * * * * *`, tick, { timezone: tz });
}
