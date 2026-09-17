import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramService } from './TelegramAdapter';

describe('TelegramService', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('retries failed alert delivery without exposing the failure to callers after recovery', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'alert-token');
    vi.stubEnv('TELEGRAM_CHAT_ID', 'chat-id');
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 500, text: async () => 'failed' });
    vi.stubGlobal('fetch', fetchMock);

    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'failed' });
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' });

    await expect(TelegramService.sendAlert('startup')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('times out and validates the plain-text fallback response', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'alert-token');
    vi.stubEnv('TELEGRAM_CHAT_ID', 'chat-id');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "Bad Request: can't parse entities",
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(TelegramService.sendAlert('**startup**')).rejects.toThrow('Telegram HTTP 400');
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('keeps the timeout active while reading a pending error body', async () => {
    vi.useFakeTimers();
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'alert-token');
    vi.stubEnv('TELEGRAM_CHAT_ID', 'chat-id');
    const fetchMock = vi.fn((_url: string, options: RequestInit) =>
      Promise.resolve({
        ok: false,
        status: 500,
        text: () =>
          new Promise<string>((_resolve, reject) => {
            options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      } as Response),
    );
    vi.stubGlobal('fetch', fetchMock);

    const sending = TelegramService.sendAlert('startup').catch((error) => error);
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(sending).resolves.toMatchObject({ message: 'aborted' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});
