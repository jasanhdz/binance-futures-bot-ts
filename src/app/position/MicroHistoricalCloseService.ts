import { isDeepStrictEqual } from 'node:util';
import type { DurableEntryRequest, EntryOrderReceipt } from '../execution/DurableEntryCoordinator';
import type { DurableStopCoordinator } from '../execution/DurableStopCoordinator';
import type { MicroBurstNetLossLedger } from '../../infra/state/MicroBurstNetLossLedger';
import type { TradingExchangePort } from '../ports/Exchange';
import type { StateStore } from '../ports/StateStore';
import { samePersistedStrategy } from '../../core/strategy/MicroBurstLegacy';
import {
  validMicroHistoricalClose,
  type MicroHistoricalCloseProof,
} from '../../strategies/micro-burst/domain/MicroHistoricalClose';

/** Called only by the pending entry's runtime owner, before admission or position reconstruction. */
export class MicroHistoricalCloseService {
  constructor(
    private readonly deps: {
      exchange: Pick<
        TradingExchangePort,
        'readHistoricalMicroClose' | 'readMicroFlatAndOpenOrders'
      >;
      ledger: MicroBurstNetLossLedger;
      stops: Pick<DurableStopCoordinator, 'retireHistoricalClose'>;
      now?: () => number;
      wait?: (ms: number) => Promise<void>;
      stopping: () => boolean;
    },
  ) {}

  async recover(
    request: DurableEntryRequest,
    receipt: EntryOrderReceipt,
    store: StateStore,
  ): Promise<MicroHistoricalCloseProof | undefined> {
    const now = this.deps.now ?? Date.now;
    const state = structuredClone(store.get());
    const intent = request.intent;
    if (
      String(intent.identity.strategyId) !== 'MICRO_BURST_V1' ||
      intent.identity.strategyVersion !== '0.8.0-expected-continuation-live' ||
      state.mode !== 'IDLE' ||
      state.positionOwner !== 'BOT' ||
      state.tradeOrigin !== 'BOT' ||
      state.ownershipStatus !== 'VERIFIED' ||
      state.lastTradeId !== request.parentTradeId ||
      state.lastOrderId !== receipt.orderId ||
      state.lastSide !== intent.side ||
      !samePersistedStrategy(state.lastStrategy, intent.identity.strategyId) ||
      state.lastEntryQty !== request.quantity ||
      state.lastEntryPrice !== receipt.avgPrice ||
      state.lastEntryAt !== intent.requestedAt ||
      !Number.isSafeInteger(state.lastExitAt) ||
      state.lastExitAt! < intent.requestedAt ||
      state.lastExitAt! >= Math.floor(now() / 86_400_000) * 86_400_000 ||
      state.microStopSubmission !== undefined ||
      state.microBurstStopMove !== undefined ||
      !store.flush ||
      !this.deps.exchange.readHistoricalMicroClose ||
      !this.deps.exchange.readMicroFlatAndOpenOrders
    )
      return;
    const ledgerState = this.deps.ledger.snapshot();
    if (
      !ledgerState.initialized &&
      ledgerState.blockedReason !== 'MICRO_NET_LOSS_CLOCK_UNAVAILABLE'
    )
      return;
    const same = () => !this.deps.stopping() && isDeepStrictEqual(store.get(), state);
    if (!same()) return;
    const started = now();
    const observed = await this.deps.exchange.readHistoricalMicroClose({
      tradeId: request.parentTradeId,
      entryOrderId: receipt.orderId,
      symbol: intent.symbol,
      side: intent.side,
      quantity: request.quantity,
      openedAtMs: intent.requestedAt,
      closedAtMs: state.lastExitAt!,
      clientOrderId: request.clientOrderId,
    });
    if (
      !observed ||
      !same() ||
      now() < started ||
      observed.evidence.observedAtMs < started ||
      observed.evidence.observedAtMs > now() ||
      now() - observed.evidence.observedAtMs > 10_000
    )
      return;
    const flat1 = await this.deps.exchange.readMicroFlatAndOpenOrders(intent.symbol);
    if (!flat1 || !same()) return;
    await (this.deps.wait?.(350) ?? new Promise((resolve) => setTimeout(resolve, 350)));
    const flat2 = await this.deps.exchange.readMicroFlatAndOpenOrders(intent.symbol);
    if (!flat2 || !same()) return;
    const proof: MicroHistoricalCloseProof = {
      protocol: 'MICRO_EXTERNALLY_CONFIRMED_CLOSE',
      identity: {
        ...observed.identity,
        provenance: {
          source: 'DURABLE_ENTRY_JOURNAL',
          operationId: request.operationId,
          clientOrderId: request.clientOrderId,
          identity: structuredClone(intent.identity),
          entryPrice: receipt.avgPrice,
        },
      },
      evidence: observed.evidence,
      flat: [flat1, flat2],
    };
    const identity = proof.identity;
    if (
      !validMicroHistoricalClose(proof) ||
      identity.tradeId !== request.parentTradeId ||
      identity.entryOrderId !== receipt.orderId ||
      identity.symbol !== intent.symbol ||
      identity.side !== intent.side ||
      identity.quantity !== request.quantity ||
      identity.openedAtMs !== intent.requestedAt ||
      identity.closedAtMs > state.lastExitAt! ||
      flat2.observedAtMs > now() ||
      now() - flat2.observedAtMs > 10_000 ||
      !same() ||
      !this.deps.ledger.snapshot().initialized
    )
      return;
    // Existing journal owner retires exposure, explicitly without asserting an order was canceled.
    if (!(await this.deps.stops.retireHistoricalClose(proof, same)) || !same()) return;
    const result = this.deps.ledger.observeHistorical(identity, proof.evidence);
    if (result.status !== 'VERIFIED' || !same()) return;
    // The entry reservation remains pending across this flush and the final flat recheck.
    store.set({ microHistoricalClose: proof });
    await store.flush();
    const projected = structuredClone(store.get());
    if (
      !isDeepStrictEqual(projected, { ...state, microHistoricalClose: proof }) ||
      this.deps.stopping()
    )
      return;
    const finalFlat = await this.deps.exchange.readMicroFlatAndOpenOrders(intent.symbol);
    if (
      !finalFlat ||
      !isDeepStrictEqual(store.get(), projected) ||
      this.deps.stopping() ||
      !validMicroHistoricalClose({ ...proof, flat: [flat1, finalFlat] }) ||
      finalFlat.startedAtMs < flat2.observedAtMs ||
      finalFlat.observedAtMs > now() ||
      now() - finalFlat.observedAtMs > 10_000
    )
      return;
    store.set({
      marketOpenAmbiguous: false,
      microBurstPnlUnverified: false,
      microBurstPnlUnverifiedAt: undefined,
      microProtectionBlocked: false,
      lastExitReason: 'MICRO_EXTERNALLY_CONFIRMED_CLOSE',
      metricsExclusionReason: 'HISTORICAL_EXCHANGE_VERIFIED_IN_NET_LEDGER',
    });
    const released = structuredClone(store.get());
    try {
      await store.flush();
    } catch (error) {
      if (isDeepStrictEqual(store.get(), released))
        store.set({
          marketOpenAmbiguous: true,
          microBurstPnlUnverified: true,
          microProtectionBlocked: true,
          microBurstPnlUnverifiedAt: state.microBurstPnlUnverifiedAt ?? now(),
        });
      throw error;
    }
    return !this.deps.stopping() && isDeepStrictEqual(store.get(), released) ? proof : undefined;
  }
}
