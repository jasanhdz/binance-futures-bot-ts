import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { composeMicroNetLossLedger } from './MicroNetLossComposition';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0).reverse()) work();
  vi.restoreAllMocks();
});

describe('Micro critical ledger composition', () => {
  it('does not open storage or grant authority without an operator key', () => {
    const mkdir = vi.spyOn(fs, 'mkdirSync');
    expect(composeMicroNetLossLedger('', false, '')).toBeUndefined();
    expect(mkdir).not.toHaveBeenCalled();
  });

  it('separates credential/environment scopes and never initializes them automatically', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'micro-ledger-composition-'));
    cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
    vi.spyOn(process, 'cwd').mockReturnValue(directory);
    const key = path.join(directory, 'operator-public.pem');
    fs.writeFileSync(
      key,
      generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }),
    );
    for (const [credential, testnet] of [
      ['synthetic-a', false],
      ['synthetic-b', false],
      ['synthetic-a', true],
    ] as const) {
      const ledger = composeMicroNetLossLedger(credential, testnet, key)!;
      expect(ledger.snapshot().blockedReason).toBe('MICRO_NET_LOSS_NOT_INITIALIZED');
      ledger.close();
    }
    const files = fs.readdirSync(path.join(directory, 'data', 'runtime', 'micro-net-loss'));
    expect(files.filter((file) => file.endsWith('.sqlite'))).toHaveLength(3);
    expect(files.every((file) => !file.includes('synthetic'))).toBe(true);
  });

  it('rejects a symlinked storage directory instead of following it', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'micro-ledger-symlink-'));
    cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
    vi.spyOn(process, 'cwd').mockReturnValue(directory);
    const key = path.join(directory, 'operator-public.pem');
    fs.writeFileSync(
      key,
      generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }),
    );
    fs.mkdirSync(path.join(directory, 'actual'));
    fs.symlinkSync(path.join(directory, 'actual'), path.join(directory, 'data'));
    expect(() => composeMicroNetLossLedger('synthetic', false, key)).toThrow(
      'MICRO_NET_LOSS_STORAGE_NOT_OWNED',
    );
  });
});
