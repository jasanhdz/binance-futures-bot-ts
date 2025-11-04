import { Exchange } from '../../core/ports/Exchange';
import { StateStore } from '../../core/ports/StateStore';
import { Logger } from '../../core/ports/Logger';
import { CONFIG } from '../../infra/config';
import { intelligentTakeProfitMl } from './intelligent-tp-ml';

type GuardContext = {
  symbol: string;
  exchange: Exchange;
  state: StateStore;
  logger: Logger;
};

class IntelligentTpSupervisor {
  private readonly contexts = new Map<string, GuardContext>();
  private readonly running = new Set<string>();
  private readonly intervalMs: number;
  private readonly maxConcurrency: number;
  private readonly logPings: boolean;
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(intervalMs: number, concurrency: number, logPings: boolean) {
    this.intervalMs = Math.max(250, intervalMs);
    this.maxConcurrency = Math.max(1, concurrency);
    this.logPings = logPings;
  }

  register(ctx: GuardContext) {
    this.contexts.set(ctx.symbol, ctx);
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.tick();
      }, this.intervalMs);
      if (typeof this.timer.unref === 'function') {
        this.timer.unref();
      }
    }
  }

  private async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const active: Array<{ ctx: GuardContext; snapshot: ReturnType<StateStore['get']> }> = [];
      for (const ctx of this.contexts.values()) {
        if (this.running.has(ctx.symbol)) continue;
        const snapshot = ctx.state.get();
        if (!snapshot || snapshot.mode === 'IDLE') continue;
        active.push({ ctx, snapshot });
      }
      if (!active.length) return;

      const batchSize = this.maxConcurrency;
      for (let i = 0; i < active.length; i += batchSize) {
        const slice = active.slice(i, i + batchSize);
        await Promise.all(
          slice.map(async ({ ctx, snapshot }) => {
            if (this.running.has(ctx.symbol)) return;
            this.running.add(ctx.symbol);
            try {
              await intelligentTakeProfitMl(ctx.symbol, ctx.exchange, ctx.state, ctx.logger);
            } catch (err: any) {
              ctx.logger.warn('intelli_tp_supervisor_error', {
                symbol: ctx.symbol,
                err: err?.message || String(err),
              });
            } finally {
              this.running.delete(ctx.symbol);
              if (this.logPings) {
                try {
                  const latest = ctx.state.get();
                  ctx.logger.info('tp_ml_ping', {
                    symbol: ctx.symbol,
                    modeBefore: snapshot?.mode,
                    modeAfter: latest?.mode,
                    lastSide: latest?.lastSide,
                    peakRoe: latest?.peakRoe,
                  });
                } catch (e: any) {
                  ctx.logger.warn('intelli_tp_supervisor_ping_fail', {
                    symbol: ctx.symbol,
                    err: e?.message || String(e),
                  });
                }
              }
            }
          }),
        );
      }
    } finally {
      this.ticking = false;
    }
  }
}

const supervisorInstance = (() => {
  let inst: IntelligentTpSupervisor | null = null;
  return () => {
    if (!inst) {
      const intervalMs =
        Number(CONFIG.INT_TP_SUP_INTERVAL_MS ?? 0) > 0
          ? Number(CONFIG.INT_TP_SUP_INTERVAL_MS)
          : 1_500;
      const concurrency =
        Number(CONFIG.INT_TP_SUP_CONCURRENCY ?? 0) > 0
          ? Number(CONFIG.INT_TP_SUP_CONCURRENCY)
          : 4;
      inst = new IntelligentTpSupervisor(
        intervalMs,
        concurrency,
        !!CONFIG.INT_TP_SUP_LOG_PINGS,
      );
    }
    return inst;
  };
})();

export function registerIntelligentTpGuard(context: GuardContext) {
  supervisorInstance().register(context);
}
