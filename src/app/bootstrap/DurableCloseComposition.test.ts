import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { TradingExchangePort } from '../ports/Exchange';
import { composeDurableCloseCoordinator } from './DurableCloseComposition';

it('lazily owns an environment-scoped close writer, independently of entry mode', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'close-composition-'));
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir);
  const exchange = {
    sendMarketCloseOnce: vi.fn(),
    readMarketCloseByClientOrderId: vi.fn(),
    readFreshActivePosition: vi.fn(),
  } as unknown as TradingExchangePort;
  const first = composeDurableCloseCoordinator(exchange, true);
  const competitor = composeDurableCloseCoordinator(exchange, true);
  const other = composeDurableCloseCoordinator(exchange, false);
  try {
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(first.blockedReason()).toBe('CLOSE_NOT_STARTED');
    await first.start();
    await other.start();
    await expect(competitor.start()).rejects.toThrow('JOURNAL_WRITER_LOCKED');
    expect(
      fs.existsSync(
        path.join(
          dir,
          'data/runtime/close-mutations-binance-futures-bot-primary-testnet.jsonl.lock',
        ),
      ),
    ).toBe(true);
    expect(exchange.sendMarketCloseOnce).not.toHaveBeenCalled();
  } finally {
    await Promise.allSettled([first.close(), competitor.close(), other.close()]);
    cwd.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('does not silently fall back when the production exchange lacks identified close capability', async () => {
  const coordinator = composeDurableCloseCoordinator({} as TradingExchangePort, true);
  await expect(coordinator.start()).rejects.toThrow('IDENTIFIED_CLOSE_CAPABILITY_REQUIRED');
  expect(coordinator.blockedReason()).toContain('CLOSE_JOURNAL_BLOCKED');
  await coordinator.close().catch(() => {});
});

it('requires the close coordinator at the production composition root, without a feature switch', () => {
  const source = fs.readFileSync(path.join(__dirname, 'StrategyComposition.ts'), 'utf8');
  expect(source).toContain(
    'closeCoordinator: composeDurableCloseCoordinator(exchange, CONFIG.IS_TESTNET)',
  );
});
