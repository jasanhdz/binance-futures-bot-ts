import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { hashTree } from './MicroBurstCollectorFreeze';

it('identifies actual nested dependency/source bytes including uncommitted changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'collector-identity-'));
  try {
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'nested', 'dependency.js'), 'module.exports = 1;');
    writeFileSync(join(root, 'producer.js'), 'initial');
    const original = hashTree(root);
    expect(hashTree(root)).toEqual(original);
    writeFileSync(join(root, 'producer.js'), 'local modified source');
    const modified = hashTree(root);
    expect(modified).not.toEqual(original);
    expect(modified.find((r) => r.path === 'nested/dependency.js')).toEqual(
      original.find((r) => r.path === 'nested/dependency.js'),
    );
    writeFileSync(join(root, 'nested', 'dependency.js'), 'module.exports = 2;');
    expect(hashTree(root)).not.toEqual(modified);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
