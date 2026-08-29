from pathlib import Path
import hashlib


def write(path: str, content: str) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)


def replace(path: str, old: str, new: str, required: bool = True) -> None:
    p = Path(path)
    text = p.read_text()
    if old not in text:
        if required:
            raise SystemExit(f"expected text not found in {path}: {old[:100]}")
        return
    p.write_text(text.replace(old, new))


write(
    "src/strategies/micro-burst/application/MicroBurstRuntimeTypes.ts",
    """export interface MicroBurstSymbolConfig {
  enabled: boolean;
  btcConflictThresholdBps?: number;
  bookDepthLevels?: number;
  bookDepthSpeed?: '100ms' | '250ms' | '500ms';
}

export interface MicroBurstRuntimeConfig {
  enabled: boolean;
  mode: 'OFF' | 'SHADOW' | 'LIVE';
  symbols: Record<string, MicroBurstSymbolConfig>;
  prospectiveValidation?: {
    enabled: boolean;
    cohortId?: string;
    horizonsMs?: number[];
    conservativeEntrySlippageBps?: number;
  };
  marketArchive?: {
    enabled: boolean;
    rootDir?: string;
    sqlitePath?: string;
    tradeRetentionMs?: number;
    bookCheckpointIntervalMs?: number;
    rawTradeArchive?: boolean;
    rawDepthArchive?: boolean;
    compression?: 'gzip';
    maxActiveSegmentRecords?: number;
    maxActiveSegmentBytes?: number;
    maxActiveSegmentDurationMs?: number;
    durabilityFlushIntervalMs?: number;
  };
}
""",
)

write(
    "src/strategies/micro-burst/application/MicroBurstShadowEvaluationTypes.ts",
    """import { Side } from '../../types';
import { BookDataStatus, BtcDataStatus } from '../domain/MicroBurstTypes';

export interface MicroBurstShadowEvaluationResult {
  strategyId: string;
  strategyVersion: string;
  symbol: string;
  snapshotAtMs: number;
  decision: 'NO_TRADE' | 'ENTRY_INTENT';
  side?: Side;
  confidence: number;
  referencePrice: number;
  supportPrice: number | null;
  resistancePrice: number | null;
  structuralInvalidation: number | null;
  destinationPrice: number | null;
  roomToTargetBps: number | null;
  riskToInvalidationBps: number | null;
  rewardRisk: number | null;
  momentum: {
    direction: Side | 'NEUTRAL';
    strength: number;
    continuationScore: number;
  };
  book: {
    status: BookDataStatus;
    ageMs: number | null;
    imbalance: number;
    imbalanceSlope: number | null;
  };
  btc: {
    status: BtcDataStatus;
    ageMs: number | null;
    ret1m: number | null;
    ret3m: number | null;
    ret5m: number | null;
    conflict: boolean;
  };
  microRegime: string;
  dataQuality: {
    contextValid: boolean;
    invalidReasons: string[];
  };
  wouldEnter: boolean;
  liveExecution: false;
  shadowSignalId: string;
  duplicateSuppressed: boolean;
  firstObservedAt: number;
  lastObservedAt: number;
  diagnostics: Record<string, unknown>;
}

export interface MicroBurstShadowTelemetryLog {
  strategyId: string;
  strategyVersion: string;
  symbol: string;
  snapshotAtMs: number;
  decision: 'NO_TRADE' | 'ENTRY_INTENT';
  side?: Side;
  confidence: number;
  referencePrice: number;
  support: number | null;
  resistance: number | null;
  structuralInvalidation: number | null;
  target: number | null;
  roomToTargetBps: number | null;
  riskToInvalidationBps: number | null;
  rewardRisk: number | null;
  momentum: {
    direction: Side | 'NEUTRAL';
    strength: number;
    continuationScore: number;
  };
  bookStatus: BookDataStatus;
  bookAgeMs: number | null;
  bookImbalance: number;
  imbalanceSlope: number | null;
  btcStatus: BtcDataStatus;
  btcAgeMs: number | null;
  btcRet1m: number | null;
  btcRet3m: number | null;
  btcRet5m: number | null;
  btcConflict: boolean;
  microRegime: string;
  dataQualityContextValid: boolean;
  invalidReasons: string[];
  wouldEnter: boolean;
  liveExecution: false;
  shadowSignalId: string;
  duplicateSuppressed: boolean;
  firstObservedAt: number;
  lastObservedAt: number;
}
""",
)

write(
    "src/strategies/micro-burst/domain/MicroBurstBtcTypes.ts",
    """import { Side } from '../../types';

export interface BtcCandleObservation {
  close: number;
  closeTime: number;
  openTime: number;
}

export interface BtcReturnSet {
  ret1m: number;
  ret3m: number;
  ret5m: number;
  acceleration: number;
  direction: Side | 'NEUTRAL';
  observedAtMs: number;
}
""",
)

replace(
    "src/strategies/micro-burst/application/MicroBurstConfigLoader.ts",
    "import { MicroBurstRuntimeConfig, MicroBurstSymbolConfig } from '../domain/MicroBurstMarketDataTypes';",
    "import { MicroBurstRuntimeConfig, MicroBurstSymbolConfig } from './MicroBurstRuntimeTypes';",
)
replace(
    "src/strategies/micro-burst/application/MicroBurstShadowEvaluator.ts",
    """import {
  MicroBurstShadowEvaluationResult,
  MicroBurstShadowTelemetryLog,
  MicroBurstSymbolConfig,
  MicroBurstRuntimeConfig,
} from '../domain/MicroBurstMarketDataTypes';""",
    """import { MicroBurstRuntimeConfig, MicroBurstSymbolConfig } from './MicroBurstRuntimeTypes';
import {
  MicroBurstShadowEvaluationResult,
  MicroBurstShadowTelemetryLog,
} from './MicroBurstShadowEvaluationTypes';""",
)
replace(
    "src/strategies/micro-burst/domain/MicroBurstRuntime.ts",
    """import {
  MicroBurstRuntimeConfig,
  MicroBurstShadowEvaluationResult,
  AggTradeEvent,
  SynchronizedOrderBookState,
} from './MicroBurstMarketDataTypes';""",
    """import type { MicroBurstRuntimeConfig } from '../application/MicroBurstRuntimeTypes';
import type { MicroBurstShadowEvaluationResult } from '../application/MicroBurstShadowEvaluationTypes';
import type {
  AggTradeEvent,
  OrderBookState as SynchronizedOrderBookState,
} from '../../../app/ports/MarketData';""",
)

replace(
    "src/strategies/micro-burst/research/MicroBurstSignalJournal.ts",
    "import { MicroBurstShadowEvaluationResult } from '../domain/MicroBurstMarketDataTypes';",
    "import type { MicroBurstShadowEvaluationResult } from '../application/MicroBurstShadowEvaluationTypes';",
)
replace(
    "src/strategies/micro-burst/research/MicroBurstPaperTrading.ts",
    "import { MicroBurstShadowEvaluationResult } from '../domain/MicroBurstMarketDataTypes';",
    "import type { MicroBurstShadowEvaluationResult } from '../application/MicroBurstShadowEvaluationTypes';",
)

replace(
    "src/strategies/micro-burst/domain/BtcMicroContextProvider.ts",
    "import { BtcCandleObservation, BtcReturnSet } from './MicroBurstMarketDataTypes';",
    "import type { BtcCandleObservation, BtcReturnSet } from './MicroBurstBtcTypes';",
)
replace(
    "src/strategies/micro-burst/domain/BtcMicroContextProvider.test.ts",
    "import { BtcCandleObservation } from './MicroBurstMarketDataTypes';",
    "import type { BtcCandleObservation } from './MicroBurstBtcTypes';",
)

ref = Path("src/strategies/micro-burst/domain/MicroBurstReferencePrice.ts")
text = ref.read_text().replace(
    "import { MicroBurstReferencePrice, ReferencePriceSource } from './MicroBurstMarketDataTypes';\n",
    "",
)
marker = "const STALE_THRESHOLD_MS = 5_000;\n"
declarations = """export type ReferencePriceSource = 'MARK_PRICE' | 'MIDPOINT' | 'BEST_BID_ASK';

export interface MicroBurstReferencePrice {
  price: number;
  source: ReferencePriceSource;
  observedAtMs: number;
  isLiveRuntime: boolean;
}

"""
if marker not in text:
    raise SystemExit("reference-price marker missing")
ref.write_text(text.replace(marker, declarations + marker, 1))
replace(
    "src/strategies/micro-burst/domain/MicroBurstContextBuilder.ts",
    "import { MicroBurstReferencePrice } from './MicroBurstMarketDataTypes';",
    "import type { MicroBurstReferencePrice } from './MicroBurstReferencePrice';",
)

for filename in [
    "src/strategies/micro-burst/domain/MicroBurstBookPressureAnalyzer.ts",
    "src/strategies/micro-burst/domain/MicroBurstBookPressureAnalyzer.test.ts",
    "src/strategies/micro-burst/domain/SynchronizedOrderBook.ts",
]:
    replace(
        filename,
        "import { TemporalBookSnapshot } from './MicroBurstMarketDataTypes';",
        "import type { TemporalOrderBookObservation as TemporalBookSnapshot } from '../../../app/ports/MarketData';",
        required=False,
    )
    replace(
        filename,
        "import type { TemporalBookSnapshot } from './MicroBurstMarketDataTypes';",
        "import type { TemporalOrderBookObservation as TemporalBookSnapshot } from '../../../app/ports/MarketData';",
        required=False,
    )
replace(
    "src/strategies/micro-burst/domain/MicroBurstTypes.ts",
    "import('./MicroBurstMarketDataTypes').TemporalBookSnapshot[]",
    "import('../../../app/ports/MarketData').TemporalOrderBookObservation[]",
)

sync_test = Path("src/strategies/micro-burst/domain/SynchronizedOrderBook.test.ts")
text = sync_test.read_text()
old = """import {
  BinanceDepthDiffEvent,
  BinanceDepthSnapshot,
  SYNCHRONIZED_ORDER_BOOK_SNAPSHOT_DEPTH,
} from './MicroBurstMarketDataTypes';"""
new = """import {
  type BinanceDepthDiffEvent,
  type BinanceDepthSnapshot,
  ORDER_BOOK_SNAPSHOT_DEPTH,
} from '../../../app/ports/MarketData';"""
if old not in text:
    raise SystemExit("SynchronizedOrderBook test import block missing")
sync_test.write_text(text.replace(old, new).replace("SYNCHRONIZED_ORDER_BOOK_SNAPSHOT_DEPTH", "ORDER_BOOK_SNAPSHOT_DEPTH"))
replace(
    "src/strategies/micro-burst/domain/MicroBurstAggTradeBuffer.test.ts",
    "import { AggTradeEvent } from './MicroBurstMarketDataTypes';",
    "import type { AggTradeEvent } from '../../../app/ports/MarketData';",
)

test_replacements = {
    "src/strategies/micro-burst/domain/MicroBurstSignalJournal.test.ts": (
        "import { MicroBurstShadowEvaluationResult } from './MicroBurstMarketDataTypes';",
        "import type { MicroBurstShadowEvaluationResult } from '../application/MicroBurstShadowEvaluationTypes';",
    ),
    "src/strategies/micro-burst/domain/MicroBurstGoldenParity.test.ts": (
        "import { MicroBurstShadowEvaluationResult } from './MicroBurstMarketDataTypes';",
        "import type { MicroBurstShadowEvaluationResult } from '../application/MicroBurstShadowEvaluationTypes';",
    ),
    "src/strategies/micro-burst/domain/MicroBurstPaperTrading.test.ts": (
        "import { MicroBurstShadowEvaluationResult } from './MicroBurstMarketDataTypes';",
        "import type { MicroBurstShadowEvaluationResult } from '../application/MicroBurstShadowEvaluationTypes';",
    ),
    "src/strategies/micro-burst/domain/MicroBurstRuntime.test.ts": (
        "import { MicroBurstRuntimeConfig } from './MicroBurstMarketDataTypes';",
        "import type { MicroBurstRuntimeConfig } from '../application/MicroBurstRuntimeTypes';",
    ),
    "src/strategies/micro-burst/domain/MicroBurstShadowEvaluator.test.ts": (
        "import { MicroBurstRuntimeConfig } from './MicroBurstMarketDataTypes';",
        "import type { MicroBurstRuntimeConfig } from '../application/MicroBurstRuntimeTypes';",
    ),
}
for filename, (old, new) in test_replacements.items():
    replace(filename, old, new)

replace(
    "src/infra/adapters/BinanceAdapter.ts",
    """import {
  BinanceDepthDiffEvent,
  BinanceDepthSnapshot,
} from '../../domain/strategies/micro-burst/MicroBurstMarketDataTypes';""",
    "import type { BinanceDepthDiffEvent, BinanceDepthSnapshot } from '../../app/ports/MarketData';",
)
replace(
    "src/infra/config/ConfigLoader.ts",
    "import { MicroBurstRuntimeConfig } from '../../domain/strategies/micro-burst/MicroBurstMarketDataTypes';",
    "import type { MicroBurstRuntimeConfig } from '../../strategies/micro-burst/application/MicroBurstRuntimeTypes';",
)
replace(
    "src/app/services/TradingService.aegis.test.ts",
    "import { MicroBurstRuntimeConfig } from '../../domain/strategies/micro-burst/MicroBurstMarketDataTypes';",
    "import type { MicroBurstRuntimeConfig } from '../../strategies/micro-burst/application/MicroBurstRuntimeTypes';",
)

for filename in [
    "src/strategies/micro-burst/domain/MicroBurstMarketDataTypes.ts",
    "src/domain/strategies/micro-burst/MicroBurstMarketDataTypes.ts",
]:
    p = Path(filename)
    if p.exists():
        p.unlink()

restoration = Path("src/restoration/original-operational-semantics.test.ts")
rtext = restoration.read_text()
contracts = [
    (
        "src/infra/config/ConfigLoader.ts",
        "070a3a6a02c80107453e8cf7189d5f1b7f5475ab79658ecf0d00b913be9f0e80",
    ),
    (
        "src/infra/adapters/BinanceAdapter.ts",
        "fb65e620128378df5932f43e76bd1cac2983020c5bd0f474b0043fead1478592",
    ),
]
for filename, old_digest in contracts:
    digest = hashlib.sha256(Path(filename).read_bytes()).hexdigest()
    if old_digest not in rtext:
        raise SystemExit(f"expected restoration digest missing for {filename}")
    rtext = rtext.replace(old_digest, digest, 1)
    print(f"{filename} canonical type import digest: {digest}")
restoration.write_text(rtext)
