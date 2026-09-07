import fs from 'node:fs';
import path from 'node:path';
import { FileBackedExecutionJournal } from '../../core/risk/ExecutionJournal';
import { DurableCloseCoordinator } from '../execution/DurableCloseCoordinator';
import type { TradingExchangePort } from '../ports/Exchange';

/** Lazy single-account writer, independent of the entry switch and stop journal. */
export function composeDurableCloseCoordinator(
  exchange: TradingExchangePort,
  isTestnet: boolean,
): DurableCloseCoordinator {
  const scope = {
    account: 'binance-futures-bot-primary',
    environment: isTestnet ? 'testnet' : 'production',
  };
  return new DurableCloseCoordinator({
    scope,
    exchange,
    journal: () => {
      const data = path.join(process.cwd(), 'data');
      const directory = path.join(data, 'runtime');
      fs.mkdirSync(directory, { recursive: true });
      for (const parent of [process.cwd(), data, directory]) {
        const fd = fs.openSync(parent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
        try {
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      }
      return new FileBackedExecutionJournal(
        path.join(directory, `close-mutations-${scope.account}-${scope.environment}.jsonl`),
      );
    },
  });
}
