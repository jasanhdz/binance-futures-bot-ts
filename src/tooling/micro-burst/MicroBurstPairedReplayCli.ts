import { runPairedReplayRequestFile } from './MicroBurstPairedReplayOrchestrator';

/** Local-file-only entry point. Its imports do not include exchange or runtime adapters. */
export async function runMicroBurstPairedReplayCli(args: readonly string[]): Promise<void> {
  if (args.length !== 1)
    throw new Error('USAGE: MicroBurstPairedReplayCli <paired-archive-replay-request-v1.json>');
  const result = await runPairedReplayRequestFile(args[0]);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  runMicroBurstPairedReplayCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'MICRO_PAIRED_REPLAY_FAILED'}\n`,
    );
    process.exitCode = 1;
  });
}
