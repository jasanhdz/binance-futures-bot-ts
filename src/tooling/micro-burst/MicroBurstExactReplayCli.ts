import { open } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { replayMicroBurstExact } from '../../strategies/micro-burst/domain/MicroBurstExactReplay';

/** Offline, read-only, bounded single-record CLI. No application config or adapter imports. */
function checkedCodeRevision(): string {
  const cwd = resolve(__dirname, '../../..');
  const options = {
    cwd,
    encoding: 'utf8' as const,
    timeout: 5000,
    env: { PATH: process.env.PATH ?? '' },
  };
  const dirty = execFileSync(
    'git',
    ['status', '--porcelain', '--untracked-files=normal', '--', 'src'],
    options,
  );
  if (dirty.trim()) throw new Error('MICRO_REPLAY_SOURCE_WORKTREE_DIRTY');
  return execFileSync('git', ['rev-parse', 'HEAD'], options).trim();
}

export async function runMicroBurstExactReplayCli(
  args: readonly string[],
  codeRevision: () => string = checkedCodeRevision,
): Promise<string> {
  if (args.length !== 2 || !/^[a-f0-9]{40}$/.test(args[1]))
    throw new Error('USAGE: MicroBurstExactReplayCli INPUT_JSON MATCHING_CODE_COMMIT_SHA');
  if (codeRevision() !== args[1]) throw new Error('MICRO_REPLAY_CHECKED_OUT_REVISION_MISMATCH');
  const handle = await open(args[0], 'r');
  let input: unknown;
  try {
    const size = (await handle.stat()).size;
    if (size <= 0 || size > 8 * 1024 * 1024) throw new Error('MICRO_REPLAY_FILE_SIZE_INVALID');
    const buffer = Buffer.alloc(size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== size) throw new Error('MICRO_REPLAY_FILE_CHANGED');
    input = JSON.parse(buffer.toString('utf8', 0, size));
  } finally {
    await handle.close();
  }
  const candidate = input as { diagnostics?: { strategyInputReplay?: unknown } };
  const record = candidate?.diagnostics?.strategyInputReplay ?? input;
  const result = replayMicroBurstExact(record, args[1]);
  return JSON.stringify({
    provenance: {
      mode: 'OFFLINE_EXACT_INPUT',
      codeCommitSha: args[1],
      codeCompatibility: 'CHECKED_OUT_COMMIT_AND_EVALUATOR_REVISION_MATCH',
      historicalMarketReconstruction: false,
    },
    result,
  });
}

if (require.main === module) {
  runMicroBurstExactReplayCli(process.argv.slice(2)).then(
    (result) => {
      process.stdout.write(`${result}\n`);
    },
    (error: unknown) => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
