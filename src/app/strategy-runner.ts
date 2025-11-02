// src/app/strategy-runner.ts
import { Exchange } from '../core/ports/Exchange';
import { Logger } from '../core/ports/Logger';
import { StateStore } from '../core/ports/StateStore';
import { BotState, Side } from '../core/types';
import { sizeByBudget, floorToStep, ceilToStep } from '../core/risk/sizing';
import { computeStopFromLiqTicks, roundToTick } from '../core/risk/stop';
import { Strategy } from '../strategies/types';
import { atr } from '../core/indicators/atr';
import { recordSignal } from '../core/analytics/signal_recorder';
import { recordTradeOpen } from '../core/analytics/trade_book';
import { finalizeTrade, ensureOpenTradeBackfill } from './trade-book-hooks';
import { extractFilters, splitStrategyReason } from './trade-book-utils';
import { postExitClearPatch, postExitSetupPatch } from './trade-state';
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

    await ensureOpenTradeBackfill({ symbol, exchange, state, logger });

    const stBefore = state.get();
    let snapshot: BotState = { ...stBefore };
    const applyStatePatch = (patch: Partial<BotState>) => {
      if (!patch) return;
      const entries = Object.entries(patch);
      if (!entries.length) return;
      const changed = entries.some(([key, value]) => (snapshot as any)[key] !== value);
      if (!changed) return;
      state.set(patch);
      snapshot = { ...snapshot, ...patch };
    };
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
    
    const { strategy: primaryStrategy, detail: reasonDetail } = splitStrategyReason(
      sig.reason,
      strategy.name,
    );
    const parsedReasonFilters = extractFilters(reasonDetail);
    const diagnostics =
      sig.diagnostics && typeof sig.diagnostics === 'object' ? sig.diagnostics : undefined;
    const filtersAtEntry: Record<string, unknown> = {};
    if (Object.keys(parsedReasonFilters).length) {
      filtersAtEntry.reason = parsedReasonFilters;
    }
    if (diagnostics && Object.keys(diagnostics).length) {
      filtersAtEntry.diagnostics = diagnostics;
    }

    if (hasActivePosition) {
      const entry = stBefore.lastEntryPrice ?? activePosition?.entryPrice ?? 0;
      const mark = await markPrice().catch(() => undefined);
      const qtyAbs = activePosition?.qtyAbs ?? stBefore.lastEntryQty ?? 0;
      const leverageUsed = activePosition?.leverage ?? stBefore.lastLeverage ?? config.LEVERAGE;
      const direction = lastSide === 'LONG' ? 1 : -1;
      const computedPnl =
        mark !== undefined && entry > 0 && qtyAbs
          ? (mark - entry) * qtyAbs * direction
          : undefined;
      const pnlUsdRaw =
        activePosition?.unrealizedPnl !== undefined
          ? activePosition.unrealizedPnl
          : computedPnl;
      const notional = mark !== undefined ? mark * qtyAbs : undefined;
      const margin =
        notional !== undefined && leverageUsed
          ? notional / Math.max(1, leverageUsed)
          : undefined;
      const roiPct =
        pnlUsdRaw !== undefined && margin
          ? Number(((pnlUsdRaw / Math.max(1e-9, margin)) * 100).toFixed(2))
          : undefined;
      const pnlUsd =
        pnlUsdRaw !== undefined ? Number(pnlUsdRaw.toFixed(6)) : undefined;
      const roiColor = roiPct !== undefined ? (roiPct >= 0 ? 'green' : 'red') : undefined;
      logger.info('position_snapshot', {
        symbol,
        side: lastSide,
        entry,
        mark,
        leverage: activePosition?.leverage ?? stBefore.lastLeverage,
        qtyAbs: activePosition?.qtyAbs ?? stBefore.lastEntryQty,
        roiPct,
        roiColor,
        pnlUsd,
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
        const mark = await markPrice().catch(() => undefined);
        let wallet: number | undefined;
        try {
          wallet = await exchange.getUSDTBalance();
        } catch (err: any) {
          logger.warn('wallet_read_fail', { symbol, err: err?.message || String(err) });
        }
        const entry = stBefore.lastEntryPrice ?? pos.entryPrice;
        const qtyAbs = activePosition?.qtyAbs ?? pos.qtyAbs ?? stBefore.lastEntryQty ?? 0;
        const leverageUsed = activePosition?.leverage ?? pos.leverage ?? stBefore.lastLeverage ?? config.LEVERAGE;
        const direction = stBefore.lastSide === 'LONG' ? 1 : -1;
        const computedPnl =
          mark !== undefined && entry > 0 && qtyAbs
            ? (mark - entry) * qtyAbs * direction
            : undefined;
        const pnlUsdRaw =
          activePosition?.unrealizedPnl !== undefined
            ? activePosition.unrealizedPnl
            : computedPnl;
        const notional = mark !== undefined ? mark * qtyAbs : undefined;
        const margin =
          notional !== undefined && leverageUsed
            ? notional / Math.max(1, leverageUsed)
            : undefined;
        const roiPct =
          pnlUsdRaw !== undefined && margin
            ? Number(((pnlUsdRaw / Math.max(1e-9, margin)) * 100).toFixed(2))
            : undefined;
        const pnlUsd = pnlUsdRaw !== undefined ? Number(pnlUsdRaw.toFixed(6)) : undefined;
        const roiColor = roiPct !== undefined ? (roiPct >= 0 ? 'green' : 'red') : undefined;
        const exitReason = sig.reason ?? 'exit_by_strategy';
        const resetPatch = await finalizeTrade({
          symbol,
          exchange,
          state,
          logger,
          reason: exitReason,
          exitPrice: mark,
          walletAfter: wallet,
        });
        const exitAt = Date.now();
        const effectiveExitPrice =
          mark !== undefined && Number.isFinite(mark)
            ? mark
            : entry ?? stBefore.lastEntryPrice ?? undefined;
        const exitSide =
          stBefore.lastSide ??
          (pos.sideMode === 'LONG'
            ? ('LONG' as Side)
            : pos.sideMode === 'SHORT'
              ? ('SHORT' as Side)
              : undefined);
        const postExitPatch = postExitSetupPatch({
          side: exitSide,
          exitPrice: effectiveExitPrice,
          exitAt,
        });
        applyStatePatch({
          mode: 'IDLE',
          lastExitReason: exitReason,
          lastExitAt: exitAt,
          peakRoe: 0,
          ...resetPatch,
          ...postExitPatch,
        });
        logger.info('position_closed', {
          symbol,
          side: stBefore.lastSide,
          reason: sig.reason,
          wallet,
          closeMark: mark,
          roiPct,
          roiColor,
          pnlUsd,
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

    try {
      await exchange.ensureMarginType(symbol, 'ISOLATED');
    } catch (err: any) {
      logger.warn('margin_type_set_fail', { symbol, err: err?.message || String(err) });
      return;
    }

    await exchange.setLeverage(symbol, config.LEVERAGE);
    const price = await markPrice();

    const gateResult = await this.evaluatePostExitGate({
      symbol,
      side,
      mark: price,
      state: snapshot,
      config,
      exchange,
      logger,
    });

    if (gateResult.patch) {
      applyStatePatch(gateResult.patch);
    }

    if (!gateResult.allow) {
      logger.debug('entry_blocked_post_exit', {
        symbol,
        side,
        reason: gateResult.reason ?? 'post_exit_active',
      });
      return;
    }

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
    const sizing = sizeByBudget({
      usdtBalance: usdt,
      reserve: config.MIN_WALLET_RESERVE_USDT,
      capitalPct,
      price,
      leverage: config.LEVERAGE,
      feePct: config.FEE_BUFFER_PCT,
      filters,
    });

    if ('reason' in sizing) {
      logger.warn('sizing_rejected', { symbol, ...sizing });
      return;
    }
    let qty = sizing.qty;
    const sizingDiagnostics = sizing.diagnostics;
    let usedBalance =
      sizingDiagnostics && typeof sizingDiagnostics['initMargin'] === 'number'
        ? (sizingDiagnostics['initMargin'] as number)
        : (qty * price) / Math.max(1, config.LEVERAGE);
    let sizingFees =
      sizingDiagnostics && typeof sizingDiagnostics['fees'] === 'number'
        ? (sizingDiagnostics['fees'] as number)
        : qty * price * config.FEE_BUFFER_PCT;
    let commissionEstimate = sizingFees * 2;

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

    usedBalance = (qty * price) / Math.max(1, config.LEVERAGE);
    sizingFees = qty * price * config.FEE_BUFFER_PCT;
    commissionEstimate = sizingFees * 2;

    logger.info('sizing_ok', {
      symbol,
      side,
      qty,
      price,
      usdt,
      share: capitalShare,
      usedBalance,
      commissionEstimate,
    });

    recordSignal({
      ts: Date.now(),
      symbol,
      action: sig.action,
      reason: sig.reason,
      price,
      extras: {
        share: capitalShare,
        strategy: primaryStrategy,
        reason_detail: reasonDetail,
        ...(diagnostics && Object.keys(diagnostics).length ? { diagnostics } : {}),
      },
    });

    // ------ Abrir mercado ------
    const tOpen = Date.now();
    const { avgPrice: rawAvg, orderId } = await exchange.marketOpen(symbol, side, qty);
    const avgPrice = rawAvg || price;
    logger.info('market_opened', { symbol, side, qty, price, avgPrice, ms: Date.now() - tOpen });

    let tradeId: string | undefined;
    try {
      tradeId = recordTradeOpen({
        symbol,
        strategy: primaryStrategy,
        side,
        entryTime: Date.now(),
        entryPrice: avgPrice,
        usedBalance,
        walletBefore: usdt,
        filters: filtersAtEntry,
        qty,
        orderId,
        commissionEstimate,
      });
    } catch (err: any) {
      logger.error('trade_book_open_fail', { symbol, err: err?.message || String(err) });
    }

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
      liqBufferRatio: config.STOP_LIQ_BUFFER_RATIO,
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

    applyStatePatch({
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
      lastTradeId: tradeId,
      lastStrategyName: primaryStrategy,
      lastEntryWallet: usdt,
      lastEntryUsedBalance: usedBalance,
      lastEntryFilters: filtersAtEntry,
      lastCommissionEstimate: commissionEstimate,
      lastOrderId: orderId,
      ...postExitClearPatch(),
    });

  logger.info('state_entered', {
    symbol,
    mode: side === 'LONG' ? 'LONG_RIDE' : 'SHORT_RIDE',
  });
  }

  private async evaluatePostExitGate(params: {
    symbol: string;
    side: Side;
    mark: number;
    state: BotState;
    config: BotConfig;
    exchange: Exchange;
    logger: Logger;
  }): Promise<{ allow: boolean; patch?: Partial<BotState>; reason?: string }> {
    const { symbol, side, mark, state, config, exchange, logger } = params;

    if (!(config as any).REENTER_ON_TP) {
      return { allow: true };
    }

    const {
      postExitSide,
      postExitPrice,
      postExitAt,
      postExitReady,
      postExitMin,
      postExitMax,
      postExitCondition,
    } = state;

    if (
      !postExitSide ||
      typeof postExitPrice !== 'number' ||
      !Number.isFinite(postExitPrice) ||
      typeof postExitAt !== 'number'
    ) {
      if (
        postExitSide !== undefined ||
        postExitPrice !== undefined ||
        postExitAt !== undefined ||
        postExitMin !== undefined ||
        postExitMax !== undefined ||
        postExitCondition !== undefined
      ) {
        return { allow: true, patch: postExitClearPatch() };
      }
      return { allow: true };
    }

    if (postExitSide !== side) {
      return { allow: true, patch: postExitClearPatch() };
    }

    if (postExitReady) {
      return { allow: true };
    }

    const pullbackPct = Math.max(0, Number((config as any).POST_EXIT_PULLBACK_PCT ?? 0.006));
    const reboundPct = Math.max(0, Math.min(1, Number((config as any).POST_EXIT_REBOUND_PCT ?? 0.35)));
    const breakoutPct = Math.max(0, Number((config as any).POST_EXIT_BREAKOUT_PCT ?? 0.0015));
    const breakoutVolFactor = Math.max(
      0,
      Number((config as any).POST_EXIT_BREAKOUT_VOL_FACTOR ?? config.VOL_FACTOR_REENTER ?? 1.0),
    );
    const timeoutMs = Number((config as any).POST_EXIT_TIMEOUT_MS ?? 300_000);

    let minPrice = typeof postExitMin === 'number' ? postExitMin : postExitPrice;
    let maxPrice = typeof postExitMax === 'number' ? postExitMax : postExitPrice;

    minPrice = Math.min(minPrice, mark);
    maxPrice = Math.max(maxPrice, mark);

    let recentCandles: Awaited<ReturnType<Exchange['getCandles']>> = [];
    try {
      recentCandles = await exchange.getCandles(symbol, '1m', 30);
    } catch (err: any) {
      logger.debug('post_exit_candles_fetch_fail', { symbol, err: err?.message || String(err) });
    }

    const relevantCandles =
      recentCandles.length > 0
        ? recentCandles.filter((c) => c.closeTime >= postExitAt)
        : [];
    const fallBackCandles = recentCandles.length ? [recentCandles[recentCandles.length - 1]] : [];
    const observedCandles =
      relevantCandles.length > 0 ? relevantCandles : fallBackCandles;

    for (const candle of observedCandles) {
      minPrice = Math.min(minPrice, candle.low);
      maxPrice = Math.max(maxPrice, candle.high);
    }

    const patch: Partial<BotState> = {};
    if (minPrice !== postExitMin) patch.postExitMin = minPrice;
    if (maxPrice !== postExitMax) patch.postExitMax = maxPrice;
    patch.postExitReady = false;

    const now = Date.now();
    if (timeoutMs > 0 && now - postExitAt >= timeoutMs) {
      patch.postExitReady = true;
      patch.postExitCondition = 'timeout';
      return { allow: true, patch, reason: 'timeout' };
    }

    const avgVolumeWindow = recentCandles.slice(-10);
    const avgVolume =
      avgVolumeWindow.length > 0
        ? avgVolumeWindow.reduce((acc, candle) => acc + candle.volume, 0) / avgVolumeWindow.length
        : 0;
    const lastCandleVolume =
      observedCandles.length > 0 ? observedCandles[observedCandles.length - 1].volume : 0;
    const breakoutVolumeOk =
      avgVolume <= 0 ? lastCandleVolume > 0 : lastCandleVolume >= avgVolume * breakoutVolFactor;

    if (side === 'LONG') {
      const drop = postExitPrice - minPrice;
      const pullbackThreshold = pullbackPct === 0 ? 0 : postExitPrice * pullbackPct;
      const pullbackReached = drop > 0 && (pullbackThreshold === 0 ? drop > 0 : drop >= pullbackThreshold);
      const reboundTarget = drop > 0 ? minPrice + drop * reboundPct : postExitPrice;
      const reboundMet = drop > 0 ? mark >= reboundTarget : false;

      if (pullbackReached && reboundMet) {
        patch.postExitReady = true;
        patch.postExitCondition = 'pullback';
        return { allow: true, patch, reason: 'pullback' };
      }

      const breakoutTarget = postExitPrice * (1 + breakoutPct);
      if (mark >= breakoutTarget && (breakoutPct === 0 || breakoutVolumeOk)) {
        patch.postExitReady = true;
        patch.postExitCondition = 'breakout';
        return { allow: true, patch, reason: 'breakout' };
      }
    } else {
      const rise = maxPrice - postExitPrice;
      const pullbackThreshold = pullbackPct === 0 ? 0 : postExitPrice * pullbackPct;
      const pullbackReached = rise > 0 && (pullbackThreshold === 0 ? rise > 0 : rise >= pullbackThreshold);
      const reboundTarget = rise > 0 ? maxPrice - rise * reboundPct : postExitPrice;
      const reboundMet = rise > 0 ? mark <= reboundTarget : false;

      if (pullbackReached && reboundMet) {
        patch.postExitReady = true;
        patch.postExitCondition = 'pullback';
        return { allow: true, patch, reason: 'pullback' };
      }

      const breakoutTarget = postExitPrice * (1 - breakoutPct);
      if (mark <= breakoutTarget && (breakoutPct === 0 || breakoutVolumeOk)) {
        patch.postExitReady = true;
        patch.postExitCondition = 'breakout';
        return { allow: true, patch, reason: 'breakout' };
      }
    }

    return { allow: false, patch };
  }
}
