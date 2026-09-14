import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import * as freshness from '../../strategies/micro-burst/domain/MicroBurstInputFreshness';
import * as btc from '../../strategies/micro-burst/domain/MicroBurstBtcContext';
import * as structural from '../../strategies/micro-burst/domain/MicroBurstEntryPolicy';
import * as identity from '../../strategies/micro-burst/domain/MicroBurstIdentity';
import * as units from '../../strategies/micro-burst/domain/MicroBurstUnits';
import * as types from '../../strategies/micro-burst/domain/MicroBurstTypes';
import type { evaluateMicroBurstReactionEntry } from '../../strategies/micro-burst/domain/MicroBurstReactionEntryPolicy';
import type { PatternEpisode } from './MicroBurstPatternEpisodes';

export const REACTION_SOURCE_PATH =
  'src/strategies/micro-burst/domain/MicroBurstReactionEntryPolicy.ts';
export const RESEARCH_ROOT = resolve(__dirname, '../../..');
type Evaluator = typeof evaluateMicroBurstReactionEntry;

/** Offline source instrumentation: reuse every CURRENT downstream statement verbatim.
 * No strategy imports this module. Only this checked-in local policy source is compiled;
 * replay input is never executable code. Anchors fail closed on upstream source drift.
 * This avoids both a production extension point and a drifting copy of the risk gates.
 */
export function compileOfflineReaction(source: string, episode?: PatternEpisode): Evaluator {
  const dependencies: Record<string, unknown> = {
    './MicroBurstInputFreshness': freshness,
    './MicroBurstBtcContext': btc,
    './MicroBurstEntryPolicy': structural,
    './MicroBurstIdentity': identity,
    './MicroBurstUnits': units,
    './MicroBurstTypes': types,
  };
  const replaceOnce = (pattern: RegExp, replacement: string): void => {
    if ([...source.matchAll(new RegExp(pattern.source, 'g'))].length !== 1)
      throw new Error(`PATTERN_POLICY_SOURCE_DRIFT:${pattern.source}`);
    source = source.replace(pattern, replacement);
  };
  if (episode) {
    replaceOnce(
      /const candidates = \[\.\.\.defensePool[\s\S]*?\n    \/\/ Pick the closest/,
      'const candidates = side === researchEpisode.side ? [researchEpisode.level] : [];\n    // Pick the closest',
    );
    replaceOnce(
      /const tolerance = \(level.price \* config.srClusterToleranceBps\) \/ 10_000;/,
      'const tolerance = researchEpisode.tolerancePrice;',
    );
    replaceOnce(
      /: level.availableAtMs;/,
      ': Math.max(level.availableAtMs, researchEpisode.levelVersionAsOfMs);',
    );
    replaceOnce(
      /if \(\n        !touchesNow \|\|[\s\S]*?\(!reclaim && !retest\)\n      \)/,
      'if (!lastVisit)',
    );
    replaceOnce(
      /setup =\n        roleReversed && retest[\s\S]*?: 'TREND_RETEST_CONTINUATION';/,
      'setup = researchEpisode.pattern;',
    );
  }
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: { evaluateMicroBurstReactionEntry?: Evaluator } = {};
  new Function('require', 'exports', 'researchEpisode', js)(
    (name: string) => {
      if (!(name in dependencies)) throw new Error(`PATTERN_UNEXPECTED_DEPENDENCY:${name}`);
      return dependencies[name];
    },
    exports,
    episode,
  );
  return exports.evaluateMicroBurstReactionEntry!;
}

export class MicroBurstPatternEvaluator {
  readonly source: string = readFileSync(resolve(RESEARCH_ROOT, REACTION_SOURCE_PATH), 'utf8');
  readonly sourceSha256: string = createHash('sha256').update(this.source).digest('hex');
  // Compile once with an invocation-local episode proxy, avoiding compilation per record.
  private active?: PatternEpisode;
  private readonly evaluate: Evaluator;

  constructor() {
    const proxy = new Proxy({} as PatternEpisode, {
      get: (_target, key) => this.active?.[key as keyof PatternEpisode],
    });
    this.evaluate = compileOfflineReaction(this.source, proxy);
  }

  evaluateConfirmation(
    episode: PatternEpisode,
    ctx: types.MicroBurstContext,
    config: types.MicroBurstConfig,
    book: types.OrderBookSnapshot | undefined,
    observedAtMs: number,
    exchangeObservedAtMs: number,
  ): types.MicroBurstEntryDecision {
    const latest = ctx.candles.candles1m.filter((c) => c.closeTime <= ctx.timestamp).slice(-1)[0];
    if (
      episode.status !== 'CONFIRMED' ||
      episode.confirmedAtMs === null ||
      episode.symbol !== ctx.symbol ||
      episode.confirmedAtMs !== latest?.closeTime ||
      episode.confirmedAtMs > exchangeObservedAtMs ||
      episode.level.availableAtMs > episode.startedAtMs ||
      episode.levelVersionAsOfMs > episode.startedAtMs
    )
      throw new Error('PATTERN_NOT_A_CURRENT_CAUSAL_CONFIRMATION');
    this.active = episode;
    try {
      const result = this.evaluate(
        ctx,
        config,
        book,
        observedAtMs,
        exchangeObservedAtMs,
        'CURRENT',
      );
      return {
        ...result,
        diagnostics: {
          ...result.diagnostics,
          patternEpisodeId: episode.id,
          patternConfirmedAtMs: episode.confirmedAtMs,
          patternEvaluatedAtMs: observedAtMs,
          patternFrozenTolerancePrice: episode.tolerancePrice,
          ...(result.action === 'ENTRY_INTENT' ? { episodeId: episode.id } : {}),
        },
      };
    } finally {
      this.active = undefined;
    }
  }
}
