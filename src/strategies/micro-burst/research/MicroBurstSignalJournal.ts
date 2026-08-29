import * as fs from 'fs';
import * as path from 'path';
import type { MicroBurstShadowEvaluationResult } from '../application/MicroBurstShadowEvaluationTypes';

const DEFAULT_JOURNAL_DIR = 'logs/micro-burst/shadow-signals';
const MAX_JOURNAL_ENTRIES_PER_FILE = 10_000;

export interface MicroBurstSignalJournalEntry {
  schemaVersion: 1;
  cohortId: string;
  strategyId: string;
  strategyVersion: string;
  codeCommitSha: string;
  configHash: string;
  shadowSignalId: string;
  symbol: string;
  side: string | undefined;
  snapshotAtMs: number;
  observedAtMs: number;
  marketPrice: number;
  referencePriceSource: string;
  support: number | null;
  resistance: number | null;
  structuralStopPrice: number | null;
  destinationPrice: number | null;
  roomToTargetBps: number | null;
  riskToInvalidationBps: number | null;
  rewardRisk: number | null;
  momentum: {
    direction: string;
    strength: number;
    continuationScore: number;
  };
  book: {
    status: string;
    ageMs: number | null;
    spreadBps?: number;
    imbalance: number;
    imbalanceSlope: number | null;
    temporalAbsorption: boolean;
    temporalSweep: boolean;
  };
  aggTrade: {
    buyTakerVolume: number;
    sellTakerVolume: number;
    netTakerFlow: number;
    sampleCount: number;
  };
  btc: {
    status: string;
    ageMs: number | null;
    ret1m: number | null;
    ret3m: number | null;
    ret5m: number | null;
    acceleration: number | null;
    direction: string | null;
    conflict: boolean;
  };
  decision: string;
  confidence: number;
  leverageTier: string | undefined;
  leverage: number | undefined;
  positionFraction: number | undefined;
  wouldEnter: boolean;
  liveExecution: false;
  invalidReasons: string[];
}

export class MicroBurstSignalJournal {
  private entryCount = 0;
  private currentFilePath: string | null = null;
  private storageErrors = 0;
  private lastError: string | null = null;

  constructor(
    private readonly journalDir: string = DEFAULT_JOURNAL_DIR,
    private readonly maxEntriesPerFile = MAX_JOURNAL_ENTRIES_PER_FILE,
  ) {}

  append(
    result: MicroBurstShadowEvaluationResult,
    provenance?: { codeCommitSha: string; configHash: string; cohortId: string },
  ): boolean {
    if (!result.wouldEnter || result.duplicateSuppressed) return true;

    const entry = this.buildEntry(result, provenance);
    const json = JSON.stringify(entry);

    try {
      this.ensureDir();
      if (!this.currentFilePath || this.entryCount >= this.maxEntriesPerFile) {
        this.rotateFile();
      }
      fs.appendFileSync(this.currentFilePath!, json + '\n', 'utf-8');
      this.entryCount++;
      return true;
    } catch (error) {
      this.storageErrors++;
      this.lastError = String(error);
      return false;
    }
  }

  flush(): void {
    this.entryCount = 0;
    this.currentFilePath = null;
  }

  getCurrentFilePath(): string | null {
    return this.currentFilePath;
  }

  getEntryCount(): number {
    return this.entryCount;
  }

  getHealth(): { healthy: boolean; storageErrors: number; lastError: string | null } {
    return {
      healthy: this.storageErrors === 0,
      storageErrors: this.storageErrors,
      lastError: this.lastError,
    };
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.journalDir)) {
      fs.mkdirSync(this.journalDir, { recursive: true });
    }
  }

  private rotateFile(): void {
    const date = new Date().toISOString().slice(0, 10);
    const ts = Date.now();
    this.currentFilePath = path.join(this.journalDir, `${date}-${ts}.jsonl`);
    this.entryCount = 0;
  }

  private buildEntry(
    result: MicroBurstShadowEvaluationResult,
    provenance?: { codeCommitSha: string; configHash: string; cohortId: string },
  ): MicroBurstSignalJournalEntry {
    const diag = result.diagnostics ?? {};
    return {
      schemaVersion: 1,
      cohortId: provenance?.cohortId ?? 'UNOFFICIAL',
      strategyId: result.strategyId,
      strategyVersion: result.strategyVersion,
      codeCommitSha: provenance?.codeCommitSha ?? 'UNKNOWN',
      configHash: provenance?.configHash ?? 'UNKNOWN',
      shadowSignalId: result.shadowSignalId,
      symbol: result.symbol,
      side: result.side,
      snapshotAtMs: result.snapshotAtMs,
      observedAtMs: result.lastObservedAt,
      marketPrice: result.referencePrice,
      referencePriceSource:
        typeof diag.referencePriceSource === 'string' ? diag.referencePriceSource : 'UNKNOWN',
      support: result.supportPrice,
      resistance: result.resistancePrice,
      structuralStopPrice: result.structuralInvalidation,
      destinationPrice: result.destinationPrice,
      roomToTargetBps: result.roomToTargetBps,
      riskToInvalidationBps: result.riskToInvalidationBps,
      rewardRisk: result.rewardRisk,
      momentum: result.momentum,
      book: {
        status: result.book.status,
        ageMs: result.book.ageMs,
        imbalance: result.book.imbalance,
        imbalanceSlope: result.book.imbalanceSlope,
        temporalAbsorption:
          typeof diag.temporalAbsorptionDetected === 'boolean'
            ? diag.temporalAbsorptionDetected
            : false,
        temporalSweep:
          typeof diag.temporalSweepDetected === 'boolean' ? diag.temporalSweepDetected : false,
      },
      aggTrade: {
        buyTakerVolume: typeof diag.takerBuyVolume === 'number' ? diag.takerBuyVolume : 0,
        sellTakerVolume: typeof diag.takerSellVolume === 'number' ? diag.takerSellVolume : 0,
        netTakerFlow: typeof diag.takerNetFlow === 'number' ? diag.takerNetFlow : 0,
        sampleCount: typeof diag.takerFlowSampleCount === 'number' ? diag.takerFlowSampleCount : 0,
      },
      btc: {
        status: result.btc.status,
        ageMs: result.btc.ageMs,
        ret1m: result.btc.ret1m,
        ret3m: result.btc.ret3m,
        ret5m: result.btc.ret5m,
        acceleration: typeof diag.btcAcceleration === 'number' ? diag.btcAcceleration : null,
        direction: typeof diag.btcDirection === 'string' ? diag.btcDirection : null,
        conflict: result.btc.conflict,
      },
      decision: result.decision,
      confidence: result.confidence,
      leverageTier: typeof diag.leverageTier === 'string' ? diag.leverageTier : undefined,
      leverage: typeof diag.leverage === 'number' ? diag.leverage : undefined,
      positionFraction:
        typeof diag.positionFraction === 'number' ? diag.positionFraction : undefined,
      wouldEnter: result.wouldEnter,
      liveExecution: false as const,
      invalidReasons: result.dataQuality.invalidReasons,
    };
  }
}
