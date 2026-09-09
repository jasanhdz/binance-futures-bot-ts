import { isMicroBurstStrategy, isMicroBurstPolicy } from '../../core/strategy/MicroBurstLegacy';
import type { BotState } from '../../core/types';
import type { DurableEntryRequest, EntryOrderReceipt } from '../execution/DurableEntryCoordinator';
import type { TradingExchangePort } from '../ports/Exchange';
import type { StateStore } from '../ports/StateStore';
import type { PositionProtectionService } from './PositionProtectionService';
import { isMicroBurstTradePolicy } from '../../strategies/micro-burst/domain/MicroBurstTradePolicy';

export interface MicroEntryRecoveryDeps {
  exchange: Pick<TradingExchangePort, 'readRecoverableEntryPosition'>;
  stateForSymbol(symbol: string): StateStore;
  protection: Pick<PositionProtectionService, 'superviseMicroStop'>;
  now?: () => number;
}

export interface MicroEntryRecoveryResult {
  status: 'PROTECTED' | 'PENDING' | 'CONFLICT' | 'NOT_APPLICABLE';
  reason: string;
}

/** Rebuilds only a blank Micro projection, never reopens or overwrites another trade. */
export class MicroEntryRecoveryService {
  private readonly inFlight = new Set<string>();
  constructor(private readonly deps: MicroEntryRecoveryDeps) {}

  async recover(
    request: DurableEntryRequest,
    receipt: EntryOrderReceipt,
  ): Promise<MicroEntryRecoveryResult> {
    const { intent } = request;
    if (!isMicroBurstStrategy(intent.identity.strategyId))
      return { status: 'NOT_APPLICABLE', reason: 'RECOVERY_OWNER_UNSUPPORTED' };
    const contextualPolicy = intent.metadata.contextualPolicy;
    if (
      isMicroBurstPolicy(intent.identity.strategyVersion) &&
      (!isMicroBurstTradePolicy(contextualPolicy, intent.identity) ||
        ![20, 30].includes(intent.leverage) ||
        intent.leverage > contextualPolicy.config.maxLeverageHardCap ||
        intent.positionFraction !== contextualPolicy.risk.marginFraction)
    )
      return { status: 'PENDING', reason: 'RECOVERY_CONTEXTUAL_POLICY_UNVERIFIED' };
    if (this.inFlight.has(intent.symbol))
      return { status: 'PENDING', reason: 'RECOVERY_IN_FLIGHT' };
    this.inFlight.add(intent.symbol);
    try {
      const store = this.deps.stateForSymbol(intent.symbol);
      const initial = store.get();
      const blank = (state: BotState) =>
        state.mode === 'IDLE' &&
        Object.entries(state).every(([key, value]) => key === 'mode' || value === undefined);
      const matches = (state: BotState) =>
        state.recoveredEntryMutationId === request.mutationId &&
        state.lastTradeId === request.parentTradeId &&
        state.lastOrderId === receipt.orderId &&
        state.lastSide === intent.side &&
        isMicroBurstStrategy(state.lastStrategy) &&
        state.positionOwner === 'BOT' &&
        state.tradeOrigin === 'BOT' &&
        state.ownershipStatus === 'VERIFIED' &&
        (!isMicroBurstPolicy(intent.identity.strategyVersion) ||
          (isMicroBurstTradePolicy(state.microBurstTradePolicy, intent.identity) &&
            state.microBurstTradePolicy.digest ===
              (contextualPolicy as { digest: string }).digest)) &&
        state.mode === (intent.side === 'LONG' ? 'LONG_RIDE' : 'SHORT_RIDE');
      if (!blank(initial) && !matches(initial))
        return { status: 'CONFLICT', reason: 'RECOVERY_STATE_OCCUPIED' };
      if (!store.flush || !this.deps.exchange.readRecoverableEntryPosition) {
        return { status: 'PENDING', reason: 'RECOVERY_CAPABILITY_MISSING' };
      }
      if (
        !intent.protection.requireStop ||
        intent.protection.requireTakeProfit ||
        !Number.isFinite(intent.structuralStopPrice) ||
        intent.structuralStopPrice! <= 0 ||
        !Number.isFinite(intent.destinationPrice) ||
        intent.destinationPrice! <= 0 ||
        !Number.isFinite(request.quantity) ||
        request.quantity <= 0 ||
        !Number.isFinite(intent.leverage) ||
        intent.leverage <= 0
      ) {
        return { status: 'PENDING', reason: 'RECOVERY_POLICY_INCOMPLETE' };
      }
      const observationStartedAt = this.deps.now?.() ?? Date.now();
      const evidence = await this.deps.exchange.readRecoverableEntryPosition(
        intent.symbol,
        request.clientOrderId,
        { side: intent.side, quantity: request.quantity, notBeforeMs: intent.requestedAt },
      );
      const now = this.deps.now?.() ?? Date.now();
      if (
        !evidence ||
        evidence.source !== 'BINANCE_ORDER_AND_TRADES_V1' ||
        evidence.symbol !== intent.symbol ||
        evidence.side !== intent.side ||
        evidence.clientOrderId !== request.clientOrderId ||
        evidence.orderId !== receipt.orderId ||
        !Number.isSafeInteger(evidence.filledAt) ||
        evidence.filledAt < intent.requestedAt ||
        evidence.filledAt > now ||
        !Number.isSafeInteger(evidence.observedAt) ||
        evidence.observedAt < observationStartedAt ||
        evidence.observedAt > now ||
        !Array.isArray(evidence.fillIds) ||
        !evidence.fillIds.length ||
        evidence.fillIds.some((id) => typeof id !== 'string' || !id.trim()) ||
        new Set(evidence.fillIds).size !== evidence.fillIds.length ||
        !Number.isFinite(evidence.position.entryPrice) ||
        evidence.position.entryPrice <= 0 ||
        evidence.position.qtyAbs !== request.quantity ||
        evidence.position.entryPrice !== receipt.avgPrice ||
        evidence.position.leverage !== intent.leverage ||
        !['BOTH', intent.side].includes(evidence.position.sideMode)
      ) {
        return { status: 'PENDING', reason: 'RECOVERY_ATTRIBUTION_UNVERIFIED' };
      }
      const position = evidence.position;
      // No awaits between the state comparison and projection write.
      if (blank(initial)) {
        if (!blank(store.get())) return { status: 'CONFLICT', reason: 'RECOVERY_STATE_CHANGED' };
        store.set({
          mode: intent.side === 'LONG' ? 'LONG_RIDE' : 'SHORT_RIDE',
          positionOwner: 'BOT',
          tradeOrigin: 'BOT',
          ownershipStatus: 'VERIFIED',
          lastTradeId: request.parentTradeId,
          lastOrderId: receipt.orderId,
          lastSide: intent.side,
          lastStrategy: 'MICRO_BURST',
          lastStrategyVersion: intent.identity.strategyVersion,
          lastStrategyHash: intent.identity.strategyHash,
          lastConfigHash: intent.identity.configHash,
          lastCodeCommitSha: intent.identity.codeCommitSha,
          lastStrategyFreezeState: intent.identity.freezeState,
          lastEntryAt: evidence.filledAt,
          lastEntryPrice: position.entryPrice,
          lastEntryQty: position.qtyAbs,
          lastLeverage: position.leverage,
          lastActualLeverage: position.leverage,
          lastRequestedLeverage: intent.leverage,
          lastPositionFraction: intent.positionFraction,
          posSideMode: position.sideMode,
          lastStopPrice: intent.structuralStopPrice,
          microBurstStructuralStopPrice: intent.structuralStopPrice,
          microBurstDestinationPrice: intent.destinationPrice,
          ...(isMicroBurstPolicy(intent.identity.strategyVersion)
            ? {
                microBurstTradePolicy: structuredClone(contextualPolicy),
                microBurstEpisodeId: String(intent.metadata?.episodeId ?? ''),
                microBurstEntrySubmittedAtMs: intent.requestedAt,
              }
            : {}),
          recoveredEntryMutationId: request.mutationId,
          bracketsAttached: false,
          lastBracketStatus: 'PENDING',
          microProtectionBlocked: true,
          microBurstPnlUnverified: true,
          microBurstPnlUnverifiedAt: now,
          eligibleForBotMetrics: false,
          metricsExclusionReason: 'RECOVERED_ENTRY_ACCOUNTING_PENDING',
        });
      } else if (!matches(store.get()))
        return { status: 'CONFLICT', reason: 'RECOVERY_STATE_CHANGED' };
      await store.flush();
      if (!matches(store.get()))
        return { status: 'CONFLICT', reason: 'RECOVERY_IDENTITY_CHANGED_AFTER_FLUSH' };
      // Same runtime service/lock as normal management; no second stop writer.
      const protection = await this.deps.protection.superviseMicroStop(
        intent.symbol,
        store.get(),
        store,
      );
      if (!matches(store.get()))
        return { status: 'CONFLICT', reason: 'RECOVERY_IDENTITY_CHANGED_DURING_PROTECTION' };
      if (protection.status !== 'PROTECTED')
        return { status: 'PENDING', reason: protection.reason ?? protection.status };
      store.set({ bracketsAttached: true, lastBracketStatus: 'OK', microProtectionBlocked: false });
      await store.flush();
      if (!matches(store.get()))
        return { status: 'CONFLICT', reason: 'RECOVERY_IDENTITY_CHANGED_AFTER_PROTECTION' };
      return { status: 'PROTECTED', reason: 'RECOVERED_ENTRY_ACCOUNTING_PENDING' };
    } catch {
      // A failed projection/observation is not a license to replace another state or send again.
      return { status: 'PENDING', reason: 'RECOVERY_OBSERVATION_OR_PERSISTENCE_FAILED' };
    } finally {
      this.inFlight.delete(intent.symbol);
    }
  }
}
