import { Exchange } from '../core/ports/Exchange';
import { Logger } from '../core/ports/Logger';
import { StateStore } from '../core/ports/StateStore';
import { Side } from '../core/types';
import { sizeByBudget } from '../core/risk/sizing';
import { computeStopFromLiqTicks, roundToTick } from '../core/risk/stop';
import { Strategy } from '../strategies/types';
import { CONFIG } from '../infra/config';

export class StrategyRunner {
  constructor(
    private deps: { exchange: Exchange; logger: Logger; state: StateStore; strategy: Strategy },
  ) {}

  async tick(symbol: string) {
    const { exchange, logger, state, strategy } = this.deps;

    const stBefore = state.get();
    logger.debug('state_snapshot', { mode: stBefore.mode, lastSide: stBefore.lastSide });

    const sig = await strategy.evaluate({
      symbol,
      exchange,
      config: CONFIG,
      state: stBefore,
      now: Date.now(),
    });

    logger.info('signal', sig);

    if (sig.action === 'EXIT') {
      const pos = await exchange.readActivePosition(symbol, stBefore.lastSide ?? 'LONG');
      if (pos) {
        logger.info('exit_request', { side: stBefore.lastSide, qtyAbs: pos.qtyAbs });
        await exchange.closeSideMarketSafe(symbol, stBefore.lastSide!, pos.qtyAbs, pos.sideMode);
        state.set({ mode: 'IDLE', lastExitReason: sig.reason ?? 'exit_by_strategy' });
        logger.info('exit_done', { reason: sig.reason });
      }
      return;
    }

    if (sig.action === 'IDLE') {
      logger.debug('idle_noop');
      return;
    }

    // --- Entradas
    const side: Side = sig.action === 'ENTER_LONG' ? 'LONG' : 'SHORT';

    await exchange.setLeverage(symbol, CONFIG.LEVERAGE);
    const price = await exchange.getMarkPrice(symbol);
    const filters = await exchange.getSymbolFilters(symbol, CONFIG.LEVERAGE);

    logger.debug('filters', filters);

    const usdt = await exchange.getUSDTBalance();
    const sized = sizeByBudget({
      usdtBalance: usdt,
      reserve: CONFIG.MIN_WALLET_RESERVE_USDT,
      capitalPct: CONFIG.CAPITAL_USAGE_PCT,
      price,
      leverage: CONFIG.LEVERAGE,
      feePct: CONFIG.FEE_BUFFER_PCT,
      filters,
    });

    if ((sized as any).qty === 0) {
      logger.warn('sizing_rejected', sized);
      return;
    }
    const qty = (sized as any).qty as number;
    logger.info('sizing_ok', { side, qty, price, usdt });

    // Abrir mercado
    const tOpen = Date.now();
    const { avgPrice: rawAvg } = await exchange.marketOpen(symbol, side, qty);
    const avgPrice = rawAvg || price;
    logger.info('market_opened', { side, qty, price, avgPrice, ms: Date.now() - tOpen });

    // Stop / TP
    const ticks = CONFIG.SL_TICKS_ABOVE_LIQ_MAP[symbol] ?? CONFIG.SL_TICKS_ABOVE_LIQ_DEFAULT;
    const liq = (await exchange.readLiquidationPrice(symbol, side)) ?? price;
    const stop = computeStopFromLiqTicks({
      side,
      liqPrice: liq,
      currentPrice: price,
      entryPrice: avgPrice,
      tickSize: filters.tickSize,
      pricePrecision: filters.pricePrecision,
      ticksAboveLiq: ticks,
    });
    await exchange.placeStopClose(symbol, side, stop);
    logger.info('stop_upserted', { side, stop, liq, ticks });

    const r = CONFIG.TP_ROE;
    const fee = CONFIG.FEE_BUFFER_PCT;
    const tpRaw =
      side === 'LONG'
        ? avgPrice * (1 + r / CONFIG.LEVERAGE + fee)
        : avgPrice * (1 - r / CONFIG.LEVERAGE - fee);
    const tp = roundToTick(tpRaw, filters.tickSize, filters.pricePrecision);
    await exchange.placeTpClose(symbol, side, tp);
    logger.info('tp_upserted', { side, tp, roe: r });

    state.set({
      mode: side === 'LONG' ? 'LONG_RIDE' : 'SHORT_RIDE',
      lastSide: side,
      lastEntryPrice: avgPrice,
      lastLeverage: CONFIG.LEVERAGE,
      lastEntryAt: Date.now(),
      peakRoe: 0,
      bracketsArmedAt: Date.now(), // si usas el guard de brackets
      lastEntryQty: qty, // ⟵ base para piramidación
      pyramidUnits: 0, // ⟵ resetea contador
      lastPyramidPrice: avgPrice, // ⟵ primer “base”
      lastTrailStop: undefined, // ⟵ aún no hay trailing
    });

    logger.info('state_entered', { mode: side === 'LONG' ? 'LONG_RIDE' : 'SHORT_RIDE' });
  }
}
