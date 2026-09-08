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
it('initializes a fresh signed scope with private local keys but refuses a second initialization', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'micro-operator-'));
  directories.push(root);
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  const keyDirectory = path.join(root, 'operator');
  const options = {
    keyDirectory,
    apiKey: 'synthetic-not-real',
    isTestnet: true,
    reason: 'Explicit offline fixture initialization',
  };
  expect(initializeLocalMicroLedger(options)).toMatchObject({ initialized: true, revision: 1 });
  expect(fs.statSync(path.join(keyDirectory, 'operator.private.pem')).mode & 0o777).toBe(0o600);
  expect(() => initializeLocalMicroLedger(options)).toThrow(
    'MICRO_OPERATOR_INITIALIZATION_NOT_PRISTINE',
  );
  expect(fs.readdirSync(keyDirectory).filter((f) => f.endsWith('.json'))).toHaveLength(1);
});
