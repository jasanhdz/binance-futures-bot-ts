from pathlib import Path

p = Path('src/app/services/TradingService.ts')
t = p.read_text()

# Imports: keep readiness type, replace runtime/storage/bootstrap imports with coordinator.
t = t.replace("import { createReadOnlyAuditedExchange } from '../../infra/adapters/ReadOnlyAuditedExchange';\n", "")
t = t.replace("import {\n  MicroBurstRuntime,\n  MicroBurstRuntimeReadiness,\n} from '../../strategies/micro-burst/application/MicroBurstRuntime';", "import type { MicroBurstRuntimeReadiness } from '../../strategies/micro-burst/application/MicroBurstRuntime';\nimport { MicroBurstRuntimeCoordinator } from '../../strategies/micro-burst/application/MicroBurstRuntimeCoordinator';")
t = t.replace("import { MicroBurstOutcomeJournal } from '../../strategies/micro-burst/research/MicroBurstOutcomeJournal';\n", "")
t = t.replace("import { MicroBurstOutcomeTracker } from '../../strategies/micro-burst/research/MicroBurstOutcomeTracker';\n", "")
t = t.replace("import { MicroBurstStorage } from '../../strategies/micro-burst/research/MicroBurstStorage';\n", "")

# Fields.
t = t.replace("  private microBurstRuntime: MicroBurstRuntime | null = null;\n", "  private microBurstRuntimeCoordinator: MicroBurstRuntimeCoordinator | null = null;\n")

# Replace Micro Burst bootstrap block.
start = t.find("    if (mbConfig.enabled && mbConfig.mode !== 'OFF') {\n      try {\n        const provenance = this.getMicroBurstProvenance(mbConfig);")
end = t.find("\n    this.hardWatchdogTimer = setInterval(() => {", start)
if start < 0 or end < 0:
    raise SystemExit('Micro Burst bootstrap block anchors missing')
replacement = '''    if (mbConfig.enabled && mbConfig.mode !== 'OFF') {
      const provenance = this.getMicroBurstProvenance(mbConfig);
      this.microBurstRuntimeCoordinator = new MicroBurstRuntimeCoordinator({
        exchange: this.deps.exchange,
        logger: this.deps.logger,
        sharedMarketData: this.sharedMarketDataRuntime,
        strategyRouter: this.microBurstStrategyRouter,
        decisionSink: this.decisionEvidenceSink,
        marketSnapshotSink: this.marketSnapshotEvidenceSink,
        provenance,
      });
      this.microBurstReadiness = await this.microBurstRuntimeCoordinator.start(mbConfig);
    }
'''
t = t[:start] + replacement + t[end:]

# Replace stop ownership.
t = t.replace("    const microBurstRuntime = this.microBurstRuntime;\n    this.microBurstRuntime = null;\n", "    const microBurstRuntimeCoordinator = this.microBurstRuntimeCoordinator;\n    this.microBurstRuntimeCoordinator = null;\n")
t = t.replace("      await microBurstRuntime?.stop();", "      await microBurstRuntimeCoordinator?.stop();")

p.write_text(t)
