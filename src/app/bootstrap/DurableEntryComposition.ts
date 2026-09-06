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
      exchange.readMarketOpenByClientOrderId(request.intent.symbol, request.clientOrderId),
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
          current.bracketsAttached === true
        );
      };
      if (!state.flush || !matches()) return false;
      await state.flush();
      return matches();
    },
  });
}
