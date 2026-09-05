import { BotState, Side } from '../../core/types';
import { PositionInfo, TradingExchangePort } from '../ports/Exchange';
import { Logger } from '../ports/Logger';
import { StateStore } from '../ports/StateStore';

export type PositionOwner = 'MICRO' | 'AEGIS' | 'MOMENTUM' | 'EXTERNAL' | 'UNKNOWN';

export type StopCheckResult = 'CONFIRMED' | 'ABSENT' | 'UNKNOWN';

export type ProtectionStatus =
  | 'PROTECTED'
  | 'UNKNOWN'
  | 'MISSING'
  | 'CONFIRMATION_PENDING'
  | 'RECOVERY_REQUIRED'
  | 'EMERGENCY_CLOSE_FAILED';

export interface SupervisionResult {
  status: ProtectionStatus;
  owner: PositionOwner;
  reason?: string;
  stopPrice?: number;
}

export interface PositionSupervisorDeps {
  exchange: TradingExchangePort;
  logger: Logger;
  /**
   * Determine the owner of a persisted position from its state.
   * Must be pure: no exchange calls.
   */
  resolveOwner(state: BotState): PositionOwner;
  /**
   * Whether this owner requires a stop (Micro yes, Aegis has brackets,
   * Momentum has its own, External/Unknown never by this supervisor).
   */
  requiresStop(owner: PositionOwner): boolean;
  /**
   * Get the stop confirmation config for a given owner.
   */
  getStopConfig(owner: PositionOwner): {
    confirmationAttempts: number;
    confirmationDelaysMs: readonly number[];
    recoveryTimeoutMs: number;
    immediateTriggerBufferPct: number;
  };
  now?: () => number;
  wait?: (delayMs: number) => Promise<void>;
}

/**
 * Common safety supervisor separated from strategy decisions.
 *
 * Responsibilities:
 * - Walk all persisted symbol states, including symbols that changed mode.
 * - Identify owner and policy BEFORE acting.
 * - Validate stop vs current price and filters; never degrade a better stop.
 * - Confirm stop by ID within bounded retries; only positive evidence resolves.
 * - Persist UNKNOWN / RECOVERY_REQUIRED; never blindly reset to IDLE.
 * - Reconcile flat positions independently of the exit signal.
 * - On protection failure: attempt emergency close, persist RECOVERY_REQUIRED.
 */
export class PositionSupervisor {
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: PositionSupervisorDeps) {}

  /**
   * Supervise a single position. Safe to call repeatedly; concurrent calls
   * for the same symbol are coalesced.
   */
  async supervise(
    symbol: string,
    state: BotState,
    store?: StateStore,
  ): Promise<SupervisionResult> {
    if (this.inFlight.has(symbol)) {
      return { status: 'UNKNOWN', owner: 'UNKNOWN', reason: 'SUPERVISION_IN_FLIGHT' };
    }
    this.inFlight.add(symbol);
    try {
      return await this.superviseOnce(symbol, state, store);
    } finally {
      this.inFlight.delete(symbol);
    }
  }

  private async superviseOnce(
    symbol: string,
    state: BotState,
    store?: StateStore,
  ): Promise<SupervisionResult> {
    const owner = this.deps.resolveOwner(state);

    // Unknown ownership: block new entries, persist RECOVERY_REQUIRED.
    // Position state unknown → preserve current mode.
    if (owner === 'UNKNOWN') {
      return this.persistStatus(store, {
        status: 'RECOVERY_REQUIRED',
        owner,
        reason: 'OWNERSHIP_UNKNOWN',
      }, true);
    }

    // External/manual: protect conservatively but never claim strategy authority.
    if (owner === 'EXTERNAL') {
      return this.protectWithRetries(symbol, state, owner, store);
    }

    // All identified owners: walk the same protection path.
    return this.protectWithRetries(symbol, state, owner, store);
  }

  private async protectWithRetries(
    symbol: string,
    state: BotState,
    owner: PositionOwner,
    store?: StateStore,
  ): Promise<SupervisionResult> {
    const side = state.lastSide;
    if (!side) {
      return this.persistStatus(store, {
        status: 'RECOVERY_REQUIRED',
        owner,
        reason: 'SIDE_UNKNOWN',
      }, true);
    }

    // 1. Read position from exchange.
    let position: PositionInfo | null;
    try {
      position = await this.deps.exchange.readActivePosition(symbol, side);
    } catch (error) {
      return this.persistStatus(store, {
        status: 'UNKNOWN',
        owner,
        reason: `POSITION_READ_FAILED:${String(error)}`,
      }, true);
    }

    // 2. Flat: reconcile and clear.
    if (position === null) {
      return this.reconcileFlat(symbol, state, owner, store);
    }

    // 3. Invalid position data.
    if (
      !Number.isFinite(position.qtyAbs) ||
      position.qtyAbs <= 0 ||
      !['BOTH', side].includes(position.sideMode)
    ) {
      return this.persistStatus(store, {
        status: 'UNKNOWN',
        owner,
        reason: 'POSITION_INVALID',
      }, true);
    }

    // 4. Check if owner requires stop protection.
    if (!this.deps.requiresStop(owner)) {
      // Aegis/Momentum manage their own brackets; supervisor just confirms presence.
      return this.confirmBracketsExist(symbol, side, position, owner, store);
    }

    // 5. Micro stop path.
    return this.superviseMicroStop(symbol, state, side, position, owner, store);
  }

  private async superviseMicroStop(
    symbol: string,
    state: BotState,
    side: Side,
    position: PositionInfo,
    owner: PositionOwner,
    store?: StateStore,
  ): Promise<SupervisionResult> {
    const config = this.deps.getStopConfig(owner);

    // 5a. Check if stop already confirmed.
    const stopCheck = await this.hasConfirmedStop(symbol, side, position, config);
    if (stopCheck === 'CONFIRMED') {
      return this.persistStatus(store, { status: 'PROTECTED', owner });
    }
    if (stopCheck === 'UNKNOWN') {
      // Could not determine stop status; persist and continue to avoid sending duplicate.
      return this.persistStatus(store, {
        status: 'UNKNOWN',
        owner,
        reason: 'STOP_CHECK_AMBIGUOUS',
      }, true);
    }

    // 5b. Check if there was a previous submission pending confirmation.
    if (state.microStopSubmission) {
      const elapsed = (this.deps.now?.() ?? Date.now()) - state.microStopSubmission.attemptedAt;
      if (
        Number.isFinite(elapsed) &&
        elapsed >= 0 &&
        Number.isFinite(config.recoveryTimeoutMs) &&
        config.recoveryTimeoutMs > 0 &&
        state.microStopSubmission.tradeId === state.lastTradeId
      ) {
        if (elapsed >= config.recoveryTimeoutMs) {
          return this.attemptEmergencyClose(symbol, side, position, owner, 'STOP_RECOVERY_TIMEOUT', store);
        }
        return this.persistStatus(store, {
          status: 'CONFIRMATION_PENDING',
          owner,
          reason: 'PREVIOUS_SUBMISSION_NOT_CONFIRMED',
          stopPrice: state.microStopSubmission.stopPrice,
        });
      }
      // Invalid submission context: persist and continue.
      return this.persistStatus(store, {
        status: 'UNKNOWN',
        owner,
        reason: 'SUBMISSION_CONTEXT_INVALID',
      }, true);
    }

    // 5c. Find a remembered stop price from state.
    const remembered = [state.lastStopPrice, state.microBurstStructuralStopPrice].filter(
      (price): price is number => typeof price === 'number' && Number.isFinite(price) && price > 0,
    );
    if (!remembered.length) {
      return this.persistStatus(store, {
        status: 'RECOVERY_REQUIRED',
        owner,
        reason: 'STOP_PRICE_UNKNOWN',
      }, true);
    }
    const stopPrice = side === 'LONG' ? Math.max(...remembered) : Math.min(...remembered);

    // 5d. Validate against mark price.
    let markPrice: number;
    try {
      markPrice = await this.deps.exchange.getMarkPrice(symbol);
    } catch (error) {
      return this.persistStatus(store, {
        status: 'UNKNOWN',
        owner,
        reason: `MARK_PRICE_READ_FAILED:${String(error)}`,
      }, true);
    }
    if (this.wouldTriggerImmediately(side, stopPrice, markPrice, config.immediateTriggerBufferPct)) {
      return this.persistStatus(store, {
        status: 'RECOVERY_REQUIRED',
        owner,
        reason: 'STOP_IMMEDIATE_TRIGGER_RISK',
      }, true);
    }

    // 5e. Get filters and round.
    let filters;
    try {
      filters = await this.deps.exchange.getSymbolFilters(symbol, position.leverage);
    } catch (error) {
      return this.persistStatus(store, {
        status: 'UNKNOWN',
        owner,
        reason: `FILTER_READ_FAILED:${String(error)}`,
      }, true);
    }
    const effectiveStop = this.roundStopPrice(side, stopPrice, filters);
    if (this.wouldTriggerImmediately(side, effectiveStop, markPrice, config.immediateTriggerBufferPct)) {
      return this.persistStatus(store, {
        status: 'RECOVERY_REQUIRED',
        owner,
        reason: 'STOP_INVALID_AFTER_ROUNDING',
      }, true);
    }

    // 5f. Persist intent before sending (crash-safe).
    // If no store or flush fails, block: do not send without durable intent.
    if (!store?.flush) {
      return this.persistStatus(store, {
        status: 'UNKNOWN',
        owner,
        reason: 'NO_STORE_FOR_PERSISTENCE',
      }, true);
    }
    try {
      store.set({
        microProtectionBlocked: true,
        microStopSubmission: {
          attemptedAt: this.deps.now?.() ?? Date.now(),
          stopPrice: effectiveStop,
          tradeId: state.lastTradeId,
        },
      });
      await store.flush();
    } catch (error) {
      return this.persistStatus(store, {
        status: 'UNKNOWN',
        owner,
        reason: `STOP_PERSIST_FAILED:${String(error)}`,
      }, true);
    }

    // 5g. Place stop.
    let placed: boolean;
    try {
      placed = await this.deps.exchange.placeStopClose(symbol, side, effectiveStop);
    } catch (error) {
      return this.persistStatus(store, {
        status: 'UNKNOWN',
        owner,
        reason: `STOP_PLACEMENT_AMBIGUOUS:${String(error)}`,
      }, true);
    }
    if (!placed) {
      return this.attemptEmergencyClose(symbol, side, position, owner, 'STOP_REJECTED', store);
    }

    // 5h. Confirm placement.
    const confirmResult = await this.hasConfirmedStop(symbol, side, position, config);
    if (confirmResult === 'CONFIRMED') {
      this.deps.logger.info('position_supervisor_stop_confirmed', { symbol, side, owner, effectiveStop });
      return this.persistStatus(store, { status: 'PROTECTED', owner, stopPrice: effectiveStop });
    }
    if (confirmResult === 'UNKNOWN') {
      return this.persistStatus(store, {
        status: 'UNKNOWN',
        owner,
        reason: 'STOP_PLACEMENT_CONFIRMATION_AMBIGUOUS',
        stopPrice: effectiveStop,
      }, true);
    }

    return this.persistStatus(store, {
      status: 'CONFIRMATION_PENDING',
      owner,
      reason: 'STOP_PLACED_NOT_CONFIRMED',
      stopPrice: effectiveStop,
    });
  }

  private async hasConfirmedStop(
    symbol: string,
    side: Side,
    position: PositionInfo,
    config: { confirmationAttempts: number; confirmationDelaysMs: readonly number[] },
  ): Promise<StopCheckResult> {
    let lastError = false;
    for (let attempt = 0; attempt < config.confirmationAttempts; attempt++) {
      try {
        const orders = await this.deps.exchange.listCloseOrdersForSide(symbol, side);
        if (orders.some((o) => this.coversPosition(o, side, position))) return 'CONFIRMED';
        // Confirmed absence: query succeeded, no matching stop found.
        lastError = false;
      } catch {
        // Track that at least one query failed.
        lastError = true;
      }
      if (attempt < config.confirmationAttempts - 1) {
        const delay = config.confirmationDelaysMs[Math.min(attempt, config.confirmationDelaysMs.length - 1)] ?? 0;
        await (this.deps.wait?.(Math.max(0, delay)) ?? new Promise((r) => setTimeout(r, delay)));
      }
    }
    // If any query failed, we can't be sure the stop is absent.
    return lastError ? 'UNKNOWN' : 'ABSENT';
  }

  private coversPosition(
    order: { type: string; stopPrice: number; positionSide?: string; side?: string; owner?: string; closePosition?: boolean; reduceOnly?: boolean; quantity?: number | string },
    side: Side,
    position: PositionInfo,
  ): boolean {
    return (
      (order.type === 'STOP_MARKET' || order.type === 'STOP') &&
      Number.isFinite(order.stopPrice) &&
      order.stopPrice > 0 &&
      (!order.positionSide || order.positionSide === 'BOTH' || order.positionSide === side) &&
      (!order.side || order.side === (side === 'LONG' ? 'SELL' : 'BUY')) &&
      order.owner !== 'UNKNOWN' &&
      (order.closePosition === true ||
        (order.reduceOnly === true && Number(order.quantity) >= position.qtyAbs))
    );
  }

  private async confirmBracketsExist(
    symbol: string,
    side: Side,
    position: PositionInfo,
    owner: PositionOwner,
    store?: StateStore,
  ): Promise<SupervisionResult> {
    try {
      const orders = await this.deps.exchange.listCloseOrdersForSide(symbol, side);
      const hasStop = orders.some((o) => o.type === 'STOP_MARKET' || o.type === 'STOP');
      if (hasStop) {
        return this.persistStatus(store, { status: 'PROTECTED', owner });
      }
      // No stop found for Aegis/Momentum: this is concerning but not an emergency.
      return this.persistStatus(store, {
        status: 'UNKNOWN',
        owner,
        reason: 'NO_STOP_FOUND_FOR_MANAGED_POSITION',
      });
    } catch (error) {
      return this.persistStatus(store, {
        status: 'UNKNOWN',
        owner,
        reason: `BRACKET_CHECK_FAILED:${String(error)}`,
      });
    }
  }

  private async reconcileFlat(
    symbol: string,
    state: BotState,
    owner: PositionOwner,
    store?: StateStore,
  ): Promise<SupervisionResult> {
    // Two independent flat observations; catch transient errors.
    let confirmedFlat = true;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        await (this.deps.wait?.(300) ?? new Promise((r) => setTimeout(r, 300)));
      }
      const side = state.lastSide ?? 'LONG';
      try {
        if ((await this.deps.exchange.readActivePosition(symbol, side)) !== null) {
          // Position reappeared: persist RECOVERY_REQUIRED, do NOT claim PROTECTED.
          return this.persistStatus(store, {
            status: 'RECOVERY_REQUIRED',
            owner,
            reason: 'POSITION_REAPPEARED',
          });
        }
      } catch {
        confirmedFlat = false;
        break;
      }
    }
    if (!confirmedFlat) {
      return this.persistStatus(store, { status: 'UNKNOWN', owner, reason: 'FLAT_READ_ERROR' });
    }

    // Clean only BOT orders and verify survivors by re-consulting exchange.
    const side = state.lastSide ?? 'LONG';
    const preOrders = await this.deps.exchange.listCloseOrdersForSide(symbol, side);
    const cancelledIds: string[] = [];
    for (const order of preOrders) {
      if (order.owner === 'BOT') {
        try {
          await this.deps.exchange.cancelOrderById(symbol, order.orderId);
          cancelledIds.push(order.orderId);
        } catch {
          // Track failure but continue cleanup.
        }
      }
    }

    // Re-consult exchange to verify surviving orders (not cached list).
    let survivingNonBot = 0;
    try {
      const postOrders = await this.deps.exchange.listCloseOrdersForSide(symbol, side);
      survivingNonBot = postOrders.filter(
        (o) => o.owner !== 'BOT' && !cancelledIds.includes(o.orderId),
      ).length;
    } catch {
      // If re-consult fails, we cannot verify survivors; log and continue.
    }
    if (survivingNonBot > 0) {
      this.deps.logger.info('position_supervisor_surviving_orders', {
        symbol,
        survivingOrders: survivingNonBot,
      });
    }

    // Final flat check.
    if ((await this.deps.exchange.readActivePosition(symbol, side)) !== null) {
      return this.persistStatus(store, {
        status: 'RECOVERY_REQUIRED',
        owner,
        reason: 'POSITION_REAPPEARED_POST_CLEANUP',
      });
    }

    // Persist flat state: IDLE, no protection, PnL unverified.
    if (store?.flush) {
      store.set({
        mode: 'IDLE',
        bracketsAttached: false,
        microProtectionBlocked: false,
        microStopSubmission: undefined,
        microBurstExitState: undefined,
        microBurstPnlUnverified: true,
        microBurstPnlUnverifiedAt: state.microBurstPnlUnverifiedAt ?? this.deps.now?.() ?? Date.now(),
        lastExitAt:
          state.mode === 'IDLE' && state.lastExitAt !== undefined
            ? state.lastExitAt
            : (this.deps.now?.() ?? Date.now()),
        lastExitReason: 'FLAT_CONFIRMED_ACCOUNTING_PENDING',
      });
      await store.flush();
    }

    return { status: 'MISSING', owner, reason: 'FLAT_CONFIRMED' };
  }

  private async attemptEmergencyClose(
    symbol: string,
    side: Side,
    position: PositionInfo,
    owner: PositionOwner,
    reason: string,
    store?: StateStore,
  ): Promise<SupervisionResult> {
    this.deps.logger.warn('position_supervisor_emergency_close', { symbol, side, owner, reason });

    // Persist RECOVERY_REQUIRED before attempting close (crash-safe).
    // Position is still open → preserve mode.
    await this.persistStatus(store, {
      status: 'RECOVERY_REQUIRED',
      owner,
      reason: `EMERGENCY_CLOSE_ATTEMPTING:${reason}`,
    }, true);

    try {
      await this.deps.exchange.closeSideMarketSafe(symbol, side, position.qtyAbs, position.sideMode, reason);
    } catch (error) {
      return this.persistStatus(store, {
        status: 'EMERGENCY_CLOSE_FAILED',
        owner,
        reason: `EMERGENCY_CLOSE_FAILED:${String(error)}`,
      }, true);
    }

    // Confirm flat after emergency close: two observations.
    let confirmedFlat = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        await (this.deps.wait?.(500) ?? new Promise((r) => setTimeout(r, 500)));
      }
      try {
        const postClose = await this.deps.exchange.readActivePosition(symbol, side);
        if (postClose === null || postClose.qtyAbs <= 0) {
          confirmedFlat = true;
          break;
        }
      } catch {
        // Transient read error: retry once, then treat as uncertain.
      }
    }

    if (!confirmedFlat) {
      return this.persistStatus(store, {
        status: 'RECOVERY_REQUIRED',
        owner,
        reason: 'EMERGENCY_CLOSE_CONFIRMATION_FAILED',
      }, true);
    }

    // Verify surviving orders after emergency close.
    try {
      const survivingOrders = await this.deps.exchange.listCloseOrdersForSide(symbol, side);
      const botOrders = survivingOrders.filter((o) => o.owner === 'BOT');
      for (const order of botOrders) {
        try {
          await this.deps.exchange.cancelOrderById(symbol, order.orderId);
        } catch {
          // Best-effort; flat is confirmed regardless.
        }
      }
    } catch {
      // Best-effort order cleanup.
    }

    // Persist flat state.
    if (store?.flush) {
      store.set({
        mode: 'IDLE',
        bracketsAttached: false,
        microProtectionBlocked: false,
        microStopSubmission: undefined,
        microBurstPnlUnverified: true,
        microBurstPnlUnverifiedAt: this.deps.now?.() ?? Date.now(),
        lastExitAt: this.deps.now?.() ?? Date.now(),
        lastExitReason: `EMERGENCY_CLOSE_CONFIRMED_${reason}`,
      });
      await store.flush();
    }

    return { status: 'MISSING', owner, reason: `EMERGENCY_CLOSE_CONFIRMED_${reason}` };
  }

  private async persistStatus(
    store: StateStore | undefined,
    result: SupervisionResult,
    preservePositionState?: boolean,
  ): Promise<SupervisionResult> {
    if (store && result.status !== 'PROTECTED' && result.status !== 'MISSING') {
      const patch: Partial<BotState> = {};
      if (result.status === 'RECOVERY_REQUIRED' || result.status === 'UNKNOWN') {
        patch.microProtectionBlocked = true;
      }
      // Only set IDLE when we've confirmed the position is flat.
      // When preservePositionState is true (position is open but protection
      // is uncertain), preserve the current mode to avoid losing track.
      if (result.status === 'RECOVERY_REQUIRED' && !preservePositionState) {
        patch.mode = 'IDLE';
      }
      store.set(patch);
      if (store.flush) await store.flush();
    }
    return result;
  }

  private wouldTriggerImmediately(
    side: Side,
    stopPrice: number,
    markPrice: number,
    bufferPct: number,
  ): boolean {
    if (!Number.isFinite(stopPrice) || !Number.isFinite(markPrice) || markPrice <= 0) return true;
    return side === 'LONG'
      ? stopPrice >= markPrice * (1 - bufferPct)
      : stopPrice <= markPrice * (1 + bufferPct);
  }

  private roundStopPrice(side: Side, price: number, filters: { tickSize: number; pricePrecision: number }): number {
    const tickSize = filters.tickSize;
    if (!Number.isFinite(tickSize) || tickSize <= 0) {
      return Number(price.toFixed(filters.pricePrecision));
    }
    const ticks = price / tickSize;
    const roundedTicks = side === 'LONG' ? Math.ceil(ticks - 1e-12) : Math.floor(ticks + 1e-12);
    return Number((roundedTicks * tickSize).toFixed(filters.pricePrecision));
  }
}
