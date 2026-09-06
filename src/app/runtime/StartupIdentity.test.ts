import { afterEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import { readStartupIdentity } from './StartupIdentity';
import { TelegramService } from '../../infra/adapters/TelegramAdapter';

vi.mock('node:os', () => ({
  userInfo: vi.fn(),
  hostname: vi.fn(),
  platform: vi.fn(),
  release: vi.fn(),
}));

afterEach(() => vi.resetAllMocks());

describe('startup identity', () => {
  it('reads OS identity and uses existing Telegram escaping', () => {
    vi.mocked(os.userInfo).mockReturnValue({ username: 'user<&>' } as ReturnType<
      typeof os.userInfo
    >);
    vi.mocked(os.hostname).mockReturnValue('mac<&>');
    vi.mocked(os.platform).mockReturnValue('darwin');
    vi.mocked(os.release).mockReturnValue('test');
    const identity = readStartupIdentity();
    expect(identity).toEqual({
      user: 'user<&>',
      hostname: 'mac<&>',
      platform: 'darwin',
      release: 'test',
    });
    expect(
      (TelegramService as any).formatForTelegram(`${identity.user} ${identity.hostname}`),
    ).toBe('user&lt;&amp;&gt; mac&lt;&amp;&gt;');
  });

  it('does not throw when OS facilities are unavailable', () => {
    vi.mocked(os.userInfo).mockImplementation(() => {
      throw new Error('unavailable');
    });
    vi.mocked(os.hostname).mockReturnValue('');
    expect(readStartupIdentity()).toEqual({
      user: 'UNKNOWN',
      hostname: 'UNKNOWN',
      platform: 'UNKNOWN',
      release: 'UNKNOWN',
    });
  });
});
