import cron from 'node-cron';
import { StrategyRunner } from './strategy-runner';
import { checkTakeProfit } from './guards/take-profit';
import { enforceProfitGuard } from './guards/profit-guard';
import { syncStateGuard } from './guards/sync-state';
import { bracketsGuard } from './guards/ensure-brackets';
import { pyramidGuard } from './guards/pyramid-guard';
import { intelligentTakeProfit } from './guards/intelligent-tp';
import {
  getRateLimitUntil,
  isRateLimited,
  noteRateLimitFromError,
} from '../infra/rate-limit';

export function startBot(deps: {
  runner: StrategyRunner;
  symbol: string;
  exchange: any;
  state: any;
  logger: any;
  intervalSec: number;
  initialDelayMs?: number;
}) {
  const { runner, symbol, exchange, state, logger, intervalSec, initialDelayMs = 0 } = deps;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'system';
  let running = false;
  let seq = 0;
  let lastRateLimitLog = 0;

  const tick = async () => {
    if (running) return;
    running = true;

    const now = Date.now();
    if (isRateLimited(now)) {
      if (now - lastRateLimitLog > 10_000) {
        lastRateLimitLog = now;
        const remaining = getRateLimitUntil() - now;
        logger.warn('rate_limit_cooldown', { symbol, msRemaining: Math.max(0, remaining) });
      }
      running = false;
      return;
    }

    try {
      seq += 1;
      // “heartbeat” de desfase con el server (1 vez cada 12 ticks aprox)
      if (seq % 12 === 1 && typeof exchange.getServerTime === 'function') {
        try {
          const server = await exchange.getServerTime();
          logger.debug('time_drift', { symbol, driftMs: server - Date.now() });
        } catch (e: any) {
          logger.warn('time_drift_fail', { symbol, err: e?.message || String(e) });
        }
      }

      await syncStateGuard(symbol, exchange, state, logger);
      await bracketsGuard(symbol, exchange, state, logger);

      await checkTakeProfit(symbol, exchange, state, logger);
      await intelligentTakeProfit(symbol, exchange, state, logger);
      // await enforceProfitGuard(symbol, exchange, state, logger);
      // await pyramidGuard(symbol, exchange, state, logger);

      await runner.tick(symbol);
    } catch (e: any) {
      const until = noteRateLimitFromError(e);
      if (until) {
        logger.warn('rate_limit_detected', { symbol, banUntil: until });
      }
      logger.error('tick_error', { symbol, err: e?.message || e });
    } finally {
      running = false;
    }
  };

  const schedule = () => cron.schedule(`*/${intervalSec} * * * * *`, tick, { timezone: tz });

  if (initialDelayMs > 0) {
    setTimeout(() => {
      tick();
      schedule();
    }, initialDelayMs);
  } else {
    tick();
    schedule();
  }
}
