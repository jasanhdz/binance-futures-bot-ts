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
  async supervise(symbol: string, state: BotState, store?: StateStore): Promise<SupervisionResult> {
    if (this.inFlight.has(symbol)) {
      return { status: 'UNKNOWN', owner: 'UNKNOWN', reason: 'SUPERVISION_IN_FLIGHT' };
    }
    this.inFlight.add(symbol);
    try {
      return await this.superviseOnce(symbol, { ...state }, store);
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
      });
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
      });
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
      });
    }

    // 2. Flat: reconcile without discarding accounting uncertainty.
    if (position === null) {
      return this.reconcileFlat(symbol, state, owner, store);
    }

    // 3. Invalid position data.
    if (
      !position ||
      !Number.isFinite(position.qtyAbs) ||
      position.qtyAbs <= 0 ||
      !['BOTH', side].includes(position.sideMode)
    ) {
      return this.persistStatus(store, {
        status: 'UNKNOWN',
        owner,
        reason: 'POSITION_INVALID',
      });
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
      });
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
          return this.attemptEmergencyClose(
            symbol,
            state,
            side,
            position,
            owner,
            'STOP_RECOVERY_TIMEOUT',
            store,
          );
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
      });
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
      });
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
      });
    }
    if (
      this.wouldTriggerImmediately(side, stopPrice, markPrice, config.immediateTriggerBufferPct)
    ) {
      return this.persistStatus(store, {
        status: 'RECOVERY_REQUIRED',
        owner,
        reason: 'STOP_IMMEDIATE_TRIGGER_RISK',
      });
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
      });
    }
    const effectiveStop = this.roundStopPrice(side, stopPrice, filters);
    if (
      this.wouldTriggerImmediately(side, effectiveStop, markPrice, config.immediateTriggerBufferPct)
    ) {
      return this.persistStatus(store, {
        status: 'RECOVERY_REQUIRED',
        owner,
        reason: 'STOP_INVALID_AFTER_ROUNDING',
      });
    }

    // Use the same identity/persistence barrier as cancellations and emergency closes.
    const submission = {
      attemptedAt: this.deps.now?.() ?? Date.now(),
      stopPrice: effectiveStop,
      tradeId: state.lastTradeId,
    };
    const blocked = await this.persistMutationBlock(state, owner, store, submission);
    if (blocked) return blocked;
    try {
      // Recheck after the awaited barrier, immediately before invoking the exchange.
      const current = store!.get();
      if (!this.matchesPositionIdentity(state, owner, current)) {
        return this.persistStatus(store, {
          status: 'UNKNOWN',
          owner,
          reason: 'POSITION_IDENTITY_CHANGED',
        });
      }
      const persisted = current.microStopSubmission;
      if (
        !persisted ||
        persisted.tradeId !== submission.tradeId ||
        persisted.attemptedAt !== submission.attemptedAt ||
        persisted.stopPrice !== submission.stopPrice
      ) {
        return this.persistStatus(store, {
          status: 'UNKNOWN',
          owner,
          reason: 'STOP_SUBMISSION_CHANGED',
        });
      }
    } catch (error) {
      return this.persistStatus(store, {
        status: 'UNKNOWN',
        owner,
        reason: `STOP_STATE_READ_FAILED:${String(error)}`,
      });
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
      });
    }
    if (!placed) {
      return this.attemptEmergencyClose(
        symbol,
        state,
        side,
        position,
        owner,
        'STOP_REJECTED',
        store,
      );
    }

    // 5h. Confirm placement.
    const confirmResult = await this.hasConfirmedStop(symbol, side, position, config);
    if (confirmResult === 'CONFIRMED') {
      this.deps.logger.info('position_supervisor_stop_confirmed', {
        symbol,
        side,
        owner,
        effectiveStop,
      });
      return this.persistStatus(store, { status: 'PROTECTED', owner, stopPrice: effectiveStop });
    }
    if (confirmResult === 'UNKNOWN') {
      return this.persistStatus(store, {
        status: 'UNKNOWN',
        owner,
        reason: 'STOP_PLACEMENT_CONFIRMATION_AMBIGUOUS',
        stopPrice: effectiveStop,
      });
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
    // One-way uncertainty flag: once a query fails, we remain uncertain
    // unless a later query returns positive evidence of a stop.
    let uncertain = false;
    for (let attempt = 0; attempt < config.confirmationAttempts; attempt++) {
      try {
        const orders = await this.deps.exchange.listCloseOrdersForSide(symbol, side);
        if (orders.some((o) => this.coversPosition(o, side, position))) return 'CONFIRMED';
        // Successful query with no matching stop: confirmed absence ONLY if
        // no prior error left us uncertain.
      } catch {
        uncertain = true;
      }
      if (attempt < config.confirmationAttempts - 1) {
        const delay =
          config.confirmationDelaysMs[Math.min(attempt, config.confirmationDelaysMs.length - 1)] ??
          0;
        await (this.deps.wait?.(Math.max(0, delay)) ?? new Promise((r) => setTimeout(r, delay)));
      }
    }
    return uncertain ? 'UNKNOWN' : 'ABSENT';
  }

  private coversPosition(
    order: {
      type: string;
      stopPrice: number;
      positionSide?: string;
      side?: string;
      owner?: string;
      closePosition?: boolean;
      reduceOnly?: boolean;
      quantity?: number | string;
    },
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
    emergencyReason?: string,
  ): Promise<SupervisionResult> {
    const prefix = emergencyReason ? 'EMERGENCY_CLOSE_' : '';
    const persistence = await this.persistMutationBlock(state, owner, store);
    if (persistence) return persistence;
    // Two independent flat observations; catch transient errors.
    let confirmedFlat = true;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        await (this.deps.wait?.(300) ?? new Promise((r) => setTimeout(r, 300)));
      }
      const side = state.lastSide ?? 'LONG';
      try {
        const observed = await this.deps.exchange.readActivePosition(symbol, side);
        if (observed !== null) {
          if (
            !observed ||
            !Number.isFinite(observed.qtyAbs) ||
            observed.qtyAbs <= 0 ||
            !['BOTH', side].includes(observed.sideMode)
          ) {
            return this.persistStatus(store, {
              status: 'UNKNOWN',
              owner,
              reason: 'POSITION_INVALID',
            });
          }
          // Position reappeared: persist RECOVERY_REQUIRED, do NOT claim PROTECTED.
          return this.persistStatus(store, {
            status: 'RECOVERY_REQUIRED',
            owner,
            reason: emergencyReason ? 'EMERGENCY_CLOSE_POSITION_STILL_OPEN' : 'POSITION_REAPPEARED',
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
    let preOrders;
    try {
      preOrders = await this.deps.exchange.listCloseOrdersForSide(symbol, side);
    } catch (error) {
      return this.persistStatus(store, {
        status: 'UNKNOWN',
        owner,
        reason: `ORDER_LIST_FAILED:${String(error)}`,
      });
    }

    const failedCancellationIds: string[] = [];
    for (const order of preOrders) {
      if (order.owner === 'BOT') {
        const blocked = await this.persistMutationBlock(state, owner, store);
        if (blocked) return blocked;
        try {
          await this.deps.exchange.cancelOrderById(symbol, order.orderId);
        } catch {
          failedCancellationIds.push(order.orderId);
          break;
        }
      }
    }

    // Re-consult exchange to verify surviving orders (not cached list).
    let postOrders;
    try {
      postOrders = await this.deps.exchange.listCloseOrdersForSide(symbol, side);
    } catch (error) {
      // Cannot verify survivors: treat as uncertain, block flat confirmation.
      return this.persistStatus(store, {
        status: 'UNKNOWN',
        owner,
        reason: `ORDER_RECONSULT_FAILED:${String(error)}`,
      });
    }

    // Block if ANY BOT orders are visible post-consult.
    // A cancellation acknowledgment is not proof of absence; only the
    // exchange's current view of open orders is authoritative.
    const survivingBotOrders = postOrders.filter((o) => o.owner === 'BOT');
    if (survivingBotOrders.length > 0 || failedCancellationIds.length > 0) {
      return this.persistStatus(store, {
        status: failedCancellationIds.length > 0 ? 'UNKNOWN' : 'RECOVERY_REQUIRED',
        owner,
        reason: `${prefix}SURVIVING_BOT_ORDERS:${survivingBotOrders.length + failedCancellationIds.length}`,
      });
    }

    // Non-BOT surviving orders are informational only.
    const survivingNonBot = postOrders.filter((o) => o.owner !== 'BOT');
    if (survivingNonBot.length > 0) {
      this.deps.logger.info('position_supervisor_surviving_nonbot_orders', {
        symbol,
        survivingOrders: survivingNonBot.length,
      });
    }

    // Final flat check.
    let finalPosition: PositionInfo | null;
    try {
      finalPosition = await this.deps.exchange.readActivePosition(symbol, side);
    } catch (error) {
      return this.persistStatus(store, {
        status: 'UNKNOWN',
        owner,
        reason: `FINAL_CHECK_FAILED:${String(error)}`,
      });
    }
    if (finalPosition !== null) {
      if (
        !finalPosition ||
        !Number.isFinite(finalPosition.qtyAbs) ||
        finalPosition.qtyAbs <= 0 ||
        !['BOTH', side].includes(finalPosition.sideMode)
      ) {
        return this.persistStatus(store, { status: 'UNKNOWN', owner, reason: 'POSITION_INVALID' });
      }
      return this.persistStatus(store, {
        status: 'RECOVERY_REQUIRED',
        owner,
        reason: 'POSITION_REAPPEARED_POST_CLEANUP',
      });
    }

    const blocked = await this.persistMutationBlock(state, owner, store);
    if (blocked) return blocked;
    const conservative = store!.get();
    const finalPatch: Partial<BotState> = {
      mode: 'IDLE',
      bracketsAttached: false,
      microProtectionBlocked: true,
      microBurstPnlUnverified: true,
      microBurstPnlUnverifiedAt:
        conservative.microBurstPnlUnverifiedAt ?? this.deps.now?.() ?? Date.now(),
      lastExitAt:
        conservative.mode === 'IDLE' && conservative.lastExitAt !== undefined
          ? conservative.lastExitAt
          : (this.deps.now?.() ?? Date.now()),
      lastExitReason: 'FLAT_CONFIRMED_ACCOUNTING_PENDING',
    };
    const stillOwnsFinalState = (): boolean => {
      const current = store!.get();
      return (
        current.lastTradeId === conservative.lastTradeId &&
        current.lastSide === conservative.lastSide &&
        this.deps.resolveOwner(current) === owner &&
        Object.entries(finalPatch).every(([key, value]) => current[key as keyof BotState] === value)
      );
    };
    try {
      store!.set(finalPatch);
      await store!.flush!();
      if (!stillOwnsFinalState()) {
        store!.set({ microProtectionBlocked: true });
        return { status: 'UNKNOWN', owner, reason: 'FLAT_PERSIST_STATE_CHANGED' };
      }
    } catch (error) {
      // Never roll an older operation back over a state changed during flush.
      if (stillOwnsFinalState())
        store!.set({
          mode: conservative.mode,
          bracketsAttached: conservative.bracketsAttached,
          microProtectionBlocked: true,
          microBurstPnlUnverified: conservative.microBurstPnlUnverified,
          microBurstPnlUnverifiedAt: conservative.microBurstPnlUnverifiedAt,
          lastExitAt: conservative.lastExitAt,
          lastExitReason: conservative.lastExitReason,
        });
      else store!.set({ microProtectionBlocked: true });
      return { status: 'UNKNOWN', owner, reason: `FLAT_PERSIST_FAILED:${String(error)}` };
    }

    return {
      status: 'MISSING',
      owner,
      reason: emergencyReason ? `EMERGENCY_CLOSE_CONFIRMED_${emergencyReason}` : 'FLAT_CONFIRMED',
    };
  }

  private async attemptEmergencyClose(
    symbol: string,
    state: BotState,
    side: Side,
    position: PositionInfo,
    owner: PositionOwner,
    reason: string,
    store?: StateStore,
  ): Promise<SupervisionResult> {
    this.deps.logger.warn('position_supervisor_emergency_close', { symbol, side, owner, reason });

    // Block emergency close when no durable store: executing without
    // persistence means a crash could leave the position open with no
    // recovery record.
    if (!store?.flush) {
      return this.persistStatus(store, {
        status: 'UNKNOWN',
        owner,
        reason: `EMERGENCY_CLOSE_NO_STORE:${reason}`,
      });
    }

    // Persist RECOVERY_REQUIRED before attempting close (crash-safe).
    // Position is still open → preserve mode.
    const blocked = await this.persistMutationBlock(state, owner, store);
    if (blocked) return blocked;

    try {
      await this.deps.exchange.closeSideMarketSafe(
        symbol,
        side,
        position.qtyAbs,
        position.sideMode,
        reason,
      );
    } catch (error) {
      return this.persistStatus(store, {
        status: 'EMERGENCY_CLOSE_FAILED',
        owner,
        reason: `EMERGENCY_CLOSE_FAILED:${String(error)}`,
      });
    }

    return this.reconcileFlat(symbol, state, owner, store, reason);
  }

  private async persistMutationBlock(
    state: BotState,
    owner: PositionOwner,
    store?: StateStore,
    submission?: NonNullable<BotState['microStopSubmission']>,
  ): Promise<SupervisionResult | undefined> {
    if (!store?.flush) {
      return this.persistStatus(store, {
        status: 'UNKNOWN',
        owner,
        reason: 'NO_STORE_FOR_PERSISTENCE',
      });
    }
    try {
      const current = store.get();
      if (!this.matchesPositionIdentity(state, owner, current)) {
        return this.persistStatus(store, {
          status: 'UNKNOWN',
          owner,
          reason: 'POSITION_IDENTITY_INVALID',
        });
      }
      if (submission && current.microStopSubmission !== undefined) {
        return this.persistStatus(store, {
          status: 'UNKNOWN',
          owner,
          reason: 'STOP_SUBMISSION_ALREADY_RECORDED',
        });
      }
      store.set({
        microProtectionBlocked: true,
        ...(submission ? { microStopSubmission: { ...submission } } : {}),
      });
      await store.flush();
      const persisted = store.get();
      if (!this.matchesPositionIdentity(state, owner, persisted)) {
        return this.persistStatus(store, {
          status: 'UNKNOWN',
          owner,
          reason: 'POSITION_IDENTITY_CHANGED',
        });
      }
    } catch (error) {
      return { status: 'UNKNOWN', owner, reason: `MUTATION_PERSIST_FAILED:${String(error)}` };
    }
  }

  private matchesPositionIdentity(
    state: BotState,
    owner: PositionOwner,
    current: BotState,
  ): boolean {
    return (
      typeof state.lastTradeId === 'string' &&
      state.lastTradeId.trim().length > 0 &&
      (state.lastSide === 'LONG' || state.lastSide === 'SHORT') &&
      current.lastTradeId === state.lastTradeId &&
      current.lastSide === state.lastSide &&
      current.mode === state.mode &&
      this.deps.resolveOwner(current) === owner
    );
  }

  private async persistStatus(
    store: StateStore | undefined,
    result: SupervisionResult,
  ): Promise<SupervisionResult> {
    if (store && result.status !== 'PROTECTED' && result.status !== 'MISSING') {
      const patch: Partial<BotState> = {};
      if (result.status === 'RECOVERY_REQUIRED' || result.status === 'UNKNOWN') {
        patch.microProtectionBlocked = true;
      }
      // Only reconcileFlat may set IDLE after exchange confirmation.
      try {
        store.set(patch);
        if (store.flush) await store.flush();
      } catch (error) {
        return {
          status: 'UNKNOWN',
          owner: result.owner,
          reason: `STATUS_PERSIST_FAILED:${String(error)}`,
        };
      }
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

  private roundStopPrice(
    side: Side,
    price: number,
    filters: { tickSize: number; pricePrecision: number },
  ): number {
    const tickSize = filters.tickSize;
    if (!Number.isFinite(tickSize) || tickSize <= 0) {
      return Number(price.toFixed(filters.pricePrecision));
    }
    const ticks = price / tickSize;
    const roundedTicks = side === 'LONG' ? Math.ceil(ticks - 1e-12) : Math.floor(ticks + 1e-12);
    return Number((roundedTicks * tickSize).toFixed(filters.pricePrecision));
  }
}
