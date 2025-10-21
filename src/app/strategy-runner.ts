// src/app/strategy-runner.ts
import { Exchange } from '../core/ports/Exchange';
import { Logger } from '../core/ports/Logger';
import { StateStore } from '../core/ports/StateStore';
import { Side } from '../core/types';
import { sizeByBudget, floorToStep, ceilToStep } from '../core/risk/sizing';
import { computeStopFromLiqTicks, roundToTick } from '../core/risk/stop';
import { Strategy } from '../strategies/types';
import { atr } from '../core/indicators/atr';
import { recordSignal } from '../core/analytics/signal_recorder';
import type { CONFIG as RuntimeConfig } from '../infra/config';

type BotConfig = typeof RuntimeConfig;

export class StrategyRunner {
  constructor(
    private deps: {
      exchange: Exchange;
      logger: Logger;
      state: StateStore;
      strategy: Strategy;
      config: BotConfig;
    },
  ) {}

  async tick(symbol: string) {
    const { exchange, logger, state, strategy, config } = this.deps;
    const capitalShare = Number((config as any).SYMBOL_SHARE ?? 1);

    const stBefore = state.get();
    const hasActivePosition = stBefore.mode !== 'IDLE';
    const lastSide = stBefore.lastSide ?? 'LONG';
    let cachedMarkPrice: number | undefined;
    const markPrice = async () => {
      if (cachedMarkPrice === undefined) {
        cachedMarkPrice = await exchange.getMarkPrice(symbol);
      }
      return cachedMarkPrice;
    };
    let activePosition = null as Awaited<ReturnType<typeof exchange.readActivePosition>> | null;
    if (hasActivePosition) {
      try {
        activePosition = await exchange.readActivePosition(symbol, lastSide);
      } catch (err) {
        logger.warn('read_position_fail', { symbol, err: (err as any)?.message || String(err) });
      }
    }

    logger.debug('state_snapshot', {
      symbol,
      mode: stBefore.mode,
      lastSide: stBefore.lastSide,
      share: capitalShare,
    });

    const sig = await strategy.evaluate({
      symbol,
      exchange,
      config,
      state: stBefore,
      now: Date.now(),
      logger,
    });

    logger.info('signal', { symbol, ...sig });

    if (hasActivePosition) {
      const entry = stBefore.lastEntryPrice ?? activePosition?.entryPrice ?? 0;
      const mark = await markPrice().catch(() => undefined);
      const pnlPct =
        mark !== undefined && entry > 0
          ? lastSide === 'LONG'
            ? (mark - entry) / entry
            : (entry - mark) / entry
          : undefined;
      const roePct = pnlPct !== undefined ? Number((pnlPct * 100).toFixed(2)) : undefined;
      const roeColor = roePct !== undefined ? (roePct >= 0 ? 'green' : 'red') : undefined;
      logger.info('position_snapshot', {
        symbol,
        side: lastSide,
        entry,
        mark,
        leverage: activePosition?.leverage ?? stBefore.lastLeverage,
        qtyAbs: activePosition?.qtyAbs ?? stBefore.lastEntryQty,
        roePct,
        roeColor,
        openMs: stBefore.lastEntryAt ? Date.now() - stBefore.lastEntryAt : undefined,
      });

      if (sig.action === 'ENTER_LONG' || sig.action === 'ENTER_SHORT') {
        logger.debug('entry_blocked_existing_position', {
          symbol,
          requested: sig.action,
          reason: 'existing_position',
        });
        return;
      }
    }

    if (sig.action === 'EXIT') {
      const pos =
        activePosition ?? (await exchange.readActivePosition(symbol, stBefore.lastSide ?? 'LONG'));
      if (pos) {
        logger.info('exit_request', { symbol, side: stBefore.lastSide, qtyAbs: pos.qtyAbs });
        await exchange.closeSideMarketSafe(symbol, stBefore.lastSide!, pos.qtyAbs, pos.sideMode);
        state.set({ mode: 'IDLE', lastExitReason: sig.reason ?? 'exit_by_strategy' });
        const mark = await markPrice().catch(() => undefined);
        const wallet = await exchange.getUSDTBalance().catch(() => undefined);
        const entry = stBefore.lastEntryPrice ?? pos.entryPrice;
        const pnlPct =
          mark !== undefined && entry > 0
            ? stBefore.lastSide === 'LONG'
              ? (mark - entry) / entry
              : (entry - mark) / entry
            : undefined;
        logger.info('position_closed', {
          symbol,
          side: stBefore.lastSide,
          reason: sig.reason,
          wallet,
          closeMark: mark,
          roePct: pnlPct !== undefined ? Number((pnlPct * 100).toFixed(2)) : undefined,
          roeColor: pnlPct !== undefined ? (pnlPct >= 0 ? 'green' : 'red') : undefined,
        });
      }
      return;
    }

    if (sig.action === 'IDLE') {
      logger.debug('idle_noop', { symbol });
      return;
    }

    // --- Entradas ---
    const side: Side = sig.action === 'ENTER_LONG' ? 'LONG' : 'SHORT';

    await exchange.setLeverage(symbol, config.LEVERAGE);
    const price = await markPrice();
    const filters = await exchange.getSymbolFilters(symbol, config.LEVERAGE);

    logger.debug('filters', { symbol, ...filters });

    const usdt = await exchange.getUSDTBalance();

    // ------ Kill-switch diario (no abrir si el DD del día supera el máximo) ------
    const ddMax = Number((config as any).DAILY_DD_MAX_PCT ?? 0);
    if (ddMax > 0) {
      const sod = Number(process.env.BAL_SOD ?? usdt); // start-of-day simple
      process.env.BAL_SOD = String(sod);
      const dd = (sod - usdt) / Math.max(1e-9, sod);
      if (dd >= ddMax) {
        logger.warn('daily_kill_switch', { symbol, dd, sod, bal: usdt });
        return; // bloquea nuevas entradas
      }
    }

    // ------ Sizing base por presupuesto ------
    const capitalPct = Number((config as any).CAPITAL_USAGE_PCT ?? config.CAPITAL_USAGE_PCT);
    const sized = sizeByBudget({
      usdtBalance: usdt,
      reserve: config.MIN_WALLET_RESERVE_USDT,
      capitalPct,
      price,
      leverage: config.LEVERAGE,
      feePct: config.FEE_BUFFER_PCT,
      filters,
    });

    if ((sized as any).qty === 0) {
      logger.warn('sizing_rejected', { symbol, ...sized });
      return;
    }
    let qty = (sized as any).qty as number;

    // ------ Overlay de riesgo: limita qty por un stop provisional (ATR Chandelier base) ------
    const maxRiskPct = Number((config as any).MAX_RISK_PCT ?? 0);
    if (maxRiskPct > 0) {
      const candles = await exchange.getCandles(symbol, config.ENTRY_TIMEFRAME, 200);
      const a = atr(candles, (config as any).ATR_LEN ?? 14);
      if (Number.isFinite(a) && a > 0) {
        const baseMult = Number(
          (config as any).TRAIL_ATR_MULT_BASE ?? (config as any).TRAIL_ATR_MULT ?? 2.5,
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
            logger.warn('sizing_rejected_by_risk', { symbol, stopDist, riskUSDT });
            return;
          }
          if (qty > qtyByRisk) {
            logger.info('sizing_capped_by_risk', {
              symbol,
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
        symbol,
        qty,
        minQtyByNotional,
        price,
        notional: Number((qty * price).toFixed(filters.pricePrecision)),
        minNotional: filters.minNotional,
      });
      return; // aborta para evitar el error de Binance
    }

    logger.info('sizing_ok', { symbol, side, qty, price, usdt, share: capitalShare });

    recordSignal({
      ts: Date.now(),
      symbol,
      action: sig.action,
      reason: sig.reason,
      price,
      extras: {
        share: capitalShare,
        strategy: sig.reason?.split(':')[0] ?? strategy.name,
      },
    });

    // ------ Abrir mercado ------
    const tOpen = Date.now();
    const { avgPrice: rawAvg } = await exchange.marketOpen(symbol, side, qty);
    const avgPrice = rawAvg || price;
    logger.info('market_opened', { symbol, side, qty, price, avgPrice, ms: Date.now() - tOpen });

    // ------ Stop / TP de bracket inicial (igual que antes) ------
    const ticks = config.SL_TICKS_ABOVE_LIQ_MAP[symbol] ?? config.SL_TICKS_ABOVE_LIQ_DEFAULT;
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
    logger.info('stop_upserted', { symbol, side, stop, liq, ticks });

    const r = config.TP_ROE;
    const fee = config.FEE_BUFFER_PCT;
    const tpRaw =
      side === 'LONG'
        ? avgPrice * (1 + r / config.LEVERAGE + fee)
        : avgPrice * (1 - r / config.LEVERAGE - fee);
    const tp = roundToTick(tpRaw, filters.tickSize, filters.pricePrecision);
    await exchange.placeTpClose(symbol, side, tp);
    logger.info('tp_upserted', { symbol, side, tp, roe: r });

    state.set({
      mode: side === 'LONG' ? 'LONG_RIDE' : 'SHORT_RIDE',
      lastSide: side,
      lastEntryPrice: avgPrice,
      lastLeverage: config.LEVERAGE,
      lastEntryAt: Date.now(),
      peakRoe: 0,
      bracketsArmedAt: Date.now(),
      lastEntryQty: qty,
      pyramidUnits: 0,
      lastPyramidPrice: avgPrice,
      lastTrailStop: undefined,
    });

    logger.info('state_entered', {
      symbol,
      mode: side === 'LONG' ? 'LONG_RIDE' : 'SHORT_RIDE',
    });
  }
}
