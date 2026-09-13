import { describe, expect, it, vi } from 'vitest';
import { cleanupFailedStartup } from './main';

describe('startup failure cleanup', () => {
  it('stops commands, service and diagnostics without leaving a live shell', async () => {
    const order: string[] = [];

    await cleanupFailedStartup({
      commands: { stop: () => order.push('commands') },
      service: {
        stop: vi.fn(async () => {
          order.push('service');
        }),
      },
      diagnostics: {
        stop: vi.fn(async () => {
          order.push('diagnostics');
        }),
      },
      logger: { error: vi.fn() },
    });

    expect(order).toEqual(['commands', 'service', 'diagnostics']);
  });

  it('does not hide cleanup failures', async () => {
    const logger = { error: vi.fn() };

    await cleanupFailedStartup({
      service: {
        stop: vi.fn(async () => {
          throw new Error('service cleanup');
        }),
      },
      diagnostics: {
        stop: vi.fn(async () => {
          throw new Error('diagnostics cleanup');
        }),
      },
      logger,
    });

    expect(logger.error).toHaveBeenCalledWith(
      'startup_cleanup_failed',
      expect.objectContaining({ error: 'Error: service cleanup' }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      'startup_diagnostics_cleanup_failed',
      expect.objectContaining({ error: 'Error: diagnostics cleanup' }),
    );
  });
});
