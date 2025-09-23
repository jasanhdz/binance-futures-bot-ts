// src/app/strategy-runner.ts
import { Exchange } from '../core/ports/Exchange';
import { Logger } from '../core/ports/Logger';
import { StateStore } from '../core/ports/StateStore';
import { Side } from '../core/types';
import { sizeByBudget, floorToStep, ceilToStep } from '../core/risk/sizing';
import { computeStopFromLiqTicks, roundToTick } from '../core/risk/stop';
import { Strategy } from '../strategies/types';
import { CONFIG } from '../infra/config';
import { atr } from '../core/indicators/atr';

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
      logger,
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

    // --- Entradas ---
    const side: Side = sig.action === 'ENTER_LONG' ? 'LONG' : 'SHORT';

    await exchange.setLeverage(symbol, CONFIG.LEVERAGE);
    const price = await exchange.getMarkPrice(symbol);
    const filters = await exchange.getSymbolFilters(symbol, CONFIG.LEVERAGE);

    logger.debug('filters', filters);

    const usdt = await exchange.getUSDTBalance();

    // ------ Kill-switch diario (no abrir si el DD del día supera el máximo) ------
    const ddMax = Number((CONFIG as any).DAILY_DD_MAX_PCT ?? 0);
    if (ddMax > 0) {
      const sod = Number(process.env.BAL_SOD ?? usdt); // start-of-day simple
      process.env.BAL_SOD = String(sod);
      const dd = (sod - usdt) / Math.max(1e-9, sod);
      if (dd >= ddMax) {
        logger.warn('daily_kill_switch', { dd, sod, bal: usdt });
        return; // bloquea nuevas entradas
      }
    }

    // ------ Sizing base por presupuesto ------
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
    let qty = (sized as any).qty as number;

    // ------ Overlay de riesgo: limita qty por un stop provisional (ATR Chandelier base) ------
    const maxRiskPct = Number((CONFIG as any).MAX_RISK_PCT ?? 0);
    if (maxRiskPct > 0) {
      const candles = await exchange.getCandles(symbol, CONFIG.ENTRY_TIMEFRAME, 200);
      const a = atr(candles, (CONFIG as any).ATR_LEN ?? 14);
      if (Number.isFinite(a) && a > 0) {
        const baseMult = Number(
          (CONFIG as any).TRAIL_ATR_MULT_BASE ?? (CONFIG as any).TRAIL_ATR_MULT ?? 2.5,
        );
        let planStop = side === 'LONG' ? price - baseMult * a : price + baseMult * a;
        // respeta un tick “del lado correcto”
        const oneTick = filters.tickSize;
        if (side === 'LONG') planStop = Math.min(planStop, price - oneTick);
        else planStop = Math.max(planStop, price + oneTick);
        planStop = roundToTick(planStop, filters.tickSize, filters.pricePrecision);

        const stopDist =
          side === 'LONG' ? Math.max(0, price - planStop) : Math.max(0, planStop - price);
        if (stopDist > 0) {
          const riskUSDT = usdt * maxRiskPct;
          const qtyByRisk = floorToStep(
            riskUSDT / stopDist,
            filters.stepSize,
            filters.qtyPrecision,
          );
          if (qtyByRisk <= 0) {
            logger.warn('sizing_rejected_by_risk', { stopDist, riskUSDT });
            return;
          }
          if (qty > qtyByRisk) {
            logger.info('sizing_capped_by_risk', {
              from: qty,
              to: qtyByRisk,
              stopDist,
              riskPct: maxRiskPct,
            });
            qty = qtyByRisk;
          }
        }
      }
    }

    // ✅ Re-validación de mínimo nocional tras el cap de riesgo
    const minQtyByNotional = ceilToStep(
      filters.minNotional / price,
      filters.stepSize,
      filters.qtyPrecision,
    );
    if (qty < minQtyByNotional) {
      logger.warn('min_notional_not_met_after_risk', {
        qty,
        minQtyByNotional,
        price,
        notional: Number((qty * price).toFixed(filters.pricePrecision)),
        minNotional: filters.minNotional,
      });
      return; // aborta para evitar el error de Binance
    }

    logger.info('sizing_ok', { side, qty, price, usdt });

    // ------ Abrir mercado ------
    const tOpen = Date.now();
    const { avgPrice: rawAvg } = await exchange.marketOpen(symbol, side, qty);
    const avgPrice = rawAvg || price;
    logger.info('market_opened', { side, qty, price, avgPrice, ms: Date.now() - tOpen });

    // ------ Stop / TP de bracket inicial (igual que antes) ------
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
      bracketsArmedAt: Date.now(),
      lastEntryQty: qty,
      pyramidUnits: 0,
      lastPyramidPrice: avgPrice,
      lastTrailStop: undefined,
    });

    logger.info('state_entered', { mode: side === 'LONG' ? 'LONG_RIDE' : 'SHORT_RIDE' });
  }
}
