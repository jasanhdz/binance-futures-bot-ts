import { mkdirSync, writeFileSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { StrategyDecisionEvidenceV2 } from '../../core/blackbox/StrategyDecisionBlackBox';
import {
  isVerifiedFrozenCollectorArtifact,
  type VerifiedFrozenCollectorArtifact,
} from './MicroBurstCollectorFreeze';

export interface CaptureIdentity {
  config: unknown;
  producer:
    | VerifiedFrozenCollectorArtifact
    | {
        readonly executionIdentity: 'UNVERIFIED_PRODUCER';
        readonly reportedCommit: string;
        readonly artifactHash?: string;
        readonly codeSha256?: string;
      };
}

export interface EpisodeCaptureCompletion {
  readonly sequence: number;
  readonly finalHash: string;
  readonly failed: boolean;
  readonly droppedRecords: number;
  readonly pendingWrites: number;
  readonly lastReceivedAtMs: number;
}

export type EpisodeCaptureRecord =
  | {
      kind: 'MARKET';
      receivedAtMs: number;
      eventTimeMs: number;
      symbol: string;
      feed: 'AGG_TRADE' | 'DEPTH' | 'CHECKPOINT' | 'CANDLE' | 'BTC_CONTEXT';
      payload: unknown;
    }
  | { kind: 'DECISION'; receivedAtMs: number; decision: StrategyDecisionEvidenceV2 }
  | {
      kind: 'GAP';
      receivedAtMs: number;
      fromMs: number;
      throughMs: number;
      symbol: string;
      reason: string;
    }
  | {
      kind: 'VARIANT_TERMINAL';
      receivedAtMs: number;
      episodeId: string;
      variant: 'CURRENT' | 'PULLBACK';
      outcome: 'CLOSED' | 'REJECTED' | 'UNFILLED' | 'UNKNOWN';
      evidence: unknown;
    };

interface CapturedEpisode {
  symbol: string;
  firstDecisionAtMs: number;
  decisionIds: string[];
  rawWarmupCoverage: 'NOT_CERTIFIED';
  terminal: Partial<Record<'CURRENT' | 'PULLBACK', 'CLOSED' | 'REJECTED' | 'UNFILLED' | 'UNKNOWN'>>;
}

/** Dedicated append-only capture sink. No exchange or order dependencies; never deletes source data.
 * Producers must supply continuous events, original contexts and own execution code bytes.
 * This sink proves persistence/integrity, not market continuity or producer authenticity.
 */
export class MicroBurstEpisodeCapture {
  private readonly fd: FileHandle;
  private sequence = 0;
  private previousHash = 'GENESIS';
  private lastReceivedAtMs: number;
  private closed = false;
  private failed = false;
  private pendingWrites = 0;
  private droppedRecords = 0;
  private writeTail: Promise<void> = Promise.resolve();
  private readonly episodes = new Map<string, CapturedEpisode>();

  private constructor(
    private readonly directory: string,
    private readonly identity: CaptureIdentity,
    startedAtMs: number,
    fd: FileHandle,
    private readonly maxPendingWrites: number,
  ) {
    if (!Number.isFinite(startedAtMs) || startedAtMs <= 0)
      throw new Error('CAPTURE_IDENTITY_OR_START_MISSING');
    this.fd = fd;
    this.lastReceivedAtMs = startedAtMs;
  }

  static async create(
    directory: string,
    identity: CaptureIdentity,
    startedAtMs: number,
    maxPendingWrites = 128,
  ): Promise<MicroBurstEpisodeCapture> {
    if (!Number.isFinite(startedAtMs) || startedAtMs <= 0 || maxPendingWrites < 1)
      throw new Error('CAPTURE_IDENTITY_OR_START_MISSING');
    if ('root' in identity.producer && !isVerifiedFrozenCollectorArtifact(identity.producer))
      throw new Error('FROZEN_PRODUCER_ARTIFACT_NOT_VERIFIED');
    // Exclusive run directory prevents accidental mixing with a prior experiment.
    mkdirSync(directory, { recursive: false, mode: 0o700 });
    const producer =
      'root' in identity.producer
        ? {
            artifactHash: identity.producer.artifactHash,
            codeSha256: identity.producer.codeSha256,
            configSha256: identity.producer.configSha256,
            reportedCommit: identity.producer.gitCommit,
            executionIdentity: 'VERIFIED_FROZEN_COLLECTOR_ARTIFACT' as const,
          }
        : {
            artifactHash: identity.producer.artifactHash ?? null,
            codeSha256: identity.producer.codeSha256 ?? null,
            reportedCommit: identity.producer.reportedCommit,
            executionIdentity: 'UNVERIFIED_PRODUCER' as const,
          };
    writeFileSync(
      join(directory, 'producer.json'),
      JSON.stringify(
        {
          authority: 'OBSERVATION_ONLY',
          mutationAuthority: false,
          startedAtMs,
          producer,
          config: identity.config,
          configSha256: createHash('sha256').update(JSON.stringify(identity.config)).digest('hex'),
          producerAuthenticity: 'HASHES_LINK_TO_VERIFIED_FROZEN_ARTIFACT_NOT_SIGNATURE',
        },
        null,
        2,
      ),
      { flag: 'wx', mode: 0o600 },
    );
    const fd = await open(join(directory, 'capture.jsonl'), 'wx', 0o600);
    return new MicroBurstEpisodeCapture(directory, identity, startedAtMs, fd, maxPendingWrites);
  }

  append(record: EpisodeCaptureRecord): Promise<void> {
    if (this.closed || this.failed) throw new Error('CAPTURE_NOT_WRITABLE');
    if (!Number.isFinite(record.receivedAtMs) || record.receivedAtMs < this.lastReceivedAtMs)
      throw new Error('CAPTURE_RECEIVE_CLOCK_REGRESSED');
    if (this.pendingWrites >= this.maxPendingWrites) {
      this.failed = true;
      this.droppedRecords++;
      throw new Error('CAPTURE_BACKPRESSURE_LIMIT');
    }
    let episodeId: string | undefined;
    if (record.kind === 'DECISION') {
      if (
        record.decision.evaluatedAtReceivedMs > record.receivedAtMs ||
        !Number.isFinite(record.decision.evaluatedAtReceivedMs)
      )
        throw new Error('DECISION_NOT_YET_AVAILABLE');
      if (record.decision.decision === 'ENTRY_INTENT') {
        episodeId = record.decision.diagnostics.episodeId as string;
        if (
          typeof episodeId !== 'string' ||
          !episodeId ||
          !record.decision.diagnostics.strategyInputReplay
        )
          throw new Error('ACCEPTED_EPISODE_OR_ORIGINAL_INPUT_MISSING');
        const previous = this.episodes.get(episodeId);
        if (previous && previous.symbol !== record.decision.symbol)
          throw new Error('EPISODE_IDENTITY_CONFLICT');
      }
    }
    if (record.kind === 'VARIANT_TERMINAL') {
      const episode = this.episodes.get(record.episodeId);
      if (!episode || episode.terminal[record.variant] !== undefined)
        throw new Error('UNKNOWN_OR_ALREADY_TERMINAL_VARIANT');
    }
    if (
      record.kind === 'GAP' &&
      (![record.fromMs, record.throughMs].every(Number.isFinite) ||
        record.throughMs < record.fromMs)
    )
      throw new Error('INVALID_CAPTURE_GAP');
    this.lastReceivedAtMs = record.receivedAtMs;
    this.pendingWrites++;
    const write = this.writeTail.then(async () => {
      if (this.failed) throw new Error('CAPTURE_WRITE_CHAIN_FAILED');
      const body = JSON.stringify({
        sequence: this.sequence + 1,
        previousHash: this.previousHash,
        record,
      });
      const hash = createHash('sha256').update(body).digest('hex');
      const line = Buffer.from(JSON.stringify({ body, hash }) + '\n');
      let offset = 0;
      while (offset < line.length) {
        const result = await this.fd.write(line, offset, line.length - offset, null);
        if (result.bytesWritten <= 0) throw new Error('CAPTURE_SHORT_WRITE');
        offset += result.bytesWritten;
      }
      await this.fd.datasync();
      this.sequence++;
      this.previousHash = hash;
      if (episodeId && record.kind === 'DECISION') {
        const episode = this.episodes.get(episodeId) ?? {
          symbol: record.decision.symbol,
          firstDecisionAtMs: record.decision.evaluatedAtReceivedMs,
          decisionIds: [],
          rawWarmupCoverage: 'NOT_CERTIFIED' as const,
          terminal: {},
        };
        if (!episode.decisionIds.includes(record.decision.decisionId))
          episode.decisionIds.push(record.decision.decisionId);
        this.episodes.set(episodeId, episode);
      }
      if (record.kind === 'VARIANT_TERMINAL')
        this.episodes.get(record.episodeId)!.terminal[record.variant] = record.outcome;
    });
    this.writeTail = write
      .catch((error: unknown) => {
        this.failed = true;
        throw error;
      })
      .finally(() => {
        this.pendingWrites--;
      });
    // Keep the queue chain settled for later drain/close, while returning the
    // original failure to the producer so a capture cannot look complete.
    const result = this.writeTail;
    this.writeTail = result.catch(() => undefined);
    return result;
  }

  async close(): Promise<EpisodeCaptureCompletion> {
    if (this.closed) return this.completionSummary();
    this.closed = true;
    try {
      await this.writeTail;
      await this.fd.datasync();
    } catch {
      this.failed = true;
    }
    await this.fd.close();
    const completion = {
      sequence: this.sequence,
      finalHash: this.previousHash,
      failed: this.failed,
      droppedRecords: this.droppedRecords,
      pendingWrites: this.pendingWrites,
      lastReceivedAtMs: this.lastReceivedAtMs,
      marketCoverage: 'NOT_CERTIFIED',
      episodes: [...this.episodes].map(([episodeId, episode]) => ({
        episodeId,
        ...episode,
        lifecycle:
          episode.terminal.CURRENT && episode.terminal.PULLBACK
            ? 'BOTH_TERMINAL_RECORDED'
            : 'INCOMPLETE',
      })),
    };
    writeFileSync(join(this.directory, 'completion.json'), JSON.stringify(completion, null, 2), {
      flag: 'wx',
      mode: 0o600,
    });
    this.closed = true;
    return this.completionSummary();
  }

  completionSummary(): EpisodeCaptureCompletion {
    return {
      sequence: this.sequence,
      finalHash: this.previousHash,
      failed: this.failed,
      droppedRecords: this.droppedRecords,
      pendingWrites: this.pendingWrites,
      lastReceivedAtMs: this.lastReceivedAtMs,
    };
  }
}
