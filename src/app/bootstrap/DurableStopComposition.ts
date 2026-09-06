import fs from 'node:fs';
import path from 'node:path';
import { FileBackedExecutionJournal } from '../../core/risk/ExecutionJournal';
import { DurableStopCoordinator } from '../execution/DurableStopCoordinator';
import type { TradingExchangePort } from '../ports/Exchange';

/** Single-account project scope, not credential-derived account discovery. Lazy disk ownership. */
export function composeDurableStopCoordinator(
  exchange: TradingExchangePort,
  isTestnet: boolean,
): DurableStopCoordinator {
  const scope = {
    account: 'binance-futures-bot-primary',
    environment: isTestnet ? 'testnet' : 'production',
  };
  return new DurableStopCoordinator({
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
        path.join(directory, `stop-mutations-${scope.account}-${scope.environment}.jsonl`),
      );
    },
  });
}
