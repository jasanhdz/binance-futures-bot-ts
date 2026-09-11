import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runMicroBurstExactReplayCli } from './MicroBurstExactReplayCli';
import { makeMicroBurstContext } from '../../strategies/micro-burst/domain/MicroBurst.test-support';
import { defaultMicroBurstConfig } from '../../strategies/micro-burst/domain/MicroBurstTypes';
import {
  captureMicroBurstReplay,
  encodeMicroReplay,
} from '../../strategies/micro-burst/domain/MicroBurstExactReplay';

it('reads a complete synthetic input without modifying it and transparently rejects legacy input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'micro-exact-cli-'));
  try {
    const path = join(directory, 'input.json');
    const context = makeMicroBurstContext();
    context.dataQuality.contextValid = false;
    const commit = 'a'.repeat(40);
    const body = JSON.stringify(
      encodeMicroReplay(
        captureMicroBurstReplay(
          { ...context, observedAtMs: context.timestamp, exchangeObservedAtMs: context.timestamp },
          defaultMicroBurstConfig(),
          commit,
        ),
      ),
    );
    await writeFile(path, body);
    const result = JSON.parse(await runMicroBurstExactReplayCli([path, commit], () => commit));
    expect(result.result.reason).toBe('REACTION_CONTEXT_INVALID');
    expect(await readFile(path, 'utf8')).toBe(body);
    await writeFile(path, JSON.stringify({ schemaVersion: 2, diagnostics: {} }));
    await expect(runMicroBurstExactReplayCli([path, commit], () => commit)).rejects.toThrow(
      'MICRO_REPLAY_INCOMPLETE',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
