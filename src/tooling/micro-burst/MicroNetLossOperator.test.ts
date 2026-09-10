import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { initializeLocalMicroLedger } from './MicroNetLossOperator';
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of directories.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
it.each([NaN, -1, 1.5])(
  'rejects invalid exchange time %s before creating keys or storage',
  async (serverTime) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'micro-operator-'));
    directories.push(root);
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    await expect(
      initializeLocalMicroLedger({
        keyDirectory: path.join(root, 'operator'),
        apiKey: 'synthetic-not-real',
        isTestnet: true,
        reason: 'Invalid clock fixture',
        readServerTime: async () => serverTime,
      }),
    ).rejects.toThrow('MICRO_NET_LOSS_CLOCK_INVALID');
    expect(fs.readdirSync(root)).toEqual([]);
  },
);
it('fails closed before creating keys when Binance time is unavailable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'micro-operator-'));
  directories.push(root);
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  await expect(
    initializeLocalMicroLedger({
      keyDirectory: path.join(root, 'operator'),
      apiKey: 'synthetic-not-real',
      isTestnet: true,
      reason: 'Unavailable clock fixture',
      readServerTime: async () => {
        throw new Error('offline');
      },
    }),
  ).rejects.toThrow('MICRO_NET_LOSS_CLOCK_UNAVAILABLE');
  expect(fs.readdirSync(root)).toEqual([]);
});
it('initializes a fresh signed scope with private local keys but refuses a second initialization', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'micro-operator-'));
  directories.push(root);
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  const keyDirectory = path.join(root, 'operator');
  const options = {
    keyDirectory,
    apiKey: 'synthetic-not-real',
    isTestnet: true,
    reason: 'Explicit offline fixture initialization',
    readServerTime: async () => Date.UTC(2026, 8, 10, 12),
  };
  await expect(initializeLocalMicroLedger(options)).resolves.toMatchObject({
    initialized: true,
    revision: 1,
  });
  expect(fs.statSync(path.join(keyDirectory, 'operator.private.pem')).mode & 0o777).toBe(0o600);
  await expect(initializeLocalMicroLedger(options)).rejects.toThrow(
    'MICRO_OPERATOR_INITIALIZATION_NOT_PRISTINE',
  );
  const otherDirectory = path.join(root, 'other-operator');
  await expect(
    initializeLocalMicroLedger({ ...options, keyDirectory: otherDirectory }),
  ).rejects.toThrow('MICRO_OPERATOR_EXISTING_LEDGER_REQUIRES_PINNED_KEY');
  expect(fs.existsSync(otherDirectory)).toBe(false);
  expect(fs.readdirSync(keyDirectory).filter((f) => f.endsWith('.json'))).toHaveLength(1);
});
