import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { TradingExchangePort } from '../ports/Exchange';
import { composeDurableStopCoordinator } from './DurableStopComposition';

it('lazily opens a uniquely locked, environment-scoped stop journal and closes safely', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-composition-'));
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir);
  const exchange = {} as TradingExchangePort;
  const first = composeDurableStopCoordinator(exchange, true);
  const competitor = composeDurableStopCoordinator(exchange, true);
  const other = composeDurableStopCoordinator(exchange, false);
  try {
    expect(fs.readdirSync(dir)).toEqual([]);
    await first.start();
    await expect(competitor.start()).rejects.toThrow('JOURNAL_WRITER_LOCKED');
    await other.start();
    expect(
      fs.existsSync(
        path.join(
          dir,
          'data/runtime/stop-mutations-binance-futures-bot-primary-testnet.jsonl.lock',
        ),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(
          dir,
          'data/runtime/stop-mutations-binance-futures-bot-primary-production.jsonl.lock',
        ),
      ),
    ).toBe(true);
    await first.close();
    expect(
      fs.existsSync(
        path.join(
          dir,
          'data/runtime/stop-mutations-binance-futures-bot-primary-testnet.jsonl.lock',
        ),
      ),
    ).toBe(false);
  } finally {
    await Promise.allSettled([first.close(), competitor.close(), other.close()]);
    cwd.mockRestore();
    fs.rmSync(dir, { force: true, recursive: true });
  }
});
