#!/usr/bin/env npx ts-node
/** Counterfactual comparison only. This script never changes runtime configuration. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { evaluateMicroBurstReactionEntry } from '../src/strategies/micro-burst/domain/MicroBurstReactionEntryPolicy';
import type { MicroBurstExactReplay } from '../src/strategies/micro-burst/domain/MicroBurstExactReplay';

const directory = process.argv[2] ?? 'data/strategy-blackbox/strategy-decisions';
const fileFilter = process.argv[3];
const files = fs
  .readdirSync(directory)
  .filter(
    (file) =>
      (file.endsWith('.jsonl') || file.endsWith('.jsonl.gz')) &&
      (!fileFilter || file === fileFilter),
  )
  .sort();
const policies = ['CURRENT', 'RECOVERY_ONLY', 'CONTINUATION_ONLY'] as const;
const counts = new Map<string, Map<string, number>>();
const changes = new Map<string, number>();
const sideReports = new Map<string, Map<string, Map<string, number>>>();
const examples = new Map<string, Record<string, unknown>[]>();
const episodes = new Map<string, Set<string>>();
let records = 0;
let replayRecords = 0;
let malformed = 0;

for (const file of files) {
  const fullPath = path.join(directory, file);
  const text = file.endsWith('.gz')
    ? zlib.gunzipSync(fs.readFileSync(fullPath)).toString('utf8')
    : fs.readFileSync(fullPath, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let record: Record<string, any>;
    try {
      record = JSON.parse(line) as Record<string, any>;
    } catch {
      malformed++;
      continue;
    }
    if (record.strategy?.strategyId !== 'MICRO_BURST') continue;
    records++;
    const wire = record.diagnostics?.strategyInputReplay;
    if (!wire || wire.schema !== 'MICRO_EXACT_INPUT') continue;
    replayRecords++;
    const replay = decode(wire) as MicroBurstExactReplay;
    const current = evaluate(replay, 'CURRENT');
    for (const policy of policies) {
      const result = evaluate(replay, policy);
      const reason = result.action === 'ENTRY_INTENT' ? 'ENTRY_INTENT' : result.reason;
      const byReason = counts.get(policy) ?? new Map<string, number>();
      byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
      counts.set(policy, byReason);
      if (policy !== 'CURRENT' && result.action !== current.action) {
        changes.set(policy, (changes.get(policy) ?? 0) + 1);
      }
      const sides = result.diagnostics.sides as Record<string, Record<string, any>> | undefined;
      for (const side of ['LONG', 'SHORT']) {
        const diagnostic = sides?.[side];
        if (!diagnostic) continue;
        const sideReason =
          result.action === 'ENTRY_INTENT' && result.side === side
            ? 'ENTRY_INTENT'
            : String(diagnostic.reason ?? 'UNKNOWN');
        const symbolMap = sideReports.get(policy) ?? new Map();
        const sideMap = symbolMap.get(record.symbol) ?? new Map();
        const kind = diagnostic.commonGuard
          ? 'COMMON_GUARD'
          : diagnostic.candidate == null
            ? 'SYNTHETIC'
            : 'REAL';
        const key = `${side}:${sideReason}:${kind}`;
        sideMap.set(key, (sideMap.get(key) ?? 0) + 1);
        symbolMap.set(record.symbol, sideMap);
        sideReports.set(policy, symbolMap);
        const context = replay.context as any;
        const candidate = diagnostic.candidate as Record<string, any> | null;
        const target = diagnostic.selectedTarget as Record<string, any> | null;
        const latest = context.candles?.candles1m?.at(-1);
        const fingerprint = [
          record.symbol,
          side,
          candidate?.price ?? 'NONE',
          target?.price ?? 'NONE',
          latest?.openTime ?? context.timestamp,
        ].join('|');
        const episodeKey = `${policy}:${record.symbol}:${side}`;
        const episodeSet = episodes.get(episodeKey) ?? new Set<string>();
        episodeSet.add(fingerprint);
        episodes.set(episodeKey, episodeSet);
        const exampleKey = `${policy}:${side}:${sideReason}`;
        const sideExamples = examples.get(exampleKey) ?? [];
        if (sideExamples.length < 3) {
          sideExamples.push({
            symbol: record.symbol,
            strategyTimestampMs: record.strategyTimestampMs,
            side,
            reason: sideReason,
            candidate,
            selectedTarget: target,
            targetSelection: diagnostic.targetSelection,
            stagesVisited: diagnostic.stagesVisited,
            trigger: {
              touchesNow: diagnostic.touchesNow,
              candleDirection: diagnostic.candleDirection,
              hasReclaim: diagnostic.hasReclaim,
              hasRetest: diagnostic.hasRetest,
              regime: diagnostic.regime,
              visitsCount: diagnostic.visitsCount,
              triggerInputs: diagnostic.triggerInputs,
              levelAvailableAtMs: candidate?.availableAtMs ?? null,
              triggerCandleOpenTime: latest?.openTime ?? null,
              executablePrice: diagnostic.targetSelection?.executablePrice ?? null,
            },
          });
          examples.set(exampleKey, sideExamples);
        }
      }
    }
  }
}

console.log(
  JSON.stringify(
    {
      directory,
      files: files.length,
      records,
      replayRecords,
      malformed,
      policies: Object.fromEntries(
        policies.map((policy) => [policy, Object.fromEntries(counts.get(policy) ?? [])]),
      ),
      totalEntries: Object.fromEntries(
        policies.map((policy) => [policy, counts.get(policy)?.get('ENTRY_INTENT') ?? 0]),
      ),
      changedDecisionCount: Object.fromEntries(changes),
      perCandleScenarioFingerprints: Object.fromEntries(
        [...episodes].map(([key, values]) => [key, values.size]),
      ),
      sideRejectionsBySymbol: Object.fromEntries(
        [...sideReports].map(([policy, symbols]) => [
          policy,
          Object.fromEntries(
            [...symbols].map(([symbol, values]) => [symbol, Object.fromEntries(values)]),
          ),
        ]),
      ),
      triggerExamples: Object.fromEntries(examples),
      note: 'This compares decisions only; it does not simulate subsequent candles, execution, or exits.',
    },
    null,
    2,
  ),
);

function evaluate(
  replay: MicroBurstExactReplay,
  policy: (typeof policies)[number],
): ReturnType<typeof evaluateMicroBurstReactionEntry> {
  return evaluateMicroBurstReactionEntry(
    replay.context,
    replay.config,
    replay.context.executionBook,
    replay.context.observedAtMs ?? replay.context.timestamp,
    replay.context.exchangeObservedAtMs ?? replay.context.observedAtMs ?? replay.context.timestamp,
    policy,
  );
}

function decode(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value), (_key, item) => {
    if (
      item &&
      typeof item === 'object' &&
      Object.keys(item).length === 1 &&
      'microNumber' in item
    ) {
      return Number((item as { microNumber: string }).microNumber);
    }
    return item;
  });
}
