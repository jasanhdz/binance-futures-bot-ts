// src/app/strategy-runner.ts
import { Exchange } from '../core/ports/Exchange';
import { Logger } from '../core/ports/Logger';
import { StateStore } from '../core/ports/StateStore';
import { BotState, Side } from '../core/types';
import { sizeByBudget, floorToStep, ceilToStep } from '../core/risk/sizing';
import { getNinjaConfig } from './core/NinjaConfigManager';
import { RegimeDetector, MarketSnapshot } from './core/RegimeDetector';
import { RegimeType, RegimeContext, RegimeConfig, IRegimeStrategy, ExitContext } from './regimes/RegimeStrategy';
import { BloodbathStrategy } from './regimes/BloodbathStrategy';
import { WhaleStrategy } from './regimes/WhaleStrategy';
import { MonkStrategy } from './regimes/MonkStrategy';
import { BunkerStrategy } from './regimes/BunkerStrategy';
import { computeStopFromLiqTicks, roundToTick } from '../core/risk/stop';
import { Strategy } from '../strategies/types';
import { atr } from '../core/indicators/atr';
import { recordSignal } from '../core/analytics/signal_recorder';
import { recordTradeOpen } from '../core/analytics/trade_book';
import { finalizeTrade, ensureOpenTradeBackfill } from './trade-book-hooks';
import { extractFilters, splitStrategyReason } from './trade-book-utils';
import { postExitClearPatch, postExitSetupPatch } from './trade-state';
import { isSymbolBlocked } from './symbol-penalty';

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
  ) { }

  // ═══════════════════════════════════════════════════════════════════════════
  // NINJA SYSTEM v3.0: REGIME-BASED STRATEGY SELECTION
  // ═══════════════════════════════════════════════════════════════════════════
  private regimeDetector = new RegimeDetector();

  // The 4 Armies (Strategy Pattern)
  private regimeStrategies: Record<RegimeType, IRegimeStrategy> = {
    BLOODBATH: new BloodbathStrategy(),
    WHALE: new WhaleStrategy(),
    MONK: new MonkStrategy(),
    BUNKER: new BunkerStrategy()
  };

  private lastLoggedSignals: Record<string, { action: string, reason: string, time: number }> = {};

  private buildProbCondition(
    side: Side,
    longProb?: number,
    shortProb?: number,
    threshold?: number,
  ): { text: string; isAbove?: boolean } | undefined {
    const lp = typeof longProb === 'number' && Number.isFinite(longProb) ? longProb : undefined;
    const sp = typeof shortProb === 'number' && Number.isFinite(shortProb) ? shortProb : undefined;
    const th = typeof threshold === 'number' && Number.isFinite(threshold) ? threshold : undefined;

    if (lp === undefined && sp === undefined && th === undefined) return undefined;

    const fmt = (v?: number) => (v === undefined ? '—' : v.toFixed(2));
    const base = `(L=${fmt(lp)} | S=${fmt(sp)})`;

    if (th === undefined) return { text: base };

    const sideProb = side === 'LONG' ? lp : sp;
    const bestProb = Math.max(lp ?? Number.NEGATIVE_INFINITY, sp ?? Number.NEGATIVE_INFINITY);
    const refProb = sideProb ?? (bestProb > Number.NEGATIVE_INFINITY ? bestProb : undefined);

    if (refProb === undefined) {
      return { text: `${base} t=${th.toFixed(2)}` };
    }

    const isAbove = refProb > th;
    const comparator = isAbove ? '>' : '<';
    return { text: `${base} ${comparator} t=${th.toFixed(2)}`, isAbove };
  }

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

    // ⚡ OPTIMIZACIÓN NINJA: Paralelización de I/O ⚡
    // Lanzamos todas las peticiones de red simultáneamente
    const [markPriceVal, usdtBalance, activePosData] = await Promise.all([
      exchange.getMarkPrice(symbol).catch((e: any) => {
        logger.warn('mark_price_fail', { symbol, error: e?.message || String(e) });
        return undefined;
      }),
      exchange.getUSDTBalance().catch((e: any) => {
        logger.warn('balance_fail', { symbol, error: e?.message || String(e) });
        return undefined;
      }),
      hasActivePosition
        ? exchange.readActivePosition(symbol, lastSide).catch(() => null)
        : Promise.resolve(null)
    ]);

    // Asignación de valores cacheados para el resto de la función
    let cachedMarkPrice = markPriceVal;
    const markPrice = async () => cachedMarkPrice ?? 0;

    let cachedWalletBalance = usdtBalance;
    const readWalletBalance = async () => cachedWalletBalance;

    let activePosition = activePosData;

    const walletThreshold = Number((config as any).LOW_FUNDS_WALLET_THRESHOLD ?? 0);
    if (!hasActivePosition && walletThreshold > 0) {
      const wallet = await readWalletBalance();
      if (wallet !== undefined && wallet < walletThreshold) {
        if (!snapshot.lowFundsActive) {
          applyStatePatch({ lowFundsActive: true });
        }
        logger.debug('low_funds_skip', {
          symbol,
          wallet,
          threshold: walletThreshold,
        });
        return;
      }
      if (snapshot.lowFundsActive) {
        applyStatePatch({ lowFundsActive: undefined });
      }
    } else if (snapshot.lowFundsActive) {
      applyStatePatch({ lowFundsActive: undefined });
    }

    if (!hasActivePosition && isSymbolBlocked(symbol)) {
      logger.debug('symbol_blocked_skip', { symbol });
      return;
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

    // Solo loggear señales de entrada si NO hay posición activa
    // Para evitar logs repetidos cuando ya estamos en posición
    const shouldLogSignal =
      sig.action === 'IDLE' ||
      sig.action === 'EXIT' ||
      !hasActivePosition;

    if (shouldLogSignal) {
      const lastLogged = this.lastLoggedSignals[symbol];
      const isEnter = sig.action.startsWith('ENTER');
      const isIdle = sig.action === 'IDLE';

      let skipLog = false;
      if (lastLogged && lastLogged.action === sig.action && lastLogged.reason === sig.reason) {
        // Si es ENTER, no repetir si es idéntico (evita spam si no entra por fondos/riesgo)
        if (isEnter) skipLog = true;
        // Si es IDLE, no repetir muy seguido (ej. 5 min)
        if (isIdle && Date.now() - lastLogged.time < 300000) skipLog = true;
      }

      if (!skipLog) {
        logger.info('signal', { symbol, ...sig });
        this.lastLoggedSignals[symbol] = { action: sig.action, reason: sig.reason || '', time: Date.now() };
      }
    }

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

    // ═══════════════════════════════════════════════════════════════════════════
    // NINJA v3.0: REGIME DETECTION (The Brain)
    // ═══════════════════════════════════════════════════════════════════════════
    const marketSnapshot: MarketSnapshot = {
      spreadPct: (diagnostics as any)?.spread ?? 0.0004,
      obi: (diagnostics as any)?.obi_20 ?? 0,
      fundingRate: 0, // TODO: Add funding rate fetch if available
      longProb: (diagnostics as any)?.longProb ?? 0.33,
      shortProb: (diagnostics as any)?.shortProb ?? 0.33,
      neutralProb: (diagnostics as any)?.neutralProb ?? 0.34
    };

    const regimeContext = this.regimeDetector.analyze(marketSnapshot);
    const activeRegimeStrategy = this.regimeStrategies[regimeContext.type];
    const regimeConfig = activeRegimeStrategy.getConfig(symbol);

    // ════════════════════════════════════════════════════════════════════
    // 🧠 SMART COOLDOWN LOGIC (NINJA v6.2)
    // ════════════════════════════════════════════════════════════════════
    // Objetivo: Ser rápido en tendencias, paciente en rangos.

    if (stBefore.lastExitAt && !hasActivePosition) {
      const timeSinceExit = Date.now() - stBefore.lastExitAt;

      // REGLA MONK: Paciencia forzada
      // Si el mercado está lateral, prohibido re-entrar rápido.
      if (regimeContext.type === 'MONK') {
        const MONK_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutos
        if (timeSinceExit < MONK_COOLDOWN_MS) {
          logger.debug('monk_cooldown_wait', {
            symbol,
            regime: 'MONK',
            remaining: ((MONK_COOLDOWN_MS - timeSinceExit) / 1000).toFixed(0) + 's'
          });
          return; // 🛑 FRENO ACTIVADO
        }
      }

      // REGLA WHALE/BLOODBATH: Sin límite artificial
      // Confiamos en el PostExitGate para validar la estructura del precio.
    }

    // Log regime status periodically (every 12 ticks ~ 1 minute at 5s interval)
    if (!this.lastLoggedSignals[`${symbol}_regime`] ||
      Date.now() - this.lastLoggedSignals[`${symbol}_regime`].time > 60000) {
      logger.info('ninja_regime_status', {
        symbol,
        regime: regimeContext.type,
        confidence: regimeContext.confidence,
        bias: regimeContext.bias,
        volatility: regimeContext.volatility,
        trigger: regimeContext.trigger,
        leverage: regimeConfig.leverage,
        hardStop: (regimeConfig.hardStopRoe * 100).toFixed(1) + '%'
      });
      this.lastLoggedSignals[`${symbol}_regime`] = { action: regimeContext.type, reason: regimeContext.trigger, time: Date.now() };
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

      // ═════════════════════════════════════════════════════════════════════════
      // FIX v5.0: UNIFICACIÓN DE PROBABILIDADES (Single Source of Truth)
      // Usamos 0.33 como fallback seguro (neutralidad) si ML falla
      // ═════════════════════════════════════════════════════════════════════════
      const longProb = typeof (diagnostics as any)?.longProb === 'number'
        ? (diagnostics as any).longProb
        : 0.33;
      const shortProb = typeof (diagnostics as any)?.shortProb === 'number'
        ? (diagnostics as any).shortProb
        : 0.33;
      const neutralProb = typeof (diagnostics as any)?.neutralProb === 'number'
        ? (diagnostics as any).neutralProb
        : (1 - longProb - shortProb);
      const probThreshold = typeof (diagnostics as any)?.threshold === 'number'
        ? (diagnostics as any).threshold
        : undefined;

      const probCond = this.buildProbCondition(lastSide, longProb, shortProb, probThreshold);
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
        probCond: probCond?.text,
        probAbove: probCond?.isAbove,
        longProb,
        shortProb,
        probThreshold,
      });




      // --- NINJA EXIT PROTOCOL v5.0 (Regime-Based) ---
      // All exit logic now handled by each RegimeStrategy.evaluateExit()
      if (roiPct !== undefined) {
        // 1. Actualizar Peak ROE (Siempre necesario para trailing)
        const currentPeak = stBefore.peakRoe ?? 0;
        if (roiPct > currentPeak) {
          applyStatePatch({ peakRoe: roiPct });
        }
        const peak = Math.max(currentPeak, roiPct);

        // ═════════════════════════════════════════════════════════════════════════
        // NINJA v5.0: DELEGACIÓN TOTAL AL RÉGIMEN
        // ═════════════════════════════════════════════════════════════════════════
        const currentRoeDec = roiPct / 100.0;
        const peakRoeDec = peak / 100.0;
        const holdTimeMs = stBefore.lastEntryAt ? Date.now() - stBefore.lastEntryAt : 0;

        const currentSpread = (diagnostics as any)?.spread ?? 0.0004;
        const avgSpread = getNinjaConfig().regimeDetector.volatility_spread_low;

        // Build ExitContext v5.1 (with marketBias and positionSide for Guardian)
        // Deduce marketBias from probabilities
        let marketBias: 'BULL' | 'BEAR' | 'NEUTRAL' = 'NEUTRAL';
        if (longProb > 0.50) marketBias = 'BULL';
        else if (shortProb > 0.50) marketBias = 'BEAR';

        const exitContext: ExitContext = {
          currentRoe: currentRoeDec,
          peakRoe: peakRoeDec,
          holdTimeMs,
          opposingProb: lastSide === 'LONG' ? shortProb : longProb,
          neutralProb,
          volatilityFactor: Math.max(0.5, Math.min(3.0, currentSpread / avgSpread)),
          marketBias,
          positionSide: lastSide as 'LONG' | 'SHORT'
        };

        // CONSULTAR AL ESTRATEGA DEL RÉGIMEN ACTIVO
        const regimeExitReason = activeRegimeStrategy.evaluateExit(exitContext, symbol);

        if (regimeExitReason) {
          logger.info('regime_exit_v5', {
            symbol,
            regime: regimeContext.type,
            reason: regimeExitReason,
            roi: roiPct.toFixed(2),
            peak: peak.toFixed(2),
            opposing: exitContext.opposingProb.toFixed(2),
            neutral: exitContext.neutralProb.toFixed(2)
          });

          await exchange.closeSideMarketSafe(symbol, lastSide, qtyAbs, activePosition?.sideMode || 'BOTH');
          applyStatePatch({
            mode: 'IDLE',
            lastExitReason: regimeExitReason,
            lastExitAt: Date.now(),
            panicCounter: 0,
            peakRoe: 0
          });

          this.regimeDetector.reset();
          return;
        }
        // ═══════════════════════════════════════════════════════════════════════════
        // NINJA v5.0: LEGACY CAPAS REMOVED
        // All exit logic is now handled by RegimeStrategy.evaluateExit()
        // - CAPA 0 (Hard Stop) → WHALE_HARD_STOP, BLOODBATH_HARD_STOP, etc.
        // - CAPA 0.5 (Moonbag) → WHALE_MOONBAG_SECURE
        // - CAPA 1 (Panic) → WHALE_PANIC_EXTREME, BLOODBATH_PANIC_FAST, etc.
        // - CAPA 2 (Trailing) → WHALE_LOGARITHMIC_TRAIL
        // - CAPA 3 (Neutrality) → BLOODBATH_NEUTRAL_EXIT, MONK_NEUTRAL_EXIT, etc.
        // ═══════════════════════════════════════════════════════════════════════════
      }

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

    // ------ BTC Trend Filter (Protección Macro) ------
    // Si no somos BTC, consultamos a BTC para ver la tendencia
    if (symbol !== 'BTCUSDT') {
      try {
        // Asumimos que el servicio ML V2 corre en local puerto 8001.
        // Nota: Esto añade latencia (~10-20ms), pero vale la pena por seguridad.
        const btcRes = await fetch('http://localhost:8001/ml-v2/predict', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol: 'BTCUSDT' }),
        });
        if (btcRes.ok) {
          const btcData = await btcRes.json();
          // btcData tiene { long_prob, short_prob, ... }
          const btcLong = btcData.long_prob || 0;
          const btcShort = btcData.short_prob || 0;

          // Regla 1: No abrir SHORT si BTC es muy Alcista
          if (side === 'SHORT') {
            // Si BTC Long > 0.55 (fuerte) o BTC Long es el doble que Short
            if (btcLong > 0.55 || (btcLong > btcShort * 2 && btcLong > 0.40)) {
              logger.info('entry_blocked_btc_trend', {
                symbol,
                side,
                reason: 'BTC_BULLISH',
                btcLong,
                btcShort
              });
              return;
            }
          }

          // Regla 2: No abrir LONG si BTC es muy Bajista
          if (side === 'LONG') {
            if (btcShort > 0.55 || (btcShort > btcLong * 2 && btcShort > 0.40)) {
              logger.info('entry_blocked_btc_trend', {
                symbol,
                side,
                reason: 'BTC_BEARISH',
                btcLong,
                btcShort
              });
              return;
            }
          }
        }
      } catch (err) {
        // Si falla la consulta a BTC, no bloqueamos, pero logueamos warning
        logger.warn('btc_trend_check_fail', { error: String(err) });
      }
    }



    try {
      await exchange.ensureMarginType(symbol, 'ISOLATED');
    } catch (err: any) {
      logger.warn('margin_type_set_fail', { symbol, err: err?.message || String(err) });
      return;
    }

    const tf = (config as any).SYMBOL_TIMEFRAMES?.[symbol] || (config as any).ENTRY_TIMEFRAME || '1h';
    // NINJA v3.0: Use ACTIVE REGIME leverage instead of hardcoded WHALE
    const mlLeverage = regimeConfig.leverage;

    // CRITICAL: If regime leverage is 0, this regime BLOCKS ENTRIES (e.g., BUNKER)
    if (mlLeverage === 0) {
      logger.info('regime_entry_blocked', {
        symbol,
        regime: regimeContext.type,
        reason: 'regime_leverage_zero',
        message: 'Regime does not allow new entries'
      });
      return;
    }

    const leverage = mlLeverage;

    logger.info('regime_entry_leverage', { symbol, regime: regimeContext.type, leverage });
    await exchange.setLeverage(symbol, leverage);
    const price = await markPrice();

    // ------ Cooldown de Seguridad (Evitar re-entradas inmediatas en la misma dirección) ------
    // Especialmente crítico después de un Smart Exit o Stop Loss
    const COOLDOWN_MS = 15 * 60 * 1000; // 15 minutos
    if (
      stBefore.lastExitAt &&
      Date.now() - stBefore.lastExitAt < COOLDOWN_MS &&
      stBefore.lastSide === side // Solo bloquear si es la misma dirección
    ) {
      logger.info('entry_blocked_cooldown', {
        symbol,
        side,
        remainingSeconds: ((COOLDOWN_MS - (Date.now() - stBefore.lastExitAt)) / 1000).toFixed(0),
        lastExitReason: stBefore.lastExitReason
      });
      return;
    }

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

    const filters = await exchange.getSymbolFilters(symbol, leverage);

    logger.debug('filters', { symbol, ...filters });

    let usdt = await readWalletBalance();
    if (usdt === undefined) {
      try {
        usdt = await exchange.getUSDTBalance();
        cachedWalletBalance = usdt;
      } catch (err: any) {
        logger.warn('wallet_read_fail', { symbol, err: err?.message || String(err) });
        return;
      }
    }
    if (usdt === undefined) {
      return;
    }

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
      leverage: leverage,
      feePct: config.FEE_BUFFER_PCT,
      filters,
    });

    if ('reason' in sizing) {
      logger.warn('sizing_rejected', { symbol, ...sizing });
      // Emit detalle explícito si el sizing trae datos de depuración (p.ej. caps vs minNotional)
      if ((sizing as any).debug) {
        logger.warn('sizing_rejected_detail', { symbol, reason: sizing.reason, ...(sizing as any).debug });
      }
      return;
    }
    let qty = sizing.qty;
    const sizingDiagnostics = sizing.diagnostics;
    let usedBalance =
      sizingDiagnostics && typeof sizingDiagnostics['initMargin'] === 'number'
        ? (sizingDiagnostics['initMargin'] as number)
        : (qty * price) / Math.max(1, leverage);
    let sizingFees =
      sizingDiagnostics && typeof sizingDiagnostics['fees'] === 'number'
        ? (sizingDiagnostics['fees'] as number)
        : qty * price * config.FEE_BUFFER_PCT;
    let commissionEstimate = sizingFees * 2;

    // ------ Overlay de riesgo: limita qty por un stop provisional (ATR Chandelier base) ------
    const maxRiskPct = Number((config as any).MAX_RISK_PCT ?? 0);
    if (maxRiskPct > 0) {
      const tf = (config as any).SYMBOL_TIMEFRAMES?.[symbol] || (config as any).ENTRY_TIMEFRAME || '1h';
      const candles = await exchange.getCandles(symbol, tf, 200);
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

        const atrDist =
          side === 'LONG' ? Math.max(0, price - planStop) : Math.max(0, planStop - price);

        // Distancia basada en RÉGIMEN (Hard Stop del YAML)
        const regimeHardStopRoe = Math.abs(regimeConfig.hardStopRoe);
        const regimeDist = price * regimeHardStopRoe;

        // USAR EL STOP MÁS CERCANO para el cálculo de Size
        const stopDist = Math.min(atrDist, regimeDist);

        logger.debug('sizing_stop_comparison', {
          symbol,
          atrDist: atrDist.toFixed(4),
          regimeDist: regimeDist.toFixed(4),
          chosenDist: stopDist.toFixed(4),
          reason: stopDist === atrDist ? 'ATR_Tighter' : 'REGIME_Tighter'
        });

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

    usedBalance = (qty * price) / Math.max(1, leverage);
    sizingFees = qty * price * config.FEE_BUFFER_PCT;
    commissionEstimate = sizingFees * 2;

    logger.info('sizing_ok', {
      symbol,
      side,
      qty,
      price,
      usdt,
      share: capitalShare,
      capitalPct,
      reserve: config.MIN_WALLET_RESERVE_USDT,
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
    let rawAvg = 0;
    let orderId: string | undefined;
    try {
      const res = await exchange.marketOpen(symbol, side, qty);
      rawAvg = res.avgPrice;
      orderId = res.orderId;
    } catch (err: any) {
      const notional = Number(
        (qty * price).toFixed(
          typeof filters.pricePrecision === 'number' ? filters.pricePrecision : 8,
        ),
      );
      logger.warn('market_open_fail', {
        symbol,
        side,
        qty,
        price,
        notional,
        minNotional: filters.minNotional,
        code: (err as any)?.code,
        err: err?.message || String(err),
      });
      return;
    }
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

    // ════════════════════════════════════════════════════════════════════════
    // 🛡️ NATIVE BRACKETS SYNC (NINJA v6.3) - FIX CRÍTICO
    // ════════════════════════════════════════════════════════════════════════
    // Objetivo: Que el SL en Binance coincida EXACTAMENTE con el Hard Stop del Régimen.
    // Si el bot muere, la protección nativa es la correcta.

    const entryPrice = avgPrice;
    const regimeHardStopRoe = regimeConfig.hardStopRoe; // Ej: -0.05 (-5%)

    // Cálculo de Distancia de Precio basada en el % de Movimiento del Activo
    // ROE = %Movimiento * Leverage  =>  %Movimiento = ROE / Leverage
    const priceMovePct = Math.abs(regimeHardStopRoe) / leverage;
    const slDist = entryPrice * priceMovePct;

    let stopRaw = side === 'LONG' ? entryPrice - slDist : entryPrice + slDist;

    // Safety: No poner SL más allá de liquidación (Binance rechazaría la orden)
    const liq = (await exchange.readLiquidationPrice(symbol, side)) ?? (side === 'LONG' ? 0 : Infinity);
    if (side === 'LONG') {
      // Stop debe ser MAYOR que Liq. Dejamos 0.5% buffer.
      stopRaw = Math.max(stopRaw, liq * 1.005);
    } else {
      // Stop debe ser MENOR que Liq.
      stopRaw = Math.min(stopRaw, liq * 0.995);
    }

    const stop = roundToTick(stopRaw, filters.tickSize, filters.pricePrecision);
    try {
      await exchange.placeStopClose(symbol, side, stop);
      logger.info('stop_upserted_regime', {
        symbol,
        side,
        stop,
        regime: regimeContext.type,
        targetRoe: (regimeHardStopRoe * 100).toFixed(1) + '%',
        priceMovePct: (priceMovePct * 100).toFixed(2) + '%'
      });
    } catch (err: any) {
      logger.warn('stop_upsert_init_fail', { symbol, side, stop, err: err?.message || String(err) });
      // bracketsGuard will retry on next tick
    }

    // 3. Definir Take Profit dinámico basado en confianza del modelo ML
    let rrRatio = 1.5; // Base conservador
    let mlProb = 0;
    let mlThreshold = 0.35; // Default

    // Extraer probabilidad del modelo si está disponible
    if (diagnostics) {
      if (side === 'LONG' && typeof diagnostics.longProb === 'number') {
        mlProb = diagnostics.longProb;
      } else if (side === 'SHORT' && typeof diagnostics.shortProb === 'number') {
        mlProb = diagnostics.shortProb;
      }
      if (typeof diagnostics.threshold === 'number') {
        mlThreshold = diagnostics.threshold;
      }
    }

    // Calcular R:R dinámico basado en confianza
    if (mlProb > 0) {
      const confidence = Math.max(0, mlProb - mlThreshold); // 0-0.65 típico

      // ═════════════════════════════════════════════════════════════
      // CALIBRACIÓN MOONBAG: Aumentar R:R para objetivos de 12-15%
      // ═════════════════════════════════════════════════════════════
      // 1. Base RR: Subir de 1.5 a 4.0
      let baseRR = 4.0;

      // 2. Bonus RR: Subir multiplicador de 5 a 10
      let bonusRR = confidence * 10;

      rrRatio = baseRR + bonusRR;
      logger.info('tp_ml_calculation', {
        symbol,
        mlProb,
        mlThreshold,
        confidence,
        baseRR: baseRR.toFixed(2),
        bonusRR: bonusRR.toFixed(2),
        finalRR: rrRatio.toFixed(2)
      });
    }

    const tpDist = slDist * rrRatio;
    const tpRaw = side === 'LONG' ? avgPrice + tpDist : avgPrice - tpDist;
    const tp = roundToTick(tpRaw, filters.tickSize, filters.pricePrecision);

    try {
      await exchange.placeTpClose(symbol, side, tp);
      logger.info('tp_upserted_rr', { symbol, side, tp, rr: rrRatio.toFixed(2) });
    } catch (err: any) {
      logger.warn('tp_upsert_init_fail', { symbol, side, tp, err: err?.message || String(err) });
      // bracketsGuard will retry on next tick
    }

    applyStatePatch({
      mode: side === 'LONG' ? 'LONG_RIDE' : 'SHORT_RIDE',
      lastSide: side,
      lastEntryPrice: avgPrice,
      lastLeverage: config.LEVERAGE,
      lastEntryAt: Date.now(),
      lastEntryTime: Date.now(), // Ninja Protocol v2.0: Para Time Decay
      peakRoe: 0,
      panicCounter: 0, // Ninja Protocol v2.0: Reset contador de pánico
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
      lastMlProb: mlProb > 0 ? mlProb : undefined, // Guardar para bracketsGuard
      lastMlThreshold: mlProb > 0 ? mlThreshold : undefined,
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
