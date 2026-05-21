import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FsLogger, resetFsLoggerTelegramDedupeForTests } from './FsLogger';
import { TelegramService } from '../adapters/TelegramAdapter';

vi.mock('../adapters/TelegramAdapter', () => ({
  TelegramService: {
    sendSystemLog: vi.fn(async () => undefined),
  },
}));

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('FsLogger Telegram system error dedupe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFsLoggerTelegramDedupeForTests();
  });

  it('dedupes identical Telegram SYSTEM ERROR messages while still logging locally', async () => {
    const logger = new FsLogger();

    logger.error('Aegis lookForEntry error', { error: 'TypeError: fetch failed' });
    logger.error('Aegis lookForEntry error', { error: 'TypeError: fetch failed' });
    await flushAsync();

    expect(TelegramService.sendSystemLog).toHaveBeenCalledTimes(1);
  });

  it('does not dedupe different error causes', async () => {
    const logger = new FsLogger();

    logger.error('Aegis lookForEntry error', { error: 'TypeError: fetch failed' });
    logger.error('Aegis lookForEntry error', { error: 'AxiosError: timeout of 5000ms exceeded' });
    await flushAsync();

    expect(TelegramService.sendSystemLog).toHaveBeenCalledTimes(2);
  });
});
