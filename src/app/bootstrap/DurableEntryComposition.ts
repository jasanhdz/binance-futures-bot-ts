import fs from 'node:fs';
import path from 'node:path';
import { FileBackedExecutionJournal } from '../../core/risk/ExecutionJournal';
import { DurableEntryCoordinator } from '../execution/DurableEntryCoordinator';
import type { TradingExchangePort } from '../ports/Exchange';
import type { StateStore } from '../ports/StateStore';

/** Production-only factory. Construction does not touch disk; start acquires the writer.
 * This project runs one account per environment. This is not API-key/account discovery.
 */
export function composeDurableEntryCoordinator(
  exchange: TradingExchangePort,
  isTestnet: boolean,
  stateStore: StateStore,
): DurableEntryCoordinator {
  const scope = {
    account: 'binance-futures-bot-primary',
    environment: isTestnet ? 'testnet' : 'production',
  };
  return new DurableEntryCoordinator({
    scope,
    journal: () => {
      const data = path.join(process.cwd(), 'data');
      const directory = path.join(data, 'runtime');
      fs.mkdirSync(directory, { recursive: true });
      // Stabilize newly created ancestor entries before creating the journal/lock.
      for (const parent of [process.cwd(), data, directory]) {
        const fd = fs.openSync(parent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
        try {
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      }
      return new FileBackedExecutionJournal(
        path.join(directory, `entry-mutations-${scope.account}-${scope.environment}.jsonl`),
      );
    },
    lookup: (request) =>
      exchange.readMarketOpenByClientOrderId(request.intent.symbol, request.clientOrderId, {
        side: request.intent.side,
        quantity: request.quantity,
        notBeforeMs: request.intent.requestedAt,
      }),
    confirmHandoff: async (request, order) => {
      const state = stateStore.forSymbol?.(request.intent.symbol) ?? stateStore;
      const matches = () => {
        const current = state.get();
        return (
          current.lastTradeId === request.parentTradeId &&
          current.lastOrderId === order.orderId &&
          current.lastSide === request.intent.side &&
          current.lastStrategy === request.intent.identity.strategyId &&
          current.mode !== 'IDLE' &&
          current.bracketsAttached === true &&
          // Reconstructing protection does not restore counters/fills/accounting evidence.
          !(current.recoveredEntryMutationId && current.microBurstPnlUnverified === true)
        );
      };
      if (!state.flush || !matches()) return false;
      const position = await exchange.readActivePosition(
        request.intent.symbol,
        request.intent.side,
      );
      if (
        !position ||
        !Number.isFinite(position.qtyAbs) ||
        position.qtyAbs <= 0 ||
        !['BOTH', request.intent.side].includes(position.sideMode)
      )
        return false;
      const orders = await exchange.listCloseOrdersForSide(
        request.intent.symbol,
        request.intent.side,
      );
      const covers = (kind: 'STOP' | 'TAKE_PROFIT') =>
        orders.some(
          (candidate) =>
            (candidate.type === kind || candidate.type === `${kind}_MARKET`) &&
            candidate.owner === 'BOT' &&
            Number.isFinite(candidate.stopPrice) &&
            candidate.stopPrice > 0 &&
            candidate.side === (request.intent.side === 'LONG' ? 'SELL' : 'BUY') &&
            candidate.positionSide === position.sideMode &&
            (candidate.closePosition === true ||
              (candidate.reduceOnly === true &&
                Number.isFinite(candidate.quantity) &&
                candidate.quantity! >= position.qtyAbs)),
        );
      if (
        (request.intent.protection.requireStop && !covers('STOP')) ||
        (request.intent.protection.requireTakeProfit && !covers('TAKE_PROFIT')) ||
        !matches()
      )
        return false;
      await state.flush();
      return matches();
    },
  });
}
