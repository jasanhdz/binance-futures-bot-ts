import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { TradingExchangePort } from '../ports/Exchange';
import type { StateStore } from '../ports/StateStore';
import { composeDurableEntryCoordinator } from './DurableEntryComposition';

describe('production durable entry factory in an explicit filesystem fixture', () => {
  it('creates the scoped writer only at startup, rejects a competitor, and retains orphan locks', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-composition-'));
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(directory);
    const exchange = {
      readMarketOpenByClientOrderId: vi.fn().mockResolvedValue(null),
    } as unknown as TradingExchangePort;
    const state: StateStore = {
      get: () => ({ mode: 'IDLE' }),
      set: () => ({ mode: 'IDLE' }),
      reset: () => {},
      flush: async () => {},
    };
    const first = composeDurableEntryCoordinator(exchange, true, state);
    const competitor = composeDurableEntryCoordinator(exchange, true, state);
    const production = composeDurableEntryCoordinator(exchange, false, state);
    try {
      expect(fs.readdirSync(directory)).toEqual([]);
      await first.start();
      expect(fs.readdirSync(path.join(directory, 'data/runtime'))).toEqual([
        'entry-mutations-binance-futures-bot-primary-testnet.jsonl',
        'entry-mutations-binance-futures-bot-primary-testnet.jsonl.lock',
      ]);
      await expect(competitor.start()).rejects.toThrow('JOURNAL_WRITER_LOCKED');
      await production.start();
      expect(exchange.readMarketOpenByClientOrderId).not.toHaveBeenCalled();
      await first.close();
      const lock = path.join(
        directory,
        'data/runtime/entry-mutations-binance-futures-bot-primary-testnet.jsonl.lock',
      );
      fs.writeFileSync(lock, '999999999:orphan\n');
      const orphanAttempt = composeDurableEntryCoordinator(exchange, true, state);
      await expect(orphanAttempt.start()).rejects.toThrow('JOURNAL_WRITER_LOCKED');
      expect(fs.readFileSync(lock, 'utf8')).toBe('999999999:orphan\n');
      await orphanAttempt.close().catch(() => undefined);
    } finally {
      await Promise.allSettled([first.close(), competitor.close(), production.close()]);
      cwd.mockRestore();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
